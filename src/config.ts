/**
 * 插件配置（Schemastery Schema）。
 *
 * 红线：配置不得硬编码可调参数 —— 这里是所有可调参数的唯一真源；
 * 模型 API key 走 `llm.apiKey`（secret 角色，进宿主凭据存储）
 * 或环境变量 OMNI_LLM_API_KEY（推荐，见 README）。
 */
import s, { type SchemaInstance } from '@deepseek-ai/schemastery'

export const Config: SchemaInstance = s.object({
  /** 契约上下文窗口：错误位置上/下各取多少行。任务书要求 ≤ 50。 */
  contextLines: s.number().default(50).description('契约上下文窗口（错误位置上/下各多少行），50 行是任务书基线'),
  /** 每份契约的重试上限（含通道升级 rule→weak→strong）。 */
  maxRetries: s.number().default(3).description('每份契约的重试上限，含通道升级（rule-engine → weak → strong）'),
  /** 整文件替换的行数阈值：文件不超过该行数时让模型输出整文件，否则走窗口替换。 */
  maxFullFileLines: s.number().default(400).description('整文件替换的行数阈值，超出走窗口替换'),
  /** 窗口替换允许的行数漂移（幻觉闸门）。 */
  allowedDrift: s.number().default(3).description('窗口替换允许的行数漂移，超出即拒写（防幻觉重排）'),
  /** 验证策略：auto 沙盒优先 / sandbox 强制沙盒 / inplace 强制原地。 */
  verifyStrategy: s
    .union([s.const('auto'), s.const('sandbox'), s.const('inplace')])
    .default('auto')
    .description('验证策略：auto=沙盒优先不可用则原地，sandbox=强制沙盒，inplace=强制原地'),
  /** Dry run：整条流水线照跑、验证照过，但不落盘。 */
  dryRun: s.boolean().default(false).description('Dry run：扫描+验证+战报照常，但不写任何源文件'),
  /** 最多处理的契约数（0 = 不限）。大项目先小批试跑用。 */
  maxContracts: s.number().default(0).description('最多处理的契约数，0 = 不限（大项目分批跑用）'),
  /** 扫描文件数上限。 */
  maxFiles: s.number().default(20000).description('扫描文件数上限（含子目录遍历总量）'),
  /** 逐文件兜底检查（node --check / py_compile）的文件上限。 */
  maxFileToolchainChecks: s.number().default(1500).description('逐文件兜底检查的文件上限，超过则跳过兜底'),
  /** 是否运行工具链权威扫（tsc/vitest/pytest/node-test）。 */
  scanToolchain: s.boolean().default(true).description('是否运行工具链权威扫描（tsc / vitest / pytest / node --test）'),
  /** 额外包含的 glob（为空 = 全扫）。 */
  include: s.array(s.string()).default([]).description('额外包含的 glob（空 = 扫全部源码文件）'),
  /** 额外排除的 glob（叠加在内置排除表之上）。 */
  exclude: s.array(s.string()).default([]).description('额外排除的 glob（叠加在内置排除表 node_modules/.git/ 等之上）'),
  /** 战报目录；空 = 项目根下 .omni-fix-report。 */
  reportDir: s.string().default('').description('战报输出目录，空 = <项目根>/.omni-fix-report'),
  llm: s.object({
    baseUrl: s.string().default('').description('OpenAI 兼容网关地址（空 = 环境变量 OMNI_LLM_BASE_URL，再空 = https://api.deepseek.com）'),
    apiKey: s.string().role('secret').default('').description('API Key（留空请用环境变量 OMNI_LLM_API_KEY）'),
    weakModel: s.string().default('').description('弱模型名（空 = Atria-Dawn 或环境变量 OMNI_LLM_WEAK_MODEL）'),
    strongModel: s.string().default('').description('强模型名（空 = deepseek-v4.1 或环境变量 OMNI_LLM_STRONG_MODEL）'),
    timeoutMs: s.number().default(120000).description('模型调用超时（毫秒）'),
  }),
})

export type ConfigType = s.infer<typeof Config>

/**
 * 把宿主传来的（或测试里手写的）配置补齐成流水线要的形状。
 * apply() 在没有宿主的场景也会被调用，因此显式兜底而非依赖 schema resolve。
 */
export function resolvePluginConfig(config: Partial<ConfigType> = {}): ConfigType {
  const llm = config.llm ?? {}
  return {
    contextLines: config.contextLines ?? 50,
    maxRetries: config.maxRetries ?? 3,
    maxFullFileLines: config.maxFullFileLines ?? 400,
    allowedDrift: config.allowedDrift ?? 3,
    verifyStrategy: config.verifyStrategy ?? 'auto',
    dryRun: config.dryRun ?? false,
    maxContracts: config.maxContracts ?? 0,
    maxFiles: config.maxFiles ?? 20000,
    maxFileToolchainChecks: config.maxFileToolchainChecks ?? 1500,
    scanToolchain: config.scanToolchain ?? true,
    include: config.include ?? [],
    exclude: config.exclude ?? [],
    reportDir: config.reportDir ?? '',
    llm: {
      baseUrl: llm.baseUrl ?? '',
      apiKey: llm.apiKey ?? '',
      weakModel: llm.weakModel ?? '',
      strongModel: llm.strongModel ?? '',
      timeoutMs: llm.timeoutMs ?? 120000,
    },
  }
}
