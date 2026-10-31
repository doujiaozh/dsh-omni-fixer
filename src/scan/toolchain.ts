/**
 * omni_scan —— 工具链层。
 *
 * AST 扫描器负责"零依赖快扫"；本层负责"权威慢扫"：
 *   tsc --noEmit          TS/JS 类型与语法（权威）
 *   node --check          JS 语法（零配置，Node 自带）
 *   node --test (tap)     Node 内建测试运行器
 *   vitest run            测试失败
 *   python -m pytest      测试失败
 *   python -m py_compile  Python 语法（权威，等价 py_compile）
 *
 * 一切 argv 都组装成 node / python 直调，绕开 Windows 的 .cmd 包装，
 * 保证在 Win7 + 纯 Node 环境下无需 shell 即可 spawn。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import type {
  Diagnostic,
  DiagnosticSource,
  Language,
  SpawnFn,
  SpawnResult,
  VerifySpec,
} from '../core/types.js'
import { hashId, relFrom, toPosix } from '../core/util.js'

const require_ = createRequire(import.meta.url)

export type ToolchainName = 'tsc' | 'node-check' | 'node-test' | 'vitest' | 'pytest' | 'py-compile'

export interface ToolchainDetectResult {
  names: ToolchainName[]
  notes: string[]
}

function pythonExe(): string {
  return process.platform === 'win32' ? 'python' : 'python3'
}

function tryResolve(specifier: string, fromDir: string): string | null {
  try {
    return require_.resolve(specifier, { paths: [fromDir] })
  } catch {
    return null
  }
}

/** 找到项目本地 typescript 的 cli 入口（避开 .cmd 包装）。 */
export function resolveTscJs(root: string): string | null {
  const pkg = tryResolve('typescript/package.json', root)
  if (!pkg) return null
  const tsc = path.join(path.dirname(pkg), 'lib', 'tsc.js')
  return fs.existsSync(tsc) ? tsc : null
}

/** 找到项目本地 vitest 的 cli 入口。 */
export function resolveVitestJs(root: string): string | null {
  const pkg = tryResolve('vitest/package.json', root)
  if (!pkg) return null
  const dir = path.dirname(pkg)
  for (const candidate of ['vitest.mjs', 'vitest.js']) {
    const p = path.join(dir, candidate)
    if (fs.existsSync(p)) return p
  }
  return null
}

export async function detectToolchains(root: string): Promise<ToolchainDetectResult> {
  const names: ToolchainName[] = []
  const notes: string[] = []

  const has = (f: string) => fs.existsSync(path.join(root, f))
  if (has('tsconfig.json')) {
    if (resolveTscJs(root)) names.push('tsc')
    else notes.push('tsconfig.json found but no local typescript — tsc scan skipped')
  }
  const vitestCfg = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'].find(has)
  if (vitestCfg && resolveVitestJs(root)) {
    names.push('vitest')
  } else if (vitestCfg) {
    notes.push('vitest config found but no local vitest — vitest scan skipped')
  }
  const hasPytest =
    has('pytest.ini') ||
    has('setup.cfg') ||
    has('pyproject.toml') ||
    has('conftest.py') ||
    fs.existsSync(path.join(root, 'tests'))
  if (hasPytest) names.push('pytest')
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
      const testScript = String(pkg.scripts?.test ?? '')
      if (/vitest/.test(testScript) && resolveVitestJs(root)) {
        if (!names.includes('vitest')) names.push('vitest')
      }
      if (/node --test|node --test/.test(testScript) && !names.includes('node-test')) {
        names.push('node-test')
      }
    } catch {
      notes.push('package.json unreadable — script-based detection skipped')
    }
  }
  return { names, notes }
}

function diag(
  source: DiagnosticSource,
  rule: string | undefined,
  kind: Diagnostic['kind'],
  root: string,
  absFile: string,
  line: number,
  column: number,
  message: string,
  test?: string,
): Diagnostic {
  return {
    id: hashId([source, rule ?? 'none', relFrom(root, absFile), String(line), String(column)]),
    source,
    rule,
    kind,
    file: relFrom(root, absFile),
    line,
    column,
    severity: 'error',
    message,
    ...(test ? { test } : {}),
  }
}

/** tsc 输出解析：`file.ts(12,5): error TS2304: Cannot find name 'x'.` */
export function parseTscOutput(stdout: string, stderr: string, root: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const lines = (stdout + '\n' + stderr).split(/\r?\n/)
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/
  for (const ln of lines) {
    const m = re.exec(ln)
    if (!m) continue
    const [, file, lineStr, colStr, sev, code, msg] = m
    if (sev !== 'error') continue
    const codeNum = Number(code.slice(2))
    const kind: Diagnostic['kind'] = codeNum < 2000 ? 'syntax' : 'type'
    out.push(diag('tsc', code, kind, root, path.resolve(root, file!), Number(lineStr), Number(colStr), msg!))
  }
  return out
}

/** node --check 输出解析：`SyntaxError: Unexpected token ... at file:line:col` */
export function parseNodeCheckOutput(stdout: string, stderr: string, root: string): Diagnostic[] {
  const text = stdout + '\n' + stderr
  const lines = text.split(/\r?\n/)
  const out: Diagnostic[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /SyntaxError:\s*(.*)/.exec(lines[i]!)
    if (!m) continue
    // 向后找 `at <file>:<line>:<col>` 或下一行的 `   at ...`
    for (let k = i; k < Math.min(lines.length, i + 8); k++) {
      const lm = /at\s+\(?(?:file:\/+)?([^()]+?):(\d+)(?::(\d+))?\)?\s*$/.exec(lines[k]!)
      if (lm) {
        const file = lm[1]!.replace(/^['"]|['"]$/g, '')
        out.push(
          diag('node-check', 'node/syntax-error', 'syntax', root, path.resolve(root, file), Number(lm[2]), Number(lm[3] ?? 1), `SyntaxError: ${m[1]}`),
        )
        break
      }
      const fm = /^\s*(?:file\s*[:=]\s*)?["']?(.+?):(\d+)(?::(\d+))?$/.exec(lines[k]!)
      if (fm && fs.existsSync(fm[1]!)) {
        out.push(
          diag('node-check', 'node/syntax-error', 'syntax', root, path.resolve(root, fm[1]!), Number(fm[2]), Number(fm[3] ?? 1), `SyntaxError: ${m[1]}`),
        )
        break
      }
    }
  }
  return out
}

/** python -m py_compile 输出解析：`File "path", line N` + `SyntaxError: ...` */
export function parsePyCompileOutput(stderr: string, root: string): Diagnostic[] {
  const lines = stderr.split(/\r?\n/)
  const out: Diagnostic[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*File\s+"(.+?)",\s*line\s+(\d+)/.exec(lines[i]!)
    if (!m) continue
    let j = i + 1
    let message = 'SyntaxError'
    while (j < lines.length && j < i + 6) {
      const sm = /^\s*(SyntaxError|IndentationError|TabError|ValueError):\s*(.*)/.exec(lines[j]!)
      if (sm) {
        message = `${sm[1]}: ${sm[2]}`
        break
      }
      j++
    }
    out.push(
      diag('py-compile', 'py/syntax-error', 'syntax', root, path.resolve(m[1]!), Number(m[2]), 1, message),
    )
  }
  return out
}

/** pytest 输出解析：`FAILED path::test - reason` + `path:NN: in test` */
export function parsePytestOutput(stdout: string, stderr: string, root: string): Diagnostic[] {
  const text = stdout + '\n' + stderr
  const lines = text.split(/\r?\n/)
  const out: Diagnostic[] = []
  const failures = new Map<string, { test: string; reason: string; file: string | null; line: number }>()
  for (const ln of lines) {
    const m = /^FAILED\s+(\S+?)::(\S+?)\s+-\s+(.*)$/.exec(ln)
    if (!m) continue
    const [, file, test, reason] = m
    failures.set(`${file}::${test}`, { test, reason, file: null, line: 0 })
    void test
  }
  // FAILURES 正文里的 `path:NN: in test_name` 提供精确位置
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(\S+?\.py):(\d+): in (\S+)/.exec(lines[i]!)
    if (!m) continue
    const file = m[2]!
    const test = m[4]!
    const key = `${file}::${test}`
    const f = failures.get(key)
    if (f) {
      f.file = file
      f.line = Number(m[3])
    } else if (!lines.slice(Math.max(0, i - 3), i).some((l) => /^E\s/.test(l))) {
      // 位置存在但没有 FAILED 行：collection/未知失败
      failures.set(key, { test, reason: 'pytest failure', file, line: Number(m[3]) })
    }
  }
  for (const f of failures.values()) {
    out.push(
      diag(
        'pytest',
        'pytest/test-failure',
        'test',
        root,
        path.resolve(root, f.file ?? 'unknown'),
        f.line,
        1,
        f.reason,
        f.test,
      ),
    )
  }
  return out
}

/** node --test --test-reporter=tap 输出解析。 */
export function parseNodeTestOutput(stdout: string, stderr: string, root: string): Diagnostic[] {
  const text = stdout + '\n' + stderr
  const lines = text.split(/\r?\n/)
  const out: Diagnostic[] = []
  let pendingName: string | null = null
  let pendingStart = -1
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!
    const fail = /^not ok\s+\d+\s+-\s+(.*)$/.exec(ln)
    if (fail) {
      pendingName = fail[1]!.trim()
      pendingStart = i
      continue
    }
    if (pendingName && i - pendingStart < 30) {
    // `location: '<path>:<line>:<col>'`（TAP YAML 块里的失败位置，不随堆栈变化）
    // 注意：Windows 绝对路径含盘符冒号（C:\），路径段不能用排除冒号的字符类。
    const loc = /^\s*location:\s*["']?([^'"]+?):(\d+):(\d+)/.exec(ln)
    if (loc) {
      const file = loc[1]!.replace(/["']/g, '').trim()
      if (!/node[:\/]/.test(file) && !file.includes('node:internal')) {
        out.push(
          diag('node-test', 'node/test-failure', 'test', root, path.resolve(root, file), Number(loc[2]), Number(loc[3]), `node --test 失败: ${pendingName}`, pendingName),
        )
        pendingName = null
        continue
      }
    }
    // `at: <path>:<line>:<col>` 或 YAML 块 `file: / line: N`
    const at = /^\s*at:\s*["']?(?:file:\/+)?([^'"]+?):(\d+):(\d+)/.exec(ln)
      if (at) {
        const file = at[1]!.replace(/["']/g, '')
        if (!/node[:\/]/.test(file) && !file.includes('node:internal')) {
          out.push(
            diag(
              'node-test',
              'node/test-failure',
              'test',
              root,
              path.resolve(root, file),
              Number(at[2]),
              Number(at[3]),
              `node --test 失败: ${pendingName}`,
              pendingName,
            ),
          )
          pendingName = null
          continue
        }
      }
      const fileYaml = /^\s*file:\s*"?([^"\s]+)"?/.exec(ln)
      if (fileYaml) {
        const lineYaml = /^\s*line:\s*(\d+)/.exec(lines[i + 1] ?? '')
        const colYaml = /^\s*column:\s*(\d+)/.exec(lines[i + 2] ?? '')
        out.push(
          diag(
            'node-test',
            'node/test-failure',
            'test',
            root,
            path.resolve(root, fileYaml[1]!),
            Number(lineYaml?.[1] ?? 1),
            Number(colYaml?.[1] ?? 1),
            `node --test 失败: ${pendingName}`,
            pendingName,
          ),
        )
        pendingName = null
      }
    }
  }
  return out
}

/** vitest 输出解析：`FAIL  file > name [ file:line:col ]` 与 `❯ file:line:col` 帧。 */
export function parseVitestOutput(stdout: string, stderr: string, root: string): Diagnostic[] {
  const text = stdout + '\n' + stderr
  const lines = text.split(/\r?\n/)
  const out: Diagnostic[] = []
  const emitted = new Set<string>()
  let lastFail: { file: string; test: string } | null = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!
    const m = /^FAIL\s+(\S+?)(?:\s+>\s+(.*?))?(?:\s+\[\s*(\S+?):(\d+):(\d+)\s*\])?\s*$/.exec(ln)
    if (m) {
      const file = m[1]!
      const test = (m[2] ?? '<file>').trim()
      lastFail = { file, test }
      if (m[3]) {
        const key = `${file}:${test}`
        if (!emitted.has(key)) {
          emitted.add(key)
          out.push(
            diag(
              'vitest',
              'vitest/test-failure',
              'test',
              root,
              path.resolve(root, file),
              Number(m[4]),
              Number(m[5]),
              `vitest 用例失败: ${test}`,
              test,
            ),
          )
        }
      }
      continue
    }
    // `❯ src/lib.ts:4:3` —— 失败调用帧，优先指向非 node_modules 的源文件
    const frame = /^\s*❯\s+(\S+?):(\d+):(\d+)/.exec(ln)
    if (frame && lastFail) {
      const file = frame[1]!
      if (file.includes('node_modules')) continue
      const key = `${lastFail.file}:${lastFail.test}@${file}:${frame[2]}`
      if (emitted.has(key)) continue
      emitted.add(key)
      out.push(
        diag(
          'vitest',
          'vitest/test-failure',
          'test',
          root,
          path.resolve(root, file),
          Number(frame[2]),
          Number(frame[3]),
          `vitest 用例失败: ${lastFail.test}（失败位置 ${path.basename(file)}:${frame[2]}）`,
          lastFail.test,
        ),
      )
    }
    if (/^ *✓|^ *✗|Test Files|Tests +\d+/.test(ln)) {
      // 计数行——不重置 lastFail
    }
  }
  return out
}

/** 执行一条验证命令（custom 或已组装好的 argv），带超时。 */
export async function runVerifySpec(spec: VerifySpec, spawn: SpawnFn): Promise<SpawnResult> {
  if (!spec.argv || spec.argv.length === 0) {
    return {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'No verify command available for this contract (no toolchain detected).',
      timedOut: false,
    }
  }
  return spawn({
    argv: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    timeoutMs: 180_000,
    maxOutputBytes: 96 * 1024,
  })
}

export interface VerifySpecOptions {
  /** 契约首要诊断是否来自测试运行器（优先验证测试而不是静态检查）。 */
  preferTestVerify?: boolean
  /** 失败测试所在文件/用例（preferTestVerify 时使用）。 */
  test?: string
  tscCompositeRetry?: boolean
}

/**
 * 反向定位测试文件：诊断可能指向源文件（如失败帧 `math.ts:4`），
 * 而验证器要跑的是测试文件（`math.test.ts`）。
 * 命中规则：文件本身是测试文件 → 直接用；否则按命名约定找邻居。
 */
export function resolveTestFile(root: string, absFile: string, language: Language): string | null {
  const base = path.basename(absFile)
  const dir = path.dirname(absFile)
  const isJs = language !== 'py'
  const exts = isJs ? ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] : ['py']

  if (isJs && /\.(?:test|spec)\.[a-z]+$/.test(base)) return absFile
  if (!isJs && /^test_.*\.py$/.test(base)) return absFile

  const stem = base.replace(/\.[^.]+$/, '')
  for (const ext of exts) {
    const jsCandidates = [
      path.join(dir, `${stem}.test.${ext}`),
      path.join(dir, `${stem}.spec.${ext}`),
      path.join(dir, '__tests__', `${stem}.test.${ext}`),
      path.join(dir, '__tests__', `${stem}.${ext}`),
      path.join(root, 'tests', `${stem}.test.${ext}`),
      path.join(root, 'test', `${stem}.test.${ext}`),
    ]
    const pyCandidates = [
      path.join(root, 'tests', `test_${stem}.py`),
      path.join(dir, `test_${stem}.py`),
      path.join(root, 'tests', `${stem}_test.py`),
      path.join(root, 'tests', 'test.py'),
    ]
    const candidates = isJs ? jsCandidates : pyCandidates
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
  }
  return null
}

/**
 * 组装验证规格。一次性把 argv 物化，runVerifySpec 直接执行。
 * 路径一律绝对，cwd 仍是项目根（原地策略）/ 沙盒根（沙盒策略由 verifier 改写）。
 */
export function buildVerifySpec(
  root: string,
  absFile: string,
  language: Language,
  opts: VerifySpecOptions = {},
): VerifySpec {
  const node = process.execPath
  const tscJs = resolveTscJs(root)
  const vitestJs = resolveVitestJs(root)

  if (opts.preferTestVerify) {
    const testFile = resolveTestFile(root, absFile, language)
    if (language === 'py') {
      const argv = [pythonExe(), '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--tb=line']
      if (testFile && opts.test) argv.push(`${testFile}::${opts.test}`)
      else if (testFile) argv.push(testFile)
      return { kind: 'pytest', cwd: root, argv }
    }
    if (vitestJs) {
      const argv = [node, vitestJs, 'run', '--reporter=basic', '--no-color']
      if (testFile) argv.push(testFile)
      return { kind: 'vitest', cwd: root, argv }
    }
    return {
      kind: 'node-test',
      cwd: root,
      // Node 20+ 的 `node --test` 从 cwd 递归自动发现测试文件；
      // 传目录实参在部分版本会被当成“测试文件路径”导致 MODULE_NOT_FOUND。
      argv: [node, '--test', '--test-reporter=tap', ...(testFile ? [testFile] : [])],
    }
  }

  if ((language === 'ts' || language === 'tsx' || language === 'js' || language === 'jsx' || language === 'mjs' || language === 'cjs') && tscJs) {
    return {
      kind: 'tsc',
      cwd: root,
      argv: [node, tscJs, '--noEmit', '--pretty', 'false', ...(opts.tscCompositeRetry ? ['--composite', 'false'] : [])],
    }
  }
  if (language === 'py') {
    return {
      kind: 'py-compile',
      cwd: root,
      argv: [pythonExe(), '-m', 'py_compile', absFile],
    }
  }
  return {
    kind: 'node-check',
    cwd: root,
    argv: [node, '--check', absFile],
  }
}

/** tsc 的 composite/noEmit 冲突重试判断（TS6307 等）。 */
export function needsTscCompositeRetry(output: string): boolean {
  return /may not disable emit|TS6307|composite/i.test(output)
}

export function toolchainScanCommand(name: ToolchainName, root: string): { argv: string[]; cwd: string } | null {
  const node = process.execPath
  switch (name) {
    case 'tsc': {
      const tscJs = resolveTscJs(root)
      if (!tscJs) return null
      return { argv: [node, tscJs, '--noEmit', '--pretty', 'false'], cwd: root }
    }
    case 'node-check':
      return null // 逐文件触发，scan 阶段对 JS 家族自动跑
    case 'node-test':
      // Node 20+：从 cwd 递归自动发现测试文件（目录实参在某些版本会被当作文件路径）。
      return { argv: [node, '--test', '--test-reporter=tap'], cwd: root }
    case 'vitest': {
      const vitestJs = resolveVitestJs(root)
      if (!vitestJs) return null
      return { argv: [node, vitestJs, 'run', '--reporter=basic', '--no-color'], cwd: root }
    }
    case 'pytest':
      return {
        argv: [pythonExe(), '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--tb=line', ...collectPytestTargets(root)],
        cwd: root,
      }
    case 'py-compile':
      return null
  }
}

function collectPytestTargets(root: string): string[] {
  const targets: string[] = []
  for (const dir of ['tests', 'test']) {
    const p = path.join(root, dir)
    if (fs.existsSync(p)) targets.push(path.relative(root, p) || dir)
  }
  return targets.length ? targets : ['.']
}

/** 运行一次工具链扫描并解析成诊断。 */
export async function runToolchain(
  name: ToolchainName,
  root: string,
  spawn: SpawnFn,
): Promise<{ diagnostics: Diagnostic[]; output: string; exitCode: number | null }> {
  const cmd = toolchainScanCommand(name, root)
  if (!cmd) return { diagnostics: [], output: '', exitCode: null }
  const res = await spawn({ argv: cmd.argv, cwd: cmd.cwd, timeoutMs: 300_000, maxOutputBytes: 512 * 1024 })
  const output = `${res.stdout}\n${res.stderr}`
  let diagnostics: Diagnostic[] = []
  switch (name) {
    case 'tsc':
      diagnostics = parseTscOutput(res.stdout, res.stderr, root)
      break
    case 'node-test':
      diagnostics = parseNodeTestOutput(res.stdout, res.stderr, root)
      break
    case 'vitest':
      diagnostics = parseVitestOutput(res.stdout, res.stderr, root)
      break
    case 'pytest':
      diagnostics = parsePytestOutput(res.stdout, res.stderr, root)
      break
    default:
      break
  }
  return { diagnostics, output, exitCode: res.exitCode }
}

/** 对 JS 家族文件运行 node --check 快扫（无 tsc 时的兜底）。 */
export async function quickNodeCheck(root: string, absFiles: string[], spawn: SpawnFn): Promise<Diagnostic[]> {
  const out: Diagnostic[] = []
  for (const f of absFiles) {
    const res = await spawn({
      argv: [process.execPath, '--check', f],
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: 32 * 1024,
    })
    if (res.exitCode !== 0) {
      out.push(...parseNodeCheckOutput(res.stdout, res.stderr, root))
    }
  }
  return out
}

export { toPosix }
