/**
 * omni_heal —— LLM 客户端（OpenAI Chat Completions 兼容）。
 *
 * 纯 node:http / node:https 实现，零第三方依赖：
 *   - 兼容 DeepSeek 官方 API、OpenAI、vLLM、ollama、any-openai-compatible 网关
 *   - 凭据优先级：config.llm.* → 环境变量 OMNI_LLM_BASE_URL / OMNI_LLM_API_KEY
 *   - 支持超时与 AbortSignal（工具取消时分发）
 *
 * 不在 config 里放明文 key 也能工作：环境变量是推荐方式。
 */
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

export interface LlmConfig {
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmResult {
  ok: boolean
  content?: string
  error?: string
  model?: string
  usage?: { prompt: number; completion: number }
}

export const ENV_BASE_URL = 'OMNI_LLM_BASE_URL'
export const ENV_API_KEY = 'OMNI_LLM_API_KEY'
export const ENV_WEAK_MODEL = 'OMNI_LLM_WEAK_MODEL'
export const ENV_STRONG_MODEL = 'OMNI_LLM_STRONG_MODEL'

/** 读环境变量兜底（config 为空时与 config 合并）。 */
export function resolveLlmConfig(cfg: LlmConfig = {}): Required<Pick<LlmConfig, 'baseUrl' | 'timeoutMs'>> & {
  apiKey: string | undefined
} {
  const baseUrl = (cfg.baseUrl || process.env[ENV_BASE_URL] || '').trim()
  const apiKey = (cfg.apiKey || process.env[ENV_API_KEY] || '').trim() || undefined
  const timeoutMs = cfg.timeoutMs ?? 120_000
  return { baseUrl, apiKey, timeoutMs }
}

function endpointOf(baseUrl: string): URL {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(trimmed)) return new URL(trimmed)
  return new URL(`${trimmed}/chat/completions`)
}

export async function chatCompletion(
  model: string,
  messages: LlmMessage[],
  cfg: LlmConfig = {},
  signal?: AbortSignal,
): Promise<LlmResult> {
  const resolved = resolveLlmConfig(cfg)
  if (!resolved.baseUrl) {
    return { ok: false, error: 'LLM endpoint not configured (set llm.baseUrl or OMNI_LLM_BASE_URL)' }
  }
  const url = endpointOf(resolved.baseUrl)
  const body = JSON.stringify({
    model,
    messages,
    temperature: 0,
    stream: false,
  })

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  if (resolved.timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), resolved.timeoutMs)
  }
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  return new Promise<LlmResult>((resolve) => {
    const transport = url.protocol === 'http:' ? http : https
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'dsh-omni-fixer/0.1',
    }
    if (resolved.apiKey) headers.authorization = `Bearer ${resolved.apiKey}`

    let done = false
    const finish = (r: LlmResult) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }

    const req = transport.request(
      url,
      {
        method: 'POST',
        headers,
        signal: controller.signal,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode === undefined || res.statusCode >= 400) {
            finish({
              ok: false,
              error: `LLM endpoint ${res.statusCode}: ${truncate(text, 500)}`,
            })
            return
          }
          try {
            const json = JSON.parse(text)
            const content = json?.choices?.[0]?.message?.content
            if (typeof content !== 'string') {
              finish({ ok: false, error: `LLM returned no message content: ${truncate(text, 300)}` })
              return
            }
            const usage = json?.usage
            finish({
              ok: true,
              content,
              model: json?.model ?? model,
              usage: {
                prompt: Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0),
                completion: Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0),
              },
            })
          } catch (err) {
            finish({ ok: false, error: `LLM response not JSON: ${truncate(text, 300)}` })
          }
        })
      },
    )
    req.on('error', (err) => {
      finish({ ok: false, error: `LLM request failed: ${err.message}` })
    })
    req.on('close', () => {
      // 连接关闭但未 end： Conservative 兜底
      finish({ ok: false, error: 'LLM connection closed before response' })
    })
    req.end(body)
  })
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
