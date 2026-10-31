/**
 * omni_heal —— 自适应模型路由。
 *
 * 策略（对应任务书"强弱混合调用"）：
 *   1. 规则引擎能修的（机械错误）→ 本地秒修，零 token。
 *   2. 修不了 → trivial（语法错误）→ 弱模型（Atria-Dawn 一类），便宜量大。
 *   3. moderate/hard（类型错误 / 测试失败 / 逻辑错误）→ 强模型（deepseek-v4.1 一类），
 *      且强制携带本地失败堆栈。
 *
 * 规则通道一旦验证失败，升级路径为：rule-engine → weak → strong。
 */
import type { Complexity, FixChannel } from '../core/types.js'
import { ruleEngineCanHandle } from './rules.js'
import { ENV_STRONG_MODEL, ENV_WEAK_MODEL } from './llm.js'

export interface ModelNames {
  weak: string
  strong: string
}

export interface RouteConfig {
  models: ModelNames
}

export function resolveModelNames(cfg: Partial<ModelNames> = {}): ModelNames {
  return {
    weak: cfg.weak || process.env[ENV_WEAK_MODEL] || 'Atria-Dawn',
    strong: cfg.strong || process.env[ENV_STRONG_MODEL] || 'deepseek-v4.1',
  }
}

export function routeContract(
  complexity: Complexity,
  contract: import('../core/types.js').FixContract,
  escalateFrom?: FixChannel,
): FixChannel {
  if (escalateFrom === 'rule-engine') return complexity === 'trivial' ? 'weak-model' : 'strong-model'
  if (escalateFrom === 'weak-model') return 'strong-model'
  if (ruleEngineCanHandle(contract)) return 'rule-engine'
  return complexity === 'trivial' ? 'weak-model' : 'strong-model'
}

export function channelToModel(channel: FixChannel, names: ModelNames): string {
  switch (channel) {
    case 'rule-engine':
      return 'rule-engine'
    case 'weak-model':
      return names.weak
    case 'strong-model':
      return names.strong
  }
}
