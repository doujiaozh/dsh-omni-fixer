/**
 * omni_heal —— 自适应修复执行器。
 *
 * 一次调用 = 一份契约 × 一个通道（规则引擎 / 弱模型 / 强模型）：
 *   1. 组装提示词（契约 + 反馈）
 *   2. 调用通道拿到"替换内容"
 *   3. 把替换内容规范成"整文件候选"（range 模式做窗口拼接 + 行数漂移校验）
 * 候选是否合格由 omni_verify 的物理闸门判定，本模块不做评判只做搬运。
 */
import type { FixAttempt, FixChannel, FixContract } from '../core/types.js'
import { splitLines } from '../core/util.js'
import { chatCompletion, type LlmConfig, type LlmMessage } from './llm.js'
import { channelToModel, type ModelNames, resolveModelNames } from './router.js'
import { applyRules } from './rules.js'

export interface HealDeps {
  llm: LlmConfig
  models?: Partial<ModelNames>
  allowedDrift: number
  maxFullFileLines: number
}

export interface HealInput {
  contract: FixContract
  content: string
  channel: FixChannel
  round: number
  feedback?: string
}

export interface HealOutput {
  channel: FixChannel
  model: string
  patch: string | null
  patchMode: 'full' | 'range'
  note: string
  raw?: string
  usage?: { prompt: number; completion: number }
  isError: boolean
}

const SYSTEM_PROMPT = `You are omni_heal, a surgical patch generator for the Omni-Fixer pipeline.
You receive an Error Fix Contract: a small code window plus the exact errors to fix.
You emit ONLY replacement code inside one fenced block.
- Never explain, never output markdown headings, never output line numbers.
- Never rewrite or reinterpret code outside the listed errors.
- Prefer the minimal diff that satisfies the verifier.
- If errors appear contradictory, still produce the smallest consistent change.`

function escapeFence(text: string): string {
  return text
}

export function buildPrompt(input: HealInput, opts: HealDeps): LlmMessage[] {
  const { contract } = input
  const full = contract.totalLines <= opts.maxFullFileLines
  const rangeLen = contract.endLine - contract.startLine + 1
  const messages: LlmMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  let user = `# Error Fix Contract ${contract.id}

## 文件
${contract.file}（语言 ${contract.language}，总行数 ${contract.totalLines}）

## 硬规则（违反任意一条即判失败）
${contract.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

## ERRORS（只修这些，别的什么都不要管）
${contract.errorText}

## 当前代码${full ? '（完整文件）' : `（窗口：第 ${contract.startLine} 行 ~ 第 ${contract.endLine} 行）`}
\`\`\`${contract.language}
${full ? escapeFence(input.content) : contract.snippet}
\`\`\`

## 输出格式
仅输出一个代码围栏，内容必须是纯粹的代码（无行号、无注释块标题、无说明）。
${full
  ? `围栏内容将【完整替换整个文件】，行数应接近 ${contract.totalLines}（允许偏差 ±${Math.max(10, Math.round(contract.totalLines * 0.05))}）。`
  : `围栏内容将【完整替换第 ${contract.startLine} 行到第 ${contract.endLine} 行】，行数应接近 ${rangeLen}（允许偏差 ±${opts.allowedDrift}），不要包含窗口之外的行。`}
`

  if (input.feedback) {
    user += `
## 上一轮验证失败（第 ${input.round} 轮）——你的输出被物理沙盒拒绝
${input.feedback}

请修正后重新输出完整围栏；上述契约与代码窗口仍然有效，禁止扩大修改范围。
`
  }
  messages.push({ role: 'user', content: user })
  return messages
}

const FENCE_RE = /(?:```|~~~)[a-zA-Z+#.-]*\r?\n?([\s\S]*?)(?:```|~~~)/g

export function extractCandidate(raw: string): string | null {
  const matches = [...raw.matchAll(FENCE_RE)]
  if (matches.length === 0) return null
  const candidate = matches[matches.length - 1]![1] ?? ''
  return normalizeCandidate(candidate)
}

function normalizeCandidate(text: string): string {
  let lines = splitLines(text)
  // 模型可能把契约里的行号前缀复制下来：剥掉 "  123 │ " 形式
  const lineNumbered = lines.filter((l) => /^\s{0,5}\d{1,5}\s*[│|]\s?/.test(l)).length
  if (lineNumbered >= Math.max(1, Math.ceil(lines.length / 2))) {
    lines = lines.map((l) => l.replace(/^\s{0,5}\d{1,5}\s*[│|]\s?/, ''))
  }
  // 去掉首尾空行
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines.join('\n')
}

export function applyRangePatch(
  content: string,
  candidate: string,
  startLine: number,
  endLine: number,
  allowedDrift: number,
): { ok: true; merged: string } | { ok: false; error: string } {
  const original = splitLines(content)
  const cand = splitLines(candidate)
  const rangeLen = endLine - startLine + 1
  if (Math.abs(cand.length - rangeLen) > allowedDrift) {
    return {
      ok: false,
      error: `替换块行数 ${cand.length} 与窗口 ${rangeLen} 行的偏差超过 ±${allowedDrift}——拒绝写入以防幻觉性重排。`,
    }
  }
  const head = original.slice(0, startLine - 1)
  const tail = original.slice(endLine)
  const merged = [...head, ...cand, ...tail].join('\n')
  return { ok: true, merged: content.endsWith('\n') ? merged + '\n' : merged }
}

export async function healContract(input: HealInput, deps: HealDeps): Promise<HealOutput> {
  const { contract, channel } = input
  const names = resolveModelNames(deps.models)
  const model = channelToModel(channel, names)

  if (channel === 'rule-engine') {
    const fix = applyRules(contract, input.content)
    if (fix) {
      return {
        channel,
        model,
        patch: fix.patch,
        patchMode: 'full',
        note: `规则引擎秒修: ${fix.note}`,
        isError: false,
      }
    }
    return {
      channel,
      model,
      patch: null,
      patchMode: 'full',
      note: '规则引擎声明可修但实际未产出补丁',
      isError: true,
    }
  }

  const messages = buildPrompt(input, deps)
  const result = await chatCompletion(model, messages, deps.llm)
  if (!result.ok || typeof result.content !== 'string') {
    return {
      channel,
      model,
      patch: null,
      patchMode: 'full',
      note: `模型调用失败: ${result.error ?? 'unknown'}`,
      isError: true,
      usage: result.usage,
    }
  }

  const candidate = extractCandidate(result.content)
  if (candidate === null) {
    return {
      channel,
      model,
      patch: null,
      patchMode: 'full',
      note: '模型输出中未找到代码围栏',
      raw: result.content,
      isError: true,
      usage: result.usage,
    }
  }

  const full = contract.totalLines <= deps.maxFullFileLines
  if (full) {
    return {
      channel,
      model,
      patch: candidate,
      patchMode: 'full',
      note: `整文件替换（${splitLines(candidate).length} 行）`,
      isError: false,
      usage: result.usage,
    }
  }

  const merged = applyRangePatch(
    input.content,
    candidate,
    contract.startLine,
    contract.endLine,
    deps.allowedDrift,
  )
  if (!merged.ok) {
    return {
      channel,
      model,
      patch: null,
      patchMode: 'range',
      note: merged.error,
      raw: candidate,
      isError: true,
      usage: result.usage,
    }
  }
  return {
    channel,
    model,
    patch: merged.merged,
    patchMode: 'range',
    note: `窗口替换（契约 ${contract.startLine}-${contract.endLine} → ${splitLines(candidate).length} 行）`,
    isError: false,
    usage: result.usage,
  }
}

export function toFixAttempt(input: HealInput, out: HealOutput): FixAttempt {
  return {
    contractId: input.contract.id,
    round: input.round,
    channel: input.channel,
    model: out.model,
    patch: out.patch ?? undefined,
    patchMode: out.patchMode,
    feedback: input.feedback,
    usage: out.usage,
    failureReason: out.isError ? out.note : undefined,
  }
}
