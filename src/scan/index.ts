/**
 * omni_scan —— 扫描编排入口。
 *
 * 两段式：
 *   1. 快扫：对全部源码文件跑零依赖 AST 扫描器（每文件微秒级）。
 *   2. 权威扫：运行检测到的工具链（tsc / vitest / pytest / node-test）。
 *   3. 逐文件兜底：当 AST 无错但项目无 tsc 时，对 JS 家族跑 node --check、
 *      对 Python 跑批量 py_compile（默认上限 1500 文件，保证大项目也可控）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Diagnostic, Language, ScanResult, SpawnFn } from '../core/types.js'
import { DEFAULT_EXCLUDES, detectLanguage, relFrom, walkSourceTree } from '../core/util.js'
import { analyzeJs } from './ast-js.js'
import { analyzePy } from './ast-py.js'
import { detectToolchains, parsePyCompileOutput, runToolchain, type ToolchainName } from './toolchain.js'

export interface ScanOptions {
  spawn: SpawnFn
  include?: string[]
  exclude?: string[]
  maxFiles?: number
  /** 是否运行工具链扫描（tsc/vitest/pytest 等）。默认 true。 */
  useToolchain?: boolean
  /** 逐文件兜底检查的文件上限（超过则跳过兜底）。默认 1500。 */
  maxFileToolchainChecks?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

const DEFAULT_INCLUDE = ['**/*']
const SCAN_FILE_EXTENSIONS = new Set(['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'pyi'])

export async function scanProject(root: string, opts: ScanOptions): Promise<ScanResult> {
  const include = opts.include?.length ? opts.include : DEFAULT_INCLUDE
  const exclude = [...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])]
  const maxFiles = opts.maxFiles ?? 20000
  const useToolchain = opts.useToolchain ?? true

  const diagnostics: Diagnostic[] = []
  const skipped: { path: string; reason: string }[] = []
  const notes: string[] = []
  let filesScanned = 0
  let linesScanned = 0

  const jsFilesAstClean: string[] = []
  const pyFilesAstClean: string[] = []

  const progress = (m: string) => opts.onProgress?.(m)

  // ---- 1. AST 快扫 ----
  // walkSourceTree yield 的是**绝对路径**；诊断里的 file 字段才用相对路径（relFrom）。
  const filePaths: string[] = []
  for await (const abs of walkSourceTree(root, { include, exclude, maxFiles, signal: opts.signal })) {
    filePaths.push(abs)
  }
  progress(`omni_scan: 开始 AST 快扫 ${filePaths.length} 个文件`)

  for (const abs of filePaths) {
    const rel = relFrom(root, abs)
    const language = detectLanguage(abs) as Language
    if (!SCAN_FILE_EXTENSIONS.has(path.extname(abs).slice(1))) {
      skipped.push({ path: rel, reason: 'unsupported extension' })
      continue
    }
    if (language === 'other') {
      skipped.push({ path: rel, reason: 'unsupported language' })
      continue
    }
    let text: string
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      skipped.push({ path: rel, reason: `read error: ${(err as Error).message}` })
      continue
    }
    filesScanned++
    const lineCount = text.split('\n').length
    linesScanned += lineCount

    const diags = language === 'py' ? analyzePy(text, rel).diagnostics : analyzeJs(text, rel).diagnostics
    if (diags.length > 0) {
      diagnostics.push(...diags)
    } else if (language === 'py') {
      pyFilesAstClean.push(abs)
    } else {
      jsFilesAstClean.push(abs)
    }
    if ((filesScanned & 0x1ff) === 0) progress(`omni_scan: 已扫 ${filesScanned}/${filePaths.length}`)
  }

  // ---- 2. 工具链权威扫 ----
  if (useToolchain) {
    const detect = await detectToolchains(root)
    notes.push(...detect.notes)
    const hasTsc = detect.names.includes('tsc')
    for (const name of detect.names as ToolchainName[]) {
      progress(`omni_scan: 运行工具链 ${name}`)
      const res = await runToolchain(name, root, opts.spawn)
      if (res.exitCode === null) {
        notes.push(`toolchain ${name}: 不可用`)
        continue
      }
      diagnostics.push(...res.diagnostics)
      if (res.diagnostics.length === 0 && res.exitCode !== 0) {
        notes.push(`toolchain ${name}: 退出码 ${res.exitCode} 但未解析出诊断（输出尾部: ${res.output.slice(-200).replace(/\n/g, ' | ')})`)
      }
    }

    // ---- 3. 逐文件兜底：无 tsc 的 JS 项目 / Python ----
    const cap = opts.maxFileToolchainChecks ?? 1500
    if (!hasTsc && jsFilesAstClean.length > 0 && jsFilesAstClean.length <= cap) {
      progress(`omni_scan: node --check 兜底 ${jsFilesAstClean.length} 个文件`)
      const { quickNodeCheck } = await import('./toolchain.js')
      const extra = await quickNodeCheck(root, jsFilesAstClean, opts.spawn)
      diagnostics.push(...extra)
    }
    if (pyFilesAstClean.length > 0 && pyFilesAstClean.length <= cap) {
      progress(`omni_scan: py_compile 兜底 ${pyFilesAstClean.length} 个文件`)
      const extra = await batchPyCompile(root, pyFilesAstClean, opts.spawn)
      diagnostics.push(...extra)
    }
  }

  // 去重（AST 与工具链可能报同一个错）
  const dedup = new Map<string, Diagnostic>()
  for (const d of diagnostics) dedup.set(d.id, d)

  const bySource: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  for (const d of dedup.values()) {
    bySource[d.source] = (bySource[d.source] ?? 0) + 1
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1
  }
  progress(`omni_scan: 完成 — ${filesScanned} 文件/${linesScanned} 行，${dedup.size} 条诊断`)

  return {
    root,
    filesScanned,
    linesScanned,
    diagnostics: [...dedup.values()],
    skipped,
    bySource,
    byKind,
    toolchainNotes: notes,
  }
}

/** 批量 `python -m py_compile f1 f2 ...`（一个进程检查多个文件）。 */
async function batchPyCompile(root: string, files: string[], spawn: SpawnFn): Promise<Diagnostic[]> {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const res = await spawn({
    argv: [python, '-m', 'py_compile', ...files],
    cwd: root,
    timeoutMs: 180_000,
    maxOutputBytes: 256 * 1024,
  })
  if (res.exitCode === 0) return []
  return parsePyCompileOutput(res.stderr, root)
}
