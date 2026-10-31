/**
 * Compile-time stub for @deepseek-ai/dsh-tools.
 *
 * The real package is a peer dependency resolved at runtime from the DSH host.
 * Declares only the `defineTool` surface this plugin consumes; parameter and
 * output schemas follow the DSH tool DSL (not raw JSON Schema).
 */
declare module '@deepseek-ai/dsh-tools' {
  export interface ToolExec {
    signal: AbortSignal
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly agent?: any
    readonly token?: unknown
  }

  export interface ParameterSchemaSpec {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null' | 'any'
    required?: boolean
    description?: string
    items?: ParameterSchemaSpec
    properties?: Record<string, ParameterSchemaSpec>
    enum?: Array<string | number>
    additionalProperties?: boolean
  }

  export interface ValueSchemaSpec {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null' | 'any' | 'json'
    items?: ValueSchemaSpec
    properties?: Record<string, ValueSchemaSpec>
    required?: string[]
    enum?: Array<string | number>
    additionalProperties?: boolean
  }

  export interface RenderedContent {
    type: 'text'
    text: string
  }

  export interface ToolDefinition {
    name: string
    description: string
    parameters: Record<string, ParameterSchemaSpec>
    output: {
      schema: ValueSchemaSpec
      render?: (args: any, value: any) => RenderedContent[]
      presentationMeta?: (args: any, value: any) => any
    }
    /** 工具执行预算（毫秒）；非正/非有限会被 defineTool 拒绝。 */
    timeoutMs?: number
    /** 声明是否可并发执行。 */
    isConcurrencySafe?: () => boolean
    execute(args: any, exec: ToolExec): Promise<any> | any
  }

  export function defineTool(definition: ToolDefinition): ToolDefinition
}

export {}
