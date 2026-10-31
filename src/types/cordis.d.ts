/**
 * Compile-time stub for @deepseek-ai/cordis.
 *
 * The real package is a peer dependency resolved at runtime from the DSH host.
 * This declaration exists so `tsc` can type-check this plugin without an npm
 * install (Win7 / offline friendly). It intentionally declares only the narrow
 * surface this plugin consumes.
 */
declare module '@deepseek-ai/cordis' {
  export interface Dispose {
    (): void
  }

  export interface Effect {
    (callback: () => void | Dispose): Dispose
  }

  export type Logger = (...args: any[]) => void

  export interface Context {
    effect: Effect
    on(name: string, listener: any, ...args: any[]): Dispose
    emit(name: string, ...args: any[]): void
    waterfall<T>(name: string, payload: T, init: any): Promise<T>
    get<T = any>(name: string): T | undefined
    logger(label: string): Logger & { warn: Logger; error: Logger; debug: Logger; info: Logger }
  }

  export interface Service {
    constructor(ctx: Context, name?: string): void
  }
}

export {}
