/**
 * Compile-time stand-in for @deepseek-ai/schemastery (3.18.x).
 *
 * Declares the builder surface this plugin's Config uses. At runtime the real
 * package is resolved from the DSH host profile (schemastery is a core
 * dependency of cordis itself, so every profile has it).
 */
declare module '@deepseek-ai/schemastery' {
  interface SchemaStatic<T = any> {
    string(): SchemaInstance<T>
    number(): SchemaInstance<T>
    boolean(): SchemaInstance<T>
    object<T = any>(shape: Record<string, SchemaInstance<any>>): SchemaInstance<T>
    array<T = any>(item: SchemaInstance<any>): SchemaInstance<T[]>
    union<T = any>(choices: SchemaInstance<any>[]): SchemaInstance<T>
    const<T = any>(value: T): SchemaInstance<T>
    any<T = any>(): SchemaInstance<T>
  }

  interface SchemaInstance<T = any> {
    default(value: T): this
    description(text: string): this
    min(value: number): this
    max(value: number): this
    step(value: number): this
    required(): this
    disabled(): this
    hidden(): this
    role(name: string): this
    options(list: Array<string | { label?: string; value: any }>): this
    volatile(): this
  }

  namespace Schema {
    type infer<S extends SchemaInstance<any>> = S extends SchemaInstance<infer T> ? T : never
  }

  const Schema: SchemaStatic & SchemaInstance
  export default Schema
  export { SchemaInstance, SchemaStatic }
}

export {}
