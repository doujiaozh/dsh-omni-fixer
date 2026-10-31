/**
 * omni_verify —— 物理沙盒验证闸门。
 *
 * 铁律：模型（与规则引擎）返回的补丁绝不直接覆盖源文件。
 * 先把补丁放进一个"可丢弃的物理环境"里跑一遍真实工具链，
 * 绿了才允许写回。失败就把新的报错证据退回 omni_heal 重试。
 *
 * 两种策略：
 *   - sandbox：建临时沙盒目录，镜像工程（目录 junction / 文件拷贝），
 *              把候选文件覆盖进去，在沙盒里跑验证器。零源码风险。
 *   - inplace：先备份原文件 → 写候选 → 跑验证器 → finally 无条件恢复。
 *              用于 tsc 这类依赖全工程增量缓存（tsbuildinfo）的场景——
 *              冷沙盒会让一个大项目每次验证都全量重编，慢到不可接受。
 *              'auto' 策略下 tsc 走原地，其余走沙盒。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { FixContract, SpawnFn, VerifySpec, VerifyStrategy } from '../core/types.js'
import { needsTscCompositeRetry, runVerifySpec, buildVerifySpec } from '../scan/toolchain.js'

export interface VerifyOptions {
  spawn: SpawnFn
  strategy: VerifyStrategy
  signal?: AbortSignal
  keepSandbox?: boolean
  sandboxParent?: string
}

export interface VerifyResult {
  ok: boolean
  exitCode: number | null
  output: string
  failureReason: string
  method: 'sandbox' | 'inplace'
  sandboxDir?: string
  specKind: string
}

export function resolveStrategy(contract: FixContract, strategy: VerifyStrategy): 'sandbox' | 'inplace' {
  if (strategy === 'sandbox') return 'sandbox'
  if (strategy === 'inplace') return 'inplace'
  // auto：tsc 走原地（增量缓存），其余走沙盒
  return contract.verify.kind === 'tsc' ? 'inplace' : 'sandbox'
}

/** 对一个 tsc 验证做 composite 冲突重试（TS6307）。 */
async function runTscWithRetry(
  spec: VerifySpec,
  contract: FixContract,
  spawn: SpawnFn,
): Promise<{ exitCode: number | null; output: string }> {
  let res = await runVerifySpec(spec, spawn)
  let output = `${res.stdout}\n${res.stderr}`
  if (res.exitCode !== 0 && spec.kind === 'tsc' && needsTscCompositeRetry(output)) {
    const retry = buildVerifySpec(spec.cwd, contract.absolutePath, contract.language, {
      preferTestVerify: false,
      tscCompositeRetry: true,
    })
    res = await runVerifySpec({ ...retry, argv: spec.argv, cwd: spec.cwd }, spawn)
    output = `${res.stdout}\n${res.stderr}`
  }
  return { exitCode: res.exitCode, output: output ?? '' }
}

/**
 * 把验证规格里的“原文件绝对路径”改写到沙盒内的候选文件路径。
 * node-check / py-compile 的 argv 最后一个元素是原文件绝对路径，
 * 不改写的话沙盒里验证的仍然是未修复的源文件。
 */
function rewriteForSandbox(
  spec: VerifySpec,
  contract: FixContract,
  candidatePath: string,
): VerifySpec {
  const abs = path.resolve(contract.absolutePath)
  const argv = (spec.argv ?? []).map((a: string) => {
    try {
      return path.resolve(a) === abs ? candidatePath : a
    } catch {
      return a
    }
  })
  return { ...spec, argv }
}

export async function verifyCandidate(
  contract: FixContract,
  candidate: string,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const method = resolveStrategy(contract, opts.strategy)

  if (method === 'inplace') {
    const abs = contract.absolutePath
    let backup = ''
    try {
      backup = await fs.promises.readFile(abs, 'utf8')
    } catch {
      return {
        ok: false,
        exitCode: null,
        output: '',
        failureReason: `无法读取原文件以备份: ${abs}`,
        method,
        specKind: contract.verify.kind,
      }
    }
    try {
      await fs.promises.writeFile(abs, candidate, 'utf8')
      const spec = { ...contract.verify, cwd: contract.verify.cwd }
      const { exitCode, output } = await runTscWithRetry(spec, contract, opts.spawn)
      if (exitCode === 0) {
        return okResult(output, method, contract.verify.kind)
      }
      return failResult(output, method, contract.verify.kind)
    } catch (err) {
      return {
        ok: false,
        exitCode: null,
        output: '',
        failureReason: `原地验证异常: ${(err as Error).message}`,
        method,
        specKind: contract.verify.kind,
      }
    } finally {
      // 无条件恢复：成功也恢复，落盘由 pipeline 统一做（同一文件多契约不会互相污染）
      try {
        await fs.promises.writeFile(abs, backup, 'utf8')
      } catch {
        // ignore
      }
    }
  }

  // ---- sandbox ----
  const { sandboxDir, candidatePath } = await createSandbox(contract, candidate, opts.sandboxParent)
  try {
    const spec = rewriteForSandbox({ ...contract.verify, cwd: sandboxDir }, contract, candidatePath)
    const { exitCode, output } = await runTscWithRetry(spec, contract, opts.spawn)
    if (exitCode === 0) {
      return okResult(output, method, contract.verify.kind, sandboxDir)
    }
    return failResult(output, method, contract.verify.kind, sandboxDir)
  } finally {
    if (!opts.keepSandbox) {
      removeJunctionDir(sandboxDir)
    }
  }
}

function okResult(output: string, method: 'sandbox' | 'inplace', kind: string, sandboxDir?: string): VerifyResult {
  return {
    ok: true,
    exitCode: 0,
    output,
    failureReason: '',
    method,
    sandboxDir,
    specKind: kind,
  }
}

function failResult(output: string, method: 'sandbox' | 'inplace', kind: string, sandboxDir?: string): VerifyResult {
  return {
    ok: false,
    exitCode: 1,
    output,
    failureReason: summarizeFailure(output, kind),
    method,
    sandboxDir,
    specKind: kind,
  }
}

function summarizeFailure(output: string, kind: string): string {
  const tail = output
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-12)
    .join('\n')
  return `验证器（${kind}）未通过:\n${tail}`
}

/** 需要全工程镜像的验证器：vitest / node-test / tsc(强制沙盒时)。 */
function needsProjectMirror(kind: string): boolean {
  return kind === 'vitest' || kind === 'node-test' || kind === 'tsc' || kind === 'pytest'
}

/**
 * 创建沙盒：
 *   - 验证器只看单文件（node-check / py-compile）：临时目录里放一个文件即可。
 *   - 验证器看全工程：镜像工程目录——目录用 junction（Win7 无需提权），
 *     文件真实拷贝，候选文件覆盖目标。
 * 返回沙盒目录与候选文件在沙盒内的绝对路径。
 */
async function createSandbox(
  contract: FixContract,
  candidate: string,
  parent?: string,
): Promise<{ sandboxDir: string; candidatePath: string }> {
  const root = path.dirname(contract.absolutePath)
  const tmpBase = parent ?? os.tmpdir()
  const sandbox = fs.mkdtempSync(path.join(tmpBase, '.~omni-tmp-'))

  if (!needsProjectMirror(contract.verify.kind)) {
    const target = path.join(sandbox, path.basename(contract.absolutePath))
    await fs.promises.writeFile(target, candidate, 'utf8')
    return { sandboxDir: sandbox, candidatePath: target }
  }

  const realRoot = contract.verify.cwd
  mirrorTree(realRoot, sandbox, contract.absolutePath, candidate, root)
  return {
    sandboxDir: sandbox,
    candidatePath: path.join(sandbox, path.relative(realRoot, contract.absolutePath)),
  }
}

/**
 * 镜像 realRoot → sandbox：
 *   - 目录（含 node_modules）：junction 指向真实目录（只读引用，沙盒只新增文件）
 *   - 文件：真实拷贝（这样沙盒内修改不影响源仓）
 *   - 候选文件：写入 candidate
 */
function mirrorTree(
  realRoot: string,
  sandbox: string,
  targetAbs: string,
  candidate: string,
  stopRoot: string,
): void {
  fs.mkdirSync(sandbox, { recursive: true })
  const entries = fs.readdirSync(realRoot, { withFileTypes: true })
  for (const e of entries) {
    const real = path.join(realRoot, e.name)
    const virt = path.join(sandbox, e.name)
    if (e.isDirectory()) {
      // 候选文件不在 stopRoot 之上：只有 stopRoot 内的目录需要真拷贝结构
      if (isAncestorOrSelf(real, stopRoot)) {
        mirrorTree(real, virt, targetAbs, candidate, stopRoot)
      } else {
        junction(real, virt)
      }
    } else if (e.isFile()) {
      if (path.resolve(real) === path.resolve(targetAbs)) {
        fs.writeFileSync(virt, candidate, 'utf8')
      } else {
        fs.copyFileSync(real, virt)
      }
    }
  }
}

function isAncestorOrSelf(maybeAncestor: string, target: string): boolean {
  const rel = path.relative(maybeAncestor, target)
  // rel === '' 表示 self：也要算（根级文件时 realRoot 就是文件所在目录）
  return !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

function junction(real: string, virt: string): void {
  try {
    fs.symlinkSync(real, virt, 'junction')
  } catch {
    // junction 失败（少见）→ 退化为递归拷贝目录
    try {
      fs.cpSync(real, virt, { recursive: true, dereference: false })
    } catch {
      // 实在不行建空目录，验证器仍可能因缺依赖而失败——失败即重试
      fs.mkdirSync(virt, { recursive: true })
    }
  }
}

function removeJunctionDir(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.lstatSync(p).isSymbolicLink()) {
        fs.unlinkSync(p)
      } else {
        fs.rmSync(p, { recursive: true, force: true })
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort 清理
  }
}
