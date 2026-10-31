/**
 * DSH Omni-Fixer — 核心类型。
 *
 * 本文件是整条流水线的"通用语言"：scan → isolate → heal → verify → reporter
 * 五级之间只通过这里定义的结构通信。core 层不依赖任何 DSH / cordis API，
 * 因此可以在纯 Node.js 环境（测试、CI、CLI）中独立运行。
 */

/** 严重级别。只有 error 级别的诊断会进入修复流水线。 */
export type Severity = 'error' | 'warning'

/** 目标文件的语言分类，决定扫描器与验证器的路由。 */
export type Language = 'js' | 'ts' | 'jsx' | 'tsx' | 'mjs' | 'cjs' | 'py' | 'other'

/** 诊断来源：本地 AST 规则或具体工具链。 */
export type DiagnosticSource =
  | 'ast'
  | 'tsc'
  | 'vitest'
  | 'pytest'
  | 'node-check'
  | 'node-test'
  | 'py-compile'
  | 'unknown'

/** 契约复杂度：决定路由到弱模型还是强模型。 */
export type Complexity = 'trivial' | 'moderate' | 'hard'

/** 修复通道：本地规则引擎 / 弱模型 / 强模型。 */
export type FixChannel = 'rule-engine' | 'weak-model' | 'strong-model'

/** 验证策略：auto = 沙盒优先、不可用时原地；sandbox = 强制沙盒；inplace = 强制原地。 */
export type VerifyStrategy = 'auto' | 'sandbox' | 'inplace'

/** 单条诊断：一个"错误原子"。 */
export interface Diagnostic {
  /** 稳定 id：source:rule:file:line:col 的 sha256 前 12 位，重跑同文件结果一致。 */
  id: string
  source: DiagnosticSource
  /** 规则 id（AST 规则或工具链错误码，如 TS2304）。 */
  rule?: string
  /** 逻辑错误级别：syntax（语法/词法）/ type（类型）/ test（测试失败）/ runtime。 */
  kind: 'syntax' | 'type' | 'test' | 'runtime'
  /** 项目相对路径（posix 风格）。 */
  file: string
  /** 1-based 行号。0 表示未知（如 pytest 的 FAILED 仅知道测试名）。 */
  line: number
  /** 1-based 列号。 */
  column: number
  endLine?: number
  severity: Severity
  message: string
  /** 关联的失败测试名（vitest / pytest 诊断）。 */
  test?: string
}

export interface ScanResult {
  root: string
  filesScanned: number
  linesScanned: number
  diagnostics: Diagnostic[]
  /** 被跳过的文件（超大 / 二进制 / 权限）。 */
  skipped: { path: string; reason: string }[]
  /** 各来源诊断计数。 */
  bySource: Record<string, number>
  /** 各错误级别计数。 */
  byKind: Record<string, number>
  /** 工具链扫描时的原始输出摘要（排障用）。 */
  toolchainNotes: string[]
}

/** 验证规格：怎么证明这一份补丁是"绿"的。 */
export interface VerifySpec {
  kind: 'auto' | 'tsc' | 'py-compile' | 'node-check' | 'node-test' | 'vitest' | 'pytest' | 'custom'
  /** custom 模式下的完整 argv；其他模式由验证器自行组装。 */
  argv?: string[]
  /** 命令的工作目录（项目根）。 */
  cwd: string
  /** 生效的环境变量（如 OMNI_FIX_* 透传）。 */
  env?: Record<string, string>
}

/**
 * 错误修复契约（Error Fix Contract）。
 *
 * 这是"万法归宗"的核心机制：把 N 万行项目中的某个错误压缩成一份
 * 模型只需要看 contextLines 行就能下决断的隔离任务。契约明确告诉模型：
 * 只看这段代码、只解决这个报错、不要重构、不要改其他行。
 */
export interface FixContract {
  id: string
  diagnosticIds: string[]
  /** 项目相对路径。 */
  file: string
  /** 绝对路径（验证器/落盘用）。 */
  absolutePath: string
  language: Language
  /** 代码窗口起止行（1-based, inclusive）。 */
  startLine: number
  endLine: number
  /** 带 LLL │ 前缀的代码窗口。 */
  snippet: string
  /** 序列化的报错文本（误差行:列 + message）。 */
  errorText: string
  /** 提交给模型的硬约束清单。 */
  rules: string[]
  /** 本契约涉及的诊断规则 id（如 'js/unclosed-bracket'、'TS2304'）。供路由与规则引擎使用。 */
  errorRules: string[]
  /** 验证规格。 */
  verify: VerifySpec
  complexity: Complexity
  /** 契约影响的目标测试（若有）。 */
  tests: string[]
  /** 文件总行数。 */
  totalLines: number
}

export interface ModelUsage {
  prompt: number
  completion: number
  calls: number
}

export interface FixAttempt {
  contractId: string
  round: number
  /** 实际执行修复的通道。 */
  channel: FixChannel
  /** 模型名（rule-engine 时为 'rule-engine'）。 */
  model: string
  /** 整文件候选内容（full / range 两种模式下都是"写盘前"的完整文件）。 */
  patch?: string
  /** full = 整文件替换；range = 窗口替换。 */
  patchMode: 'full' | 'range'
  /** 该轮提示词携带的上一轮失败反馈（重试语义）。 */
  feedback?: string
  usage?: { prompt: number; completion: number }
  /** 验证闸门结果（toFixAttempt 后由 pipeline 回填）。 */
  verifyExitCode?: number | null
  verifyOutput?: string
  ok?: boolean
  failureReason?: string
}

export interface ContractResult {
  contractId: string
  file: string
  status: 'applied' | 'failed' | 'skipped' | 'dry-run'
  attempts: FixAttempt[]
  /** 成功应用的通道。 */
  appliedVia?: FixChannel
  appliedModel?: string
  /** finalVerifyExitCode。 */
  finalError?: string
}

export interface RescanSummary {
  before: number
  after: number
  healed: number
  /** 修复后仍然报错的诊断（仅 error 级）。 */
  remaining: Diagnostic[]
}

export interface RunStats {
  runId: string
  root: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  dryRun: boolean
  scan: {
    filesScanned: number
    linesScanned: number
    diagnosticsFound: number
    bySource: Record<string, number>
    byKind: Record<string, number>
  }
  contracts: {
    total: number
    byComplexity: Record<string, number>
  }
  attempts: number
  rulesFired: number
  modelCalls: number
  results: ContractResult[]
  rescan?: RescanSummary
  tokens: {
    prompt: number
    completion: number
    byModel: Record<string, ModelUsage>
  }
  /** 非致命问题收集（模型不可达、沙盒降级等）。 */
  notes: string[]
}

/** 流水线内部的可注入依赖：把宿主能力（子进程）与核心解耦。 */
export interface PipelineDeps {
  /** 宿主 ctx.subprocess.spawn（DSH 内）或 child_process 等价物（独立运行时）。 */
  spawn?: SpawnFn
  /** 由宿主提供的 AbortSignal（工具取消时分发）。 */
  signal?: AbortSignal
  /** 进度回调（战报/UI 用），返回的字符串写入日志。 */
  onProgress?: (message: string) => void
}

/** 与 SubprocessSpawnSpec 同构的最小 spawn 描述。 */
export interface SpawnSpec {
  argv: readonly string[]
  cwd: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  signal?: AbortSignal
  /** 每条流最多保留的尾部字节数。 */
  maxOutputBytes?: number
}

export interface SpawnResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SpawnFn {
  (spec: SpawnSpec): Promise<SpawnResult>
}
