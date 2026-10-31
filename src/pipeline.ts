/**
 * Omni-Fixer 流水线总编排：omni_scan → omni_isolate → omni_heal ⇄ omni_verify → omni_reporter。
 *
 * 闭环语义（任务书铁律）：
 *   - 模型/规则引擎的输出绝不直接落盘；先过物理闸门（sandbox / 原地+无条件恢复）。
 *   - 闸门失败 → 带新报错证据退回，通道按 rule-engine → weak → strong 升级，最多 maxRetries 轮。
 *   - 全部失败 = 什么都不改（原地策略有 finally 恢复，沙盒策略根本没碰源码）。
 *
 * 大项目策略：契约互相独立、串行执行（同一文件可能有多份契约，后看到的总是最新内容）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  Complexity,
  ContractResult,
  Diagnostic,
  FixChannel,
  FixContract,
  ModelUsage,
  PipelineDeps,
  RescanSummary,
  RunStats,
  ScanResult,
  SpawnFn,
  VerifyStrategy,
} from './core/types.js'
import { hashId, now, readText } from './core/util.js'
import { scanProject, type ScanOptions } from './scan/index.js'
import { analyzeJs } from './scan/ast-js.js'
import { analyzePy } from './scan/ast-py.js'
import { buildContracts } from './isolate/contract.js'
import { channelToModel, resolveModelNames, routeContract, type ModelNames } from './heal/router.js'
import { healContract, toFixAttempt, type HealDeps } from './heal/healer.js'
import type { LlmConfig } from './heal/llm.js'
import { verifyCandidate } from './verify/sandbox.js'
import { REPORT_DIR_NAME, renderConsoleSummary, writeReport } from './reporter.js'

export interface PipelineConfig {
  /** 契约上下文窗口（± 行数）。默认 50。 */
  contextLines: number
  /** 每份契约的重试上限（含通道升级）。默认 3。 */
  maxRetries: number
  /** 整文件替换的行数阈值，超出走窗口替换。默认 400。 */
  maxFullFileLines: number
  /** 窗口替换允许的行数漂移。默认 3。 */
  allowedDrift: number
  /** 验证策略。 */
  verifyStrategy: VerifyStrategy
  /** Dry run：验证但不落盘。 */
  dryRun: boolean
  /** 最多处理的契约数（0 = 不限）。 */
  maxContracts: number
  include?: string[]
  exclude?: string[]
  /** 是否启用工具链扫描。 */
  scanToolchain: boolean
  /** 逐文件兜底检查的文件上限。 */
  maxFileToolchainChecks: number
  models?: Partial<ModelNames>
  llm: LlmConfig
  /** 战报输出目录；默认 <root>/.omni-fix-report，null = 只返回不落盘。 */
  reportDir?: string | null
  /** 契约过滤器（omni_heal 工具按 file / contractId 过滤用）。 */
  contractFilter?: (contract: FixContract) => boolean
}

export const DEFAULT_CONFIG: PipelineConfig = {
  contextLines: 50,
  maxRetries: 3,
  maxFullFileLines: 400,
  allowedDrift: 3,
  verifyStrategy: 'auto',
  dryRun: false,
  maxContracts: 0,
  scanToolchain: true,
  maxFileToolchainChecks: 1500,
  llm: {},
}

export interface RunResult {
  stats: RunStats
  reportPaths?: { dir: string; jsonPath: string; mdPath: string; latestPath: string }
}

export async function runPipeline(
  root: string,
  configOverrides: Partial<PipelineConfig>,
  deps: PipelineDeps = {},
): Promise<RunResult> {
  const config: PipelineConfig = { ...DEFAULT_CONFIG, ...configOverrides }
  const spawn: SpawnFn = deps.spawn ?? (await import('./core/proc.js')).nodeSpawnFn()
  const t0 = Date.now()
  const runId = hashId([root, String(t0)])
  const notes: string[] = []
  const onProgress = deps.onProgress

  // ---- 1. omni_scan ----
  const scanOpts: ScanOptions = {
    spawn,
    include: config.include,
    exclude: config.exclude,
    useToolchain: config.scanToolchain,
    maxFileToolchainChecks: config.maxFileToolchainChecks,
    signal: deps.signal,
    onProgress,
  }
  const scan = await scanProject(root, scanOpts)
  onProgress?.(`omni_scan: ${scan.diagnostics.length} 条诊断 / ${scan.filesScanned} 文件`)

  // ---- 2. omni_isolate ----
  const contracts = await buildContracts(scan, {
    contextLines: config.contextLines,
    gapThreshold: 8,
    maxFullFileLines: config.maxFullFileLines,
    allowedDrift: config.allowedDrift,
  })
  const limited = config.maxContracts > 0 ? contracts.slice(0, config.maxContracts) : contracts
  const filtered = config.contractFilter ? limited.filter(config.contractFilter) : limited
  onProgress?.(`omni_isolate: ${contracts.length} 份契约（处理 ${filtered.length}）`)

  const modelNames = resolveModelNames(config.models)
  const healDeps: HealDeps = {
    llm: config.llm,
    models: config.models,
    allowedDrift: config.allowedDrift,
    maxFullFileLines: config.maxFullFileLines,
  }

  // ---- 3+4. omni_heal ⇄ omni_verify ----
  const results: ContractResult[] = []
  const tokensByModel: Record<string, ModelUsage> = {}
  let attemptsCount = 0
  let modelCalls = 0
  let rulesFired = 0

  for (let ci = 0; ci < filtered.length; ci++) {
    const contract = filtered[ci]!
    if (deps.signal?.aborted) {
      notes.push('流水线被取消')
      break
    }
    const content = await readText(contract.absolutePath)
    if (content === null) {
      results.push({
        contractId: contract.id,
        file: contract.file,
        status: 'skipped',
        attempts: [],
        finalError: '无法读取文件内容',
      })
      continue
    }

    onProgress?.(`omni_heal [${ci + 1}/${filtered.length}] ${contract.file} (${contract.complexity})`)

    const result: ContractResult = {
      contractId: contract.id,
      file: contract.file,
      status: 'failed',
      attempts: [],
    }
    let channel: FixChannel | null = routeContract(contract.complexity, contract)
    let feedback: string | undefined
    let lastFailure = ''

    for (let round = 1; round <= config.maxRetries; round++) {
      if (!channel) break
      const attemptInput = { contract, content, channel, round, feedback }
      const out = await healContract(attemptInput, healDeps)
      const attempt = toFixAttempt(attemptInput, out)
      result.attempts.push(attempt)
      attemptsCount++
      if (out.usage) {
        modelCalls++
        bumpUsage(tokensByModel, out.model, out.usage)
      } else if (channel !== 'rule-engine' && out.isError) {
        // 失败的模型调用没有 usage，但战绩表必须如实记账（calls++，token 记 0）
        modelCalls++
        bumpUsage(tokensByModel, out.model, { prompt: 0, completion: 0 })
      }

      if (out.isError || out.patch === null) {
        lastFailure = out.note
        feedback = `修复通道 ${out.model} 未产出可用补丁：${out.note}${out.raw ? `\n模型输出（尾部）:\n${out.raw.slice(-600)}` : ''}`
        channel = escalate(channel, contract.complexity)
        continue
      }

      const verifyResult = await verifyCandidate(contract, out.patch, {
        spawn,
        strategy: config.verifyStrategy,
        signal: deps.signal,
      })
      attempt.verifyExitCode = verifyResult.exitCode
      attempt.verifyOutput = verifyResult.output
      attempt.ok = verifyResult.ok
      if (!verifyResult.ok) {
        lastFailure = verifyResult.failureReason
        feedback = `你的补丁在物理沙盒中【验证失败】（验证器 ${verifyResult.specKind}/${verifyResult.method}）。\n${verifyResult.failureReason}\n请基于原窗口修正，不要扩大修改范围。`
        channel = escalate(channel, contract.complexity)
        continue
      }

      // 验证通过：落盘（dryRun 除外）
      result.status = config.dryRun ? 'dry-run' : 'applied'
      result.appliedVia = channel
      result.appliedModel = channelToModel(channel, modelNames)
      if (channel === 'rule-engine') rulesFired++
      if (!config.dryRun) {
        await atomicWrite(contract.absolutePath, out.patch)
      }
      break
    }

    if (result.status === 'failed') {
      result.finalError = lastFailure || `${config.maxRetries} 轮重试均未通过验证`
    }
    results.push(result)
    onProgress?.(
      `omni_verify: ${result.file} → ${result.status}${result.appliedVia ? ` via ${result.appliedVia}` : ''}`,
    )
  }

  // ---- 5. 复扫 ----
  const touchedFiles = [...new Set(results.filter((r) => r.status === 'applied').map((r) => r.file))]
  const rescan: RescanSummary | undefined =
    touchedFiles.length > 0 ? await rescanProject(root, scan, touchedFiles) : undefined

  // ---- 6. omni_reporter ----
  const stats: RunStats = {
    runId,
    root,
    startedAt: new Date(t0).toISOString(),
    finishedAt: now(),
    durationMs: Date.now() - t0,
    dryRun: config.dryRun,
    scan: {
      filesScanned: scan.filesScanned,
      linesScanned: scan.linesScanned,
      diagnosticsFound: scan.diagnostics.filter((d) => d.severity === 'error').length,
      bySource: scan.bySource,
      byKind: scan.byKind,
    },
    contracts: {
      total: contracts.length,
      byComplexity: countBy(contracts, (c) => c.complexity),
    },
    attempts: attemptsCount,
    rulesFired,
    modelCalls,
    results,
    rescan,
    tokens: {
      prompt: sumUsage(tokensByModel, (u) => u.prompt),
      completion: sumUsage(tokensByModel, (u) => u.completion),
      byModel: tokensByModel,
    },
    notes: [...notes, ...scan.toolchainNotes],
  }

  let reportPaths: RunResult['reportPaths']
  const reportDir = config.reportDir === undefined ? path.join(root, REPORT_DIR_NAME) : config.reportDir
  if (reportDir) {
    reportPaths = await writeReport(stats, reportDir)
  }
  onProgress?.(renderConsoleSummary(stats))
  return { stats, reportPaths }
}

function bumpUsage(
  store: Record<string, ModelUsage>,
  model: string,
  usage: { prompt: number; completion: number },
): void {
  const cur = store[model] ?? { prompt: 0, completion: 0, calls: 0 }
  cur.prompt += usage.prompt
  cur.completion += usage.completion
  cur.calls += 1
  store[model] = cur
}

function sumUsage(store: Record<string, ModelUsage>, pick: (u: ModelUsage) => number): number {
  return Object.values(store).reduce((sum, u) => sum + pick(u), 0)
}

/** 通道升级阶梯：rule-engine → （按复杂度）weak/strong → strong → 放弃。 */
function escalate(from: FixChannel, complexity: Complexity): FixChannel | null {
  if (from === 'rule-engine') return complexity === 'trivial' ? 'weak-model' : 'strong-model'
  if (from === 'weak-model') return 'strong-model'
  return null
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1
  return out
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.~omni-fix`
  await fs.promises.writeFile(tmp, content, 'utf8')
  await fs.promises.rename(tmp, absPath)
}

/** 复扫：被改过的文件做 AST 复检，对比修复前后的错误数。 */
async function rescanProject(
  root: string,
  scan: ScanResult,
  touchedFiles: string[],
): Promise<RescanSummary> {
  const after: Diagnostic[] = []
  for (const rel of touchedFiles) {
    const abs = path.join(root, rel)
    const text = await safeRead(abs)
    if (text === '') continue
    const diags =
      detectLangOf(abs) === 'py' ? analyzePy(text, rel).diagnostics : analyzeJs(text, rel).diagnostics
    after.push(...diags)
  }
  const beforeIds = new Set(
    scan.diagnostics
      .filter((d) => d.severity === 'error' && touchedFiles.includes(d.file))
      .map((d) => d.id),
  )
  const afterIds = new Set(after.map((d) => d.id))
  const healed = [...beforeIds].filter((id) => !afterIds.has(id)).length
  return {
    before: beforeIds.size,
    after: after.length,
    healed,
    remaining: after,
  }
}

function detectLangOf(abs: string): 'py' | 'js' {
  return path.extname(abs) === '.py' ? 'py' : 'js'
}

async function safeRead(abs: string): Promise<string> {
  try {
    return (await readText(abs)) ?? ''
  } catch {
    return ''
  }
}
