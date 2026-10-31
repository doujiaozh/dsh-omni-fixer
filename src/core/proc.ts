/**
 * 进程执行层：把"宿主 ctx.subprocess.spawn"与"child_process"两个后端
 * 统一成同一个 SpawnFn。核心层只依赖 SpawnFn，因此：
 *  - 在 DSH 内：享受官方子进程服务（凭据擦洗、托管 kill、DSH_* 命名空间）。
 *  - 在纯 Node（测试/CLI/无宿主）：child_process 降级，零依赖。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnFn, SpawnResult, SpawnSpec } from './types.js'

const DEFAULT_MAX_OUTPUT = 128 * 1024

interface TruncatingBuffer {
  buf: Buffer
  max: number
  dropped: boolean
}

function appendStream(state: TruncatingBuffer, chunk: Buffer): void {
  const remaining = state.max - state.buf.length
  if (remaining <= 0) {
    state.dropped = true
    return
  }
  if (chunk.length <= remaining) {
    state.buf = Buffer.concat([state.buf, chunk])
  } else {
    // 只保留尾部：截断窗口的 head 丢弃，保留最新 max 字节
    const overflow = chunk.length - remaining
    const merged = Buffer.concat([state.buf, chunk.subarray(0, remaining)])
    const tail = chunk.subarray(overflow)
    state.buf = Buffer.concat([merged.subarray(tail.length), tail])
    state.dropped = true
  }
}

function bufferText(state: TruncatingBuffer): string {
  let text = state.buf.toString('utf8')
  if (state.dropped) text = `…(output truncated, tail kept)…\n${text}`
  return text
}

/**
 * child_process 后端。argv[0] 必须是可直接执行的真实文件
 * （.cmd/.bat 需另行包装；本插件的工具链一律组装成 node/python 直调）。
 */
export function nodeSpawnFn(): SpawnFn {
  return (spec: SpawnSpec) =>
    new Promise<SpawnResult>((resolve) => {
      const maxOut = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
      const outState: TruncatingBuffer = { buf: Buffer.alloc(0), max: maxOut, dropped: false }
      const errState: TruncatingBuffer = { buf: Buffer.alloc(0), max: maxOut, dropped: false }

      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const [k, v] of Object.entries(spec.env ?? {})) {
        if (v === undefined) delete env[k]
        else env[k] = v
      }
      // Node ≥20 的 test runner 会在环境里放 NODE_TEST_CONTEXT；子进程若继承到它，
      // `node --test` 会误判为“在测试文件内递归调用 run()”而直接跳过所有测试文件
      // （退出码 0、无任何输出）。本流水线派生的工具链进程一律擦除该继承上下文。
      delete env.NODE_TEST_CONTEXT

      let timedOut = false
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      if (spec.timeoutMs && spec.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, spec.timeoutMs)
      }
      // 外部信号联动
      if (spec.signal) {
        if (spec.signal.aborted) controller.abort()
        else spec.signal.addEventListener('abort', () => controller.abort(), { once: true })
      }

      let child: ReturnType<typeof nodeSpawn>
      try {
        child = nodeSpawn(spec.argv[0] as string, spec.argv.slice(1), {
          cwd: spec.cwd,
          env,
          windowsHide: true,
          signal: controller.signal,
          killSignal: 'SIGTERM',
        })
      } catch (err) {
        if (timer) clearTimeout(timer)
        resolve({
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: `spawn failed: ${(err as Error).message}`,
          timedOut: false,
        })
        return
      }

      const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (timer) clearTimeout(timer)
        controller.abort()
        resolve({
          exitCode,
          signal,
          stdout: bufferText(outState),
          stderr: bufferText(errState),
          timedOut,
        })
      }

      child.stdout?.on('data', (c: Buffer) => appendStream(outState, c))
      child.stderr?.on('data', (c: Buffer) => appendStream(errState, c))
      child.on('error', (err) => {
        settle(null, null)
        void err
      })
      child.on('close', (code, sig) => settle(code, sig))
    })
}

/**
 * 宿主 ctx.subprocess.spawn 的适配器。传入从 ctx.get('subprocess')
 * 取到的 spawn 函数；core 层不 import 任何宿主类型。
 *
 * 宿主规范要点（见 DSH subprocess 文档）：
 *  - spawn 同步返回 handle，handle.done 给出退出事实（exitCode/signal）
 *  - collect 模式的 reader 以字节偏移读取、互不干扰；结算后仍可读
 *  - signal 触发托管范围内的终止升级
 */
export function hostSpawnFn(hostSpawn: (spec: unknown) => unknown): SpawnFn {
  return async (spec: SpawnSpec) => {
    const maxOut = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
    let externalController: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      const controller = new AbortController()
      if (spec.timeoutMs && spec.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, spec.timeoutMs)
      }
      if (spec.signal) {
        if (spec.signal.aborted) controller.abort()
        else {
          externalController = new AbortController()
          spec.signal.addEventListener(
            'abort',
            () => {
              timedOut = timedOut || spec.signal?.aborted === true
              externalController!.abort()
            },
            { once: true },
          )
          externalController.signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
      }

      const handle = hostSpawn({
        argv: [...spec.argv],
        cwd: spec.cwd,
        stdio: {
          stdin: 'ignore' as const,
          stdout: { maxBytes: maxOut } as const,
          stderr: { maxBytes: maxOut } as const,
        },
        graceMs: 3000,
        signal: controller.signal,
        // cf. nodeSpawnFn：擦除 Node test runner 的继承上下文，防 `node --test` 递归误判。
        env: { ...spec.env, NODE_TEST_CONTEXT: undefined } as Record<
          string,
          string | undefined
        >,
      }) as {
        done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
        collected?: {
          stdout?: { readFrom: (n: number) => { text: string } }
          stderr?: { readFrom: (n: number) => { text: string } }
        }
      }

      const outcome = await handle.done
      const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      if (timer) clearTimeout(timer)
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout,
        stderr,
        timedOut: timedOut || controller.signal.aborted === true,
      }
    } catch (err) {
      if (timer) clearTimeout(timer)
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: `spawn failed: ${(err as Error).message}`,
        timedOut: false,
      }
    }
  }
}

/** 选后端：宿主 spawn 存在则用宿主，否则 child_process。 */
export function resolveSpawnFn(spawn?: (spec: unknown) => unknown): SpawnFn {
  if (typeof spawn === 'function') return hostSpawnFn(spawn as (spec: unknown) => unknown)
  return nodeSpawnFn()
}
