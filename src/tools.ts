/**
 * Omni-Fixer 工具层：把核心流水线暴露成 6 个 DSH 工具。
 *
 * 工具契约红线（dsh-plugin-guide）：
 *  - execute 绝不 throw：意外异常收敛成结构化失败结果。
 *  - execute 只返回 output.schema 声明的规范 JSON（{ type: 'json' }）。
 *  - 人类可读内容放 output.render（纯函数）。
 *  - 尊重 exec.signal：取消即停。
 *
 * 六件套 = 五级模块各一个入口 + 一条全自动总闸：
 *   omni_scan / omni_isolate / omni_heal / omni_verify / omni_report + omni_fix（总流水线）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { defineTool, type RenderedContent, type ToolDefinition, type ToolExec } from '@deepseek-ai/dsh-tools'
import type { ConfigType } from './config.js'
import { resolvePluginConfig } from './config.js'
import { resolveSpawnFn } from './core/proc.js'
import type { SpawnFn } from './core/types.js'
import { scanProject } from './scan/index.js'
import { buildContracts } from './isolate/contract.js'
import { runPipeline, DEFAULT_CONFIG, type PipelineConfig } from './pipeline.js'
import { buildVerifySpec, runVerifySpec } from './scan/toolchain.js'
import { REPORT_DIR_NAME, renderReport } from './reporter.js'
import { detectLanguage, pathExists } from './core/util.js'

export interface ToolDeps {
  /** 宿主 ctx.subprocess.spawn（可选；缺席走 child_process）。 */
  hostSpawn?: unknown
  /** 宿主 logger（进度落日志用）。 */
  log?: (message: string) => void
}

const MAX_DIAGNOSTICS_IN_OUTPUT = 100
const MAX_CONTRACTS_IN_OUTPUT = 50

/** 统一的工具结果：ok / 失败原因 / 数据。 */
interface ToolOk<T> {
  ok: true
  data: T
}
interface ToolFail {
  ok: false
  error: {
    kind: string
    message: string
  }
}
type ToolResult<T> = ToolOk<T> | ToolFail

function ok<T>(data: T): ToolOk<T> {
  return { ok: true, data }
}
function fail(kind: string, message: string): ToolFail {
  return { ok: false, error: { kind, message } }
}

function resolveRoot(root: string | undefined): string {
  const candidate = (root ?? '').trim() !== '' ? root! : process.cwd()
  return path.resolve(candidate)
}

function toPipelineConfig(plugin: ConfigType, args: Record<string, unknown>): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    contextLines: numOr(args.contextLines, plugin.contextLines),
    maxRetries: numOr(args.maxRetries, plugin.maxRetries),
    maxFullFileLines: plugin.maxFullFileLines,
    allowedDrift: plugin.allowedDrift,
    verifyStrategy: strOr(args.verifyStrategy, plugin.verifyStrategy) as PipelineConfig['verifyStrategy'],
    dryRun: bolOr(args.dryRun, plugin.dryRun),
    maxContracts: numOr(args.maxContracts, plugin.maxContracts),
    include: plugin.include,
    exclude: plugin.exclude,
    scanToolchain: bolOr(args.scanToolchain, plugin.scanToolchain),
    maxFileToolchainChecks: plugin.maxFileToolchainChecks,
    reportDir: plugin.reportDir === '' ? undefined : plugin.reportDir,
    llm: plugin.llm,
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v !== '' ? v : fallback
}
function bolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function makeSpawn(deps: ToolDeps, exec: ToolExec): SpawnFn {
  const fn = resolveSpawnFn(
    deps.hostSpawn as ((spec: unknown) => unknown) | undefined,
  )
  return (spec) => fn({ ...spec, signal: spec.signal ?? exec.signal })
}

function renderText(value: unknown): RenderedContent[] {
  return [{ type: 'text', text: pretty(value) }]
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** 顶层 catch 兜底：execute 绝不 throw（契约承载条件）。 */
function guard<T>(fn: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  return fn().catch((err) => fail('internal', (err as Error)?.message ?? String(err)))
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. omni_scan —— 全量错误嗅探
// ─────────────────────────────────────────────────────────────────────────────

const SCAN_DESCRIPTION = [
  'Sniffs a project for errors: zero-dependency AST scanners (JS/TS/JSX/TSX/MJS/CJS/Python) plus authoritative toolchain runs (tsc --noEmit, vitest, pytest, node --test, node --check, py_compile).',
  'Use as the first step of a repair session, or standalone to snapshot how broken a codebase is before touching anything.',
  'Read-only: never modifies files. Returns diagnostics (id/file/line/column/source/rule/message), scan totals and skipped files.',
].join('\n')

function createScanTool(plugin: ConfigType, deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'omni_scan',
    description: SCAN_DESCRIPTION,
    parameters: {
      root: {
        type: 'string',
        description: 'Project root directory; omit for the current working directory.',
      },
      useToolchain: {
        type: 'boolean',
        description: 'Also run authoritative toolchain scans (tsc/vitest/pytest). Default: true.',
      },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra include globs (empty = scan everything).',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra exclude globs (stacked on the built-in ignore list).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ToolExec) {
      return guard(async () => {
        const root = resolveRoot(args.root as string | undefined)
        if (!(await pathExists(root))) return fail('not-found', `project root does not exist: ${root}`)
        const scan = await scanProject(root, {
          spawn: makeSpawn(deps, exec),
          include: plugin.include.length ? plugin.include : undefined,
          exclude: plugin.exclude,
          useToolchain: bolOr(args.useToolchain, plugin.scanToolchain),
          maxFiles: plugin.maxFiles,
          maxFileToolchainChecks: plugin.maxFileToolchainChecks,
          signal: exec.signal,
          onProgress: deps.log,
        })
        return ok({
          root,
          filesScanned: scan.filesScanned,
          linesScanned: scan.linesScanned,
          diagnosticCount: scan.diagnostics.length,
          errorCount: scan.diagnostics.filter((d) => d.severity === 'error').length,
          diagnostics: scan.diagnostics.slice(0, MAX_DIAGNOSTICS_IN_OUTPUT).map((d) => ({
            id: d.id,
            file: d.file,
            line: d.line,
            column: d.column,
            severity: d.severity,
            source: d.source,
            rule: d.rule,
            message: d.message,
            test: d.test,
          })),
          bySource: scan.bySource,
          byKind: scan.byKind,
          skippedCount: scan.skipped.length,
          notes: scan.toolchainNotes,
        })
      })
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. omni_isolate —— 外科手术级隔离（生成错误修复契约）
// ─────────────────────────────────────────────────────────────────────────────

const ISOLATE_DESCRIPTION = [
  'Runs omni_scan then groups diagnostics into Error Fix Contracts: self-contained code windows (±contextLines around each error cluster) that tell a model exactly which lines to look at and which errors to fix — nothing else.',
  'Use to preview the repair plan and cost before spending model tokens; hard contracts (test failures) are routed to strong models, syntax errors to the rule engine or weak models.',
  'Read-only. Returns contracts (id/file/window/complexity/errorText) sorted trivial → moderate → hard.',
].join('\n')

function createIsolateTool(plugin: ConfigType, deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'omni_isolate',
    description: ISOLATE_DESCRIPTION,
    parameters: {
      root: { type: 'string', description: 'Project root directory; omit for cwd.' },
      contextLines: {
        type: 'integer',
        description: 'Context window radius in lines around each error cluster (default 50).',
      },
      useToolchain: {
        type: 'boolean',
        description: 'Also run authoritative toolchain scans (default true).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ToolExec) {
      return guard(async () => {
        const root = resolveRoot(args.root as string | undefined)
        if (!(await pathExists(root))) return fail('not-found', `project root does not exist: ${root}`)
        const scan = await scanProject(root, {
          spawn: makeSpawn(deps, exec),
          useToolchain: bolOr(args.useToolchain, plugin.scanToolchain),
          maxFiles: plugin.maxFiles,
          maxFileToolchainChecks: plugin.maxFileToolchainChecks,
          signal: exec.signal,
          onProgress: deps.log,
        })
        const contracts = await buildContracts(scan, {
          contextLines: numOr(args.contextLines, plugin.contextLines),
          gapThreshold: 8,
          maxFullFileLines: plugin.maxFullFileLines,
          allowedDrift: plugin.allowedDrift,
        })
        return ok({
          root,
          scan: {
            filesScanned: scan.filesScanned,
            linesScanned: scan.linesScanned,
            diagnosticsFound: scan.diagnostics.length,
          },
          contractCount: contracts.length,
          contracts: contracts.slice(0, MAX_CONTRACTS_IN_OUTPUT).map((c) => ({
            id: c.id,
            file: c.file,
            language: c.language,
            window: `${c.startLine}-${c.endLine}`,
            complexity: c.complexity,
            errorCount: c.diagnosticIds.length,
            errorText: c.errorText.slice(0, 400),
            verify: c.verify.kind,
            totalLines: c.totalLines,
          })),
        })
      })
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. omni_fix —— 全自动总闸（scan → isolate → heal ⇄ verify → report）
// ─────────────────────────────────────────────────────────────────────────────

const FIX_DESCRIPTION = [
  'One-shot full repair pipeline: omni_scan → omni_isolate → omni_heal ⇄ omni_verify → omni_report.',
  'Use to fix a broken project end-to-end. Each contract is repaired only after its patch passes a physical gate (sandbox copy or in-place + unconditional restore); failures escalate rule-engine → weak model → strong model with fresh verifier output as feedback, up to maxRetries rounds.',
  'Modifies source files (unless dryRun) and writes a battle report to <root>/.omni-fix-report. Respects exec.signal for cancellation.',
].join('\n')

function createFixTool(plugin: ConfigType, deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'omni_fix',
    description: FIX_DESCRIPTION,
    parameters: {
      root: { type: 'string', description: 'Project root directory; omit for cwd.' },
      dryRun: { type: 'boolean', description: 'Run everything but write nothing (default false).' },
      maxContracts: { type: 'integer', description: 'Cap contracts handled this run (0 = no cap).' },
      verifyStrategy: {
        type: 'string',
        enum: ['auto', 'sandbox', 'inplace'],
        description: 'Verification gate strategy (default auto).',
      },
      scanToolchain: { type: 'boolean', description: 'Run toolchain scans (default true).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    timeoutMs: 1_800_000,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExec) {
      return guard(async () => {
        const root = resolveRoot(args.root as string | undefined)
        if (!(await pathExists(root))) return fail('not-found', `project root does not exist: ${root}`)
        const config = toPipelineConfig(plugin, args)
        const { stats, reportPaths } = await runPipeline(
          root,
          { ...config, scanToolchain: bolOr(args.scanToolchain, config.scanToolchain) },
          {
            spawn: makeSpawn(deps, exec),
            signal: exec.signal,
            onProgress: deps.log,
          },
        )
        return ok({
          runId: stats.runId,
          root,
          dryRun: stats.dryRun,
          scan: stats.scan,
          contracts: stats.contracts,
          attempts: stats.attempts,
          rulesFired: stats.rulesFired,
          modelCalls: stats.modelCalls,
          tokens: stats.tokens,
          applied: stats.results.filter((r) => r.status === 'applied').length,
          failed: stats.results.filter((r) => r.status === 'failed').length,
          skipped: stats.results.filter((r) => r.status === 'skipped').length,
          rescan: stats.rescan ? { before: stats.rescan.before, after: stats.rescan.after, healed: stats.rescan.healed } : undefined,
          report: reportPaths
            ? { dir: reportPaths.dir, markdown: reportPaths.mdPath, json: reportPaths.jsonPath }
            : undefined,
          notes: stats.notes,
        })
      })
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. omni_heal —— 定点修复（按 file / contractId 过滤）
// ─────────────────────────────────────────────────────────────────────────────

const HEAL_DESCRIPTION = [
  'Runs the heal⇄verify repair loop on a filtered subset of contracts (by file path or contract id) instead of the whole project.',
  'Use after omni_isolate to fix one known file or contract, or to retry a contract that omni_fix could not close.',
  'Same physical gate as omni_fix: no patch touches disk until its verifier goes green. Writes into the shared battle report directory.',
].join('\n')

function createHealTool(plugin: ConfigType, deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'omni_heal',
    description: HEAL_DESCRIPTION,
    parameters: {
      root: { type: 'string', description: 'Project root directory; omit for cwd.' },
      file: { type: 'string', description: 'Only heal contracts in this project-relative file.' },
      contractId: { type: 'string', description: 'Only heal this contract id (from omni_isolate).' },
      dryRun: { type: 'boolean', description: 'Run everything but write nothing.' },
      maxRetries: { type: 'integer', description: 'Retry cap per contract (default 3).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    timeoutMs: 1_800_000,
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExec) {
      return guard(async () => {
        const root = resolveRoot(args.root as string | undefined)
        if (!(await pathExists(root))) return fail('not-found', `project root does not exist: ${root}`)
        const file = strOr(args.file, '')
        const contractId = strOr(args.contractId, '')
        if (!file && !contractId) {
          return fail('bad-args', 'omni_heal needs file or contractId to scope the repair (use omni_fix for the whole project)')
        }
        const config = toPipelineConfig(plugin, args)
        const { stats, reportPaths } = await runPipeline(
          root,
          {
            ...config,
            contractFilter: (c) => {
              if (contractId) return c.id === contractId
              return c.file === file || c.file === file.replace(/\\/g, '/')
            },
          },
          { spawn: makeSpawn(deps, exec), signal: exec.signal, onProgress: deps.log },
        )
        return ok({
          runId: stats.runId,
          root,
          scope: contractId ? { contractId } : { file },
          results: stats.results.map((r) => ({
            contractId: r.contractId,
            file: r.file,
            status: r.status,
            appliedVia: r.appliedVia,
            appliedModel: r.appliedModel,
            rounds: r.attempts.length,
            finalError: r.finalError,
          })),
          tokens: stats.tokens,
          report: reportPaths
            ? { dir: reportPaths.dir, markdown: reportPaths.mdPath, json: reportPaths.jsonPath }
            : undefined,
        })
      })
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. omni_verify —— 物理闸门单独跑
// ─────────────────────────────────────────────────────────────────────────────

const VERIFY_DESCRIPTION = [
  'Runs the physical verification gate against a file as it currently exists on disk: picks the right verifier (pytest for Python tests, vitest/node --test for JS/TS tests, tsc --noEmit when a local TypeScript exists, py_compile / node --check otherwise) and reports pass/fail with the raw output.',
  'Use to check whether a file you (or another tool) just edited actually passes locally, without invoking any model.',
  'Read-only for tsc/vitest/pytest runs (they run in the project root); single-file compilers (node --check / py_compile) run on a copy in a temp dir.',
].join('\n')

function createVerifyTool(plugin: ConfigType, deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'omni_verify',
    description: VERIFY_DESCRIPTION,
    parameters: {
      root: { type: 'string', description: 'Project root directory; omit for cwd.' },
      file: {
        type: 'string',
        required: true,
        description: 'Project-relative file to verify.',
      },
      preferTest: {
        type: 'boolean',
        description: 'Prefer running the matching test file instead of a compile check (default false).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ToolExec) {
      return guard(async () => {
        const root = resolveRoot(args.root as string | undefined)
        const file = strOr(args.file, '')
        if (!file) return fail('bad-args', 'file is required')
        const abs = path.resolve(root, file)
        if (!(await pathExists(abs))) return fail('not-found', `file does not exist: ${abs}`)
        const language = detectLanguage(abs)
        const rel = path.relative(root, abs).replace(/\\/g, '/')
        const spec = buildVerifySpec(root, abs, language, {
          preferTestVerify: bolOr(args.preferTest, false),
        })
        if (spec.kind === 'auto') {
          return fail('no-verifier', `no verifier available for ${rel} (language=${language})`)
        }
        const result = await runVerifySpec(spec, makeSpawn(deps, exec))
        return ok({
          file: rel,
          language,
          verifier: spec.kind,
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          output: (result.stdout + '\n' + result.stderr).trim().slice(0, 4000),
        })
      })
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. omni_report —— 战报
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_DESCRIPTION = [
  'Reads Omni-Fixer battle reports: lines scanned, errors found, fixes applied, tokens burned, and per-model war records.',
  'Use after omni_fix/omni_heal to summarise what happened, or with runId to pull an older run.',
  'Read-only. Reports live in <root>/.omni-fix-report (latest.md plus one <runId>.md/.json per run).',
].join('\n')

function createReportTool(plugin: ConfigType, _deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'omni_report',
    description: REPORT_DESCRIPTION,
    parameters: {
      root: { type: 'string', description: 'Project root directory; omit for cwd.' },
      runId: { type: 'string', description: 'Specific run id; omit for the latest run.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>) {
      return guard(async () => {
        const root = resolveRoot(args.root as string | undefined)
        const reportDir = plugin.reportDir !== '' ? plugin.reportDir : path.join(root, REPORT_DIR_NAME)
        if (!(await pathExists(reportDir))) {
          return fail('not-found', `no report directory yet at ${reportDir} — run omni_fix first`)
        }
        const runId = strOr(args.runId, '')
        const target = runId ? path.join(reportDir, `${runId}.json`) : path.join(reportDir, 'latest.md')
        if (!(await pathExists(target))) {
          return fail('not-found', `report not found: ${target}`)
        }
        const entries = await fs.promises.readdir(reportDir)
        const runs = entries.filter((e) => /^\w+\.json$/.test(e)).map((e) => e.replace(/\.json$/, ''))
        if (target.endsWith('.json')) {
          const raw = await fs.promises.readFile(target, 'utf8')
          const stats = JSON.parse(raw)
          return ok({ runId: stats.runId ?? runId, runs, markdown: renderReport(stats) })
        }
        const markdown = await fs.promises.readFile(target, 'utf8')
        const titleRunId = /^# Omni-Fixer 战报 (\S+)/.exec(markdown)?.[1] ?? 'latest'
        return ok({ runId: titleRunId, runs, markdown })
      })
    },
  })
}

/** 造全部工具。apply() 里逐个 ctx.tools.register。 */
export function createTools(pluginConfig: ConfigType, deps: ToolDeps): ToolDefinition[] {
  const plugin = resolvePluginConfig(pluginConfig)
  return [
    createScanTool(plugin, deps),
    createIsolateTool(plugin, deps),
    createFixTool(plugin, deps),
    createHealTool(plugin, deps),
    createVerifyTool(plugin, deps),
    createReportTool(plugin, deps),
  ]
}
