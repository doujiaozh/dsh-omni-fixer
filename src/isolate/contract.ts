/**
 * omni_isolate —— 错误修复契约（Error Fix Contract）生成器。
 *
 * 设计哲学：弱模型修不好大项目的根因是"上下文太杂"。
 * 本模块把 N 万行工程中的每个错误群压缩成一份"只需看 contextLines 行"
 * 的自包含任务，并用硬规则约束模型不许越界。
 *
 * 聚类策略：
 *   - 同一文件存在语法级诊断 → 整个文件合并成一份契约（语法错误会级联）。
 *   - 否则按行邻近度（gap < gapThreshold）聚类。
 *   - 跨文件错误天然拆分（每个契约只涉及一个文件——验证闸门的最小单位）。
 */
import path from 'node:path'
import type {
  Complexity,
  Diagnostic,
  FixContract,
  Language,
  ScanResult,
  VerifySpec,
} from '../core/types.js'
import { hashId, readText, renderSnippet, sliceLines, splitLines } from '../core/util.js'
import { buildVerifySpec } from '../scan/toolchain.js'
import { detectLanguage } from '../core/util.js'

export interface ContractOptions {
  contextLines: number
  gapThreshold: number
  maxFullFileLines: number
  allowedDrift: number
}

const DRIFT_DEFAULT = 3

export const CONTRACT_RULES = [
  '你看到的代码只是原文件的一个窗口，禁止猜测或修改窗口之外的行。',
  '只修复 ERRORS 中列出的具体报错；禁止顺手重构、重命名、调整顺序或修改无关行。',
  '不要解释、不要输出行号、不要输出 markdown 标题。',
]

export function classifyComplexity(diagnostics: Diagnostic[]): Complexity {
  if (diagnostics.length === 0) return 'trivial'
  if (diagnostics.some((d) => d.kind === 'test')) return 'hard'
  if (diagnostics.every((d) => d.kind === 'syntax')) return 'trivial'
  return 'moderate'
}

/** 一份契约最多携带多少条 errorText（避免 prompt 爆炸）。 */
const MAX_ERRORS_PER_CONTRACT = 20

function formatErrors(diagnostics: Diagnostic[]): string {
  return diagnostics
    .slice(0, MAX_ERRORS_PER_CONTRACT)
    .map((d) => {
      const loc = d.line > 0 ? `${d.line}:${d.column}` : '?:?'
      const src = d.rule ? `${d.source} ${d.rule}` : d.source
      return `- [${src}] ${loc} ${d.test ? `(${d.test}) ` : ''}${d.message}`
    })
    .join('\n')
}

function diagnosticSupportsOneFile(d: Diagnostic): boolean {
  return d.file !== 'unknown'
}

export async function buildContracts(
  scan: ScanResult,
  opts: ContractOptions,
): Promise<FixContract[]> {
  const root = scan.root
  const byFile = new Map<string, Diagnostic[]>()
  for (const d of scan.diagnostics) {
    if (d.severity !== 'error' || !diagnosticSupportsOneFile(d)) continue
    let arr = byFile.get(d.file)
    if (!arr) {
      arr = []
      byFile.set(d.file, arr)
    }
    arr.push(d)
  }

  const contracts: FixContract[] = []
  for (const [file, diags] of byFile) {
    diags.sort((a, b) => a.line - b.line)
    const abs = path.resolve(root, file)
    let content: string
    try {
      content = await readText(abs)
    } catch {
      scan.toolchainNotes.push(`contract skipped: cannot read ${file}`)
      continue
    }
    const language = detectLanguage(abs) as Language
    const totalLines = splitLines(content).length

    // 语法级错误 → 整文件一份契约（级联效应）
    const clusters: Diagnostic[][] = []
    if (diags.some((d) => d.kind === 'syntax')) {
      clusters.push(diags.filter((d) => d.kind === 'syntax'))
      const others = diags.filter((d) => d.kind !== 'syntax')
      if (others.length > 0) clusters.push(others)
    } else {
      let current: Diagnostic[] = []
      for (const d of diags) {
        if (current.length === 0) {
          current.push(d)
          continue
        }
        const last = current[current.length - 1]!
        if (d.line - last.line > opts.gapThreshold) {
          clusters.push(current)
          current = []
        }
        current.push(d)
      }
      if (current.length > 0) clusters.push(current)
    }

    for (const cluster of clusters) {
      const lines = cluster.map((d) => (d.line > 0 ? d.line : 1))
      const minLine = Math.min(...lines)
      const maxLine = Math.max(...lines)
      const ctx = opts.contextLines ?? 50
      const startLine = Math.max(1, minLine - ctx)
      const endLine = Math.min(totalLines, maxLine + ctx)
      const complexity = classifyComplexity(cluster)
      const tests = [...new Set(cluster.map((d) => d.test).filter(Boolean))] as string[]
      const verify: VerifySpec = buildVerifySpec(root, abs, language, {
        preferTestVerify: complexity === 'hard' || cluster.some((d) => d.kind === 'test'),
        test: tests[0],
      })

      const errorText = formatErrors(cluster)
      const errorRules = cluster.map((d) => d.rule).filter(Boolean) as string[]
      const id = hashId([file, errorText, String(startLine), String(endLine)])
      contracts.push({
        id,
        diagnosticIds: cluster.map((d) => d.id),
        file,
        absolutePath: abs,
        language,
        startLine,
        endLine,
        snippet: renderSnippet(sliceLines(content, startLine, endLine), startLine),
        errorText,
        rules: CONTRACT_RULES,
        errorRules,
        verify,
        complexity,
        tests,
        totalLines,
      })
    }
  }

  // 先修语法（trivial），再类型（moderate），最后测试失败（hard）
  const order: Record<Complexity, number> = { trivial: 0, moderate: 1, hard: 2 }
  contracts.sort((a, b) => order[a.complexity] - order[b.complexity] || a.file.localeCompare(b.file))
  return contracts
}

export { DRIFT_DEFAULT }
