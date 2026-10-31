/**
 * dsh-omni-fixer —— 万法归宗·全自动代码修复流水线
 *
 * 五级模块 + 总闸：
 *   omni_scan（AST 嗅探 + 工具链权威扫）
 *   → omni_isolate（外科手术级错误修复契约）
 *   → omni_heal（强弱模型路由 + 规则引擎秒修）
 *   ⇄ omni_verify（物理沙盒验证闸门）
 *   → omni_report（战报）
 *   + omni_fix（一键全自动总闸）
 *
 * 插件契约（dsh-plugin-guide 红线）：
 *  - 导出 name + apply(ctx, config)；依赖服务在 apply 前就绪、消失自动卸载。
 *  - 注册即 effect：工具注册放在 apply 内、ctx.tools.register 完成。
 *  - 可选服务（subprocess）经 ctx.get 取，缺席降级 child_process。
 *  - 配置只可能来自 Schemastery Config（用户在 设置 → 插件配置 → Omni-Fixer 调）。
 *  - API key 不进 cordis.patch.yml：走插件配置卡片（secret 字段）或环境变量。
 */
import type { Context, Dispose, Logger } from '@deepseek-ai/cordis'
import { Config, resolvePluginConfig, type ConfigType } from './config.js'
import { createTools, type ToolDeps } from './tools.js'

export const name = 'dsh-omni-fixer'

export const inject = ['tools']

export { Config }

export function apply(ctx: Context, config: ConfigType = {}): Dispose | void {
  type BrandedLogger = Logger & { warn: Logger; error: Logger; debug: Logger; info: Logger }
  const logger: BrandedLogger | undefined =
    'logger' in ctx && typeof (ctx as { logger?: unknown }).logger === 'function'
      ? ((ctx as { logger: (name: string) => BrandedLogger }).logger as (name: string) => BrandedLogger)('omni-fixer')
      : undefined
  const log = (message: string) => logger?.debug?.(message)

  const deps: ToolDeps = {
    hostSpawn: resolveHostSpawn(ctx),
    log,
  }

  const tools = (ctx as unknown as {
    tools: { register: (tool: unknown) => { dispose?: Dispose } | void }
  }).tools
  for (const tool of createTools(config, deps)) {
    tools.register(tool)
  }
}

/**
 * 宿主 subprocess 服务是**可选**的：core 层自带 child_process 后端，
 * 缺服务时整插件仍正常工作（只是不走宿主的凭据擦洗与托管 kill）。
 * 用 ctx.get 而非 ctx.<service> —— 后者对未声明服务抛错并可能静默杀掉插件。
 */
function resolveHostSpawn(ctx: Context): ((spec: unknown) => unknown) | undefined {
  try {
    const subprocess = (ctx as unknown as {
      get?: (name: string) => { spawn?: (spec: unknown) => unknown } | undefined
    }).get?.('subprocess')
    if (subprocess && typeof subprocess.spawn === 'function') return subprocess.spawn
    return undefined
  } catch {
    return undefined
  }
}

// 让 resolvePluginConfig 保持导出，给 tools.ts 与测试共用。
export { resolvePluginConfig }
