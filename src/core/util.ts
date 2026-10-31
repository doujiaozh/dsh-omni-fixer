/**
 * 通用工具：哈希、路径、glob、目录遍历、行窗口渲染。
 * 零第三方依赖，全部基于 node:fs / node:crypto / node:path。
 */
import { createHash } from 'node:crypto'
import { promises as fsp, constants as fsConstants } from 'node:fs'
import path from 'node:path'

export function now(): string {
  return new Date().toISOString()
}

export function elapsed(start: string): number {
  return Date.now() - new Date(start).getTime()
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export function relFrom(root: string, abs: string): string {
  return toPosix(path.relative(root, abs))
}

/** 稳定哈希：source:rule:file:line:col → 12 位 hex。 */
export function hashId(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 12)
}

export async function readText(file: string): Promise<string> {
  return fsp.readFile(file, 'utf8')
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export function splitLines(text: string): string[] {
  // 保留 \r\n 与 \n 混排场景的行切分；末尾换行不产生空行。
  if (text.length === 0) return []
  return text.replace(/\r\n?/g, '\n').split('\n')
}

export function joinLines(lines: string[]): string {
  return lines.join('\n') + '\n'
}

const LINE_NUM_WIDTH = 5

/**
 * 把文本窗口渲染成带行号的代码块：
 * `   12 │ const x = 1`
 * 行号与原文件 1-based 对齐，便于模型在 errorText 里定位。
 */
export function renderSnippet(lines: string[], startLine: number): string {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const num = String(startLine + i).padStart(LINE_NUM_WIDTH)
    out.push(`${num} │ ${lines[i]}`)
  }
  return out.join('\n')
}

/** 从完整文本中截取 [start, end]（1-based, inclusive）的行。 */
export function sliceLines(text: string, start: number, end: number): string[] {
  const lines = splitLines(text)
  const s = Math.max(0, Math.min(lines.length, start - 1))
  const e = Math.max(s, Math.min(lines.length, end))
  return lines.slice(s, e)
}

/** 极简 glob：支持 *、**、?、前导 ! 取反。模式以 / 开头表示相对根。 */
export function matchGlob(pattern: string, posixPath: string): boolean {
  const negate = pattern.startsWith('!')
  if (negate) pattern = pattern.slice(1)
  // 模式不含 / → 只匹配 basename
  const target = pattern.includes('/') ? posixPath : posixPath.split('/').pop() ?? ''
  const re = globToRegExp(pattern)
  const hit = re.test(target)
  return negate ? !hit : hit
}

function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 2
        if (pattern[i] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
        continue
      }
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+()^$|{}\\[]'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
    i++
  }
  return new RegExp('^(?:' + re + ')$')
}

export const DEFAULT_EXCLUDES: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/.tox/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/.omni-fix-report/**',
  '**/*.min.js',
  '**/*.min.mjs',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/*.map',
]

const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx'])
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const PY_EXTS = new Set(['.py', '.pyi'])

export function detectLanguage(file: string): import('./types.js').Language {
  const ext = path.extname(file).toLowerCase()
  if (JS_EXTS.has(ext)) return ext === '.mjs' ? 'mjs' : ext === '.cjs' ? 'cjs' : ext === '.jsx' ? 'jsx' : 'js'
  if (TS_EXTS.has(ext)) return ext === '.tsx' ? 'tsx' : 'ts'
  if (PY_EXTS.has(ext)) return 'py'
  return 'other'
}

/** 判断是否为可扫描的源码文件（按扩展名 + 可读文本）。 */
export function isScannable(file: string): boolean {
  const lang = detectLanguage(file)
  return lang !== 'other'
}

const TEXT_PROBE = /\u0000/

/** 异步遍历目录，产出符合 include/exclude 的源码文件。 */
export async function* walkSourceTree(
  root: string,
  opts: {
    include?: string[]
    exclude?: string[]
    maxFiles?: number
    signal?: AbortSignal
  } = {},
): AsyncGenerator<string> {
  const exclude = [...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])]
  const include = opts.include
  let yielded = 0
  const stack: string[] = [root]
  while (stack.length) {
    if (opts.signal?.aborted) return
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      const rp = relFrom(root, abs)
      if (exclude.some((p) => matchGlob(p, rp))) continue
      if (ent.isDirectory()) {
        stack.push(abs)
      } else if (ent.isFile() && isScannable(abs)) {
        if (include && !include.some((p) => matchGlob(p, rp))) continue
        if (opts.maxFiles && yielded >= opts.maxFiles) return
        let looksBinary = false
        let fh: Awaited<ReturnType<typeof fsp.open>> | undefined
        try {
          fh = await fsp.open(abs, 'r')
          const buf = Buffer.alloc(256)
          const { bytesRead } = await fh.read(buf, 0, 256, 0)
          looksBinary =
            bytesRead > 0 && TEXT_PROBE.test(buf.subarray(0, bytesRead).toString('utf8'))
        } catch {
          // 探针失败交给后续完整读取处理
        } finally {
          await fh?.close().catch(() => {})
        }
        if (looksBinary) continue
        yielded++
        yield abs
      }
    }
  }
}

/** 创建限并发执行器（修复流水线限制对强模型的并发）。 */
export function createConcurrencyLimiter(max: number) {
  const limit = Math.max(1, max)
  let active = 0
  const waiters: Array<() => void> = []
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const next = () => {
          if (active >= limit) {
            waiters.push(next)
            return
          }
          active++
          fn()
            .then(resolve, reject)
            .finally(() => {
              active--
              const w = waiters.shift()
              if (w) w()
            })
        }
        next()
      })
    },
  }
}

/** 包装可取消的 promise 超时（返回 [result, timedOut] 语义简单版）。 */
export function rejectOnTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)),
      ms,
    )
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 把字节数缩成人类可读。 */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`
  return `${(n / 1024 / 1024).toFixed(1)}MiB`
}

/** 毫秒 → 人类可读时长。 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${s}s`
}
