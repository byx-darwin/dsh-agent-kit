import { redact, redactValue } from './redact.js'

export type ServiceName = 'agentWs' | 'dingtalk' | 'agentTasks' | 'jev' | 'kit'

const KIT_ERROR = Symbol.for('@mc/dsh-agent-kit/KitError')

export interface KitErrorOptions {
  retryable?: boolean
  cause?: unknown
  /** 附加的结构化信息（会被脱敏）。 */
  details?: Record<string, unknown>
}

/**
 * 本包所有错误的基类。业务包用 {@link isKitError} 与 `code` 判断，不依赖 `instanceof`。
 * 构造时对 message 与 cause 统一脱敏。
 */
export class KitError extends Error {
  readonly service: ServiceName
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  declare readonly cause?: unknown

  constructor(service: ServiceName, code: string, message: string, options: KitErrorOptions = {}) {
    super(redact(message))
    this.name = 'KitError'
    this.service = service
    this.code = code
    this.retryable = options.retryable ?? false
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: redactValue(options.cause), enumerable: false, writable: true, configurable: true })
    }
    if (options.details) this.details = redactValue(options.details) as Record<string, unknown>
    Object.defineProperty(this, KIT_ERROR, { value: true })
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      service: this.service,
      code: this.code,
      retryable: this.retryable,
      message: this.message,
      details: this.details,
      cause: this.cause,
    }
  }
}

export function isKitError(e: unknown): e is KitError {
  return typeof e === 'object' && e !== null && (e as Record<symbol, unknown>)[KIT_ERROR] === true
}

/** 配置或环境变量非法时抛出，导致对应 Service 启动失败。 */
export class ConfigError extends KitError {
  constructor(service: ServiceName, message: string, details?: Record<string, unknown>) {
    super(service, 'invalid_config', message, { retryable: false, details })
    this.name = 'ConfigError'
  }
}

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/** Config 的用户输入形态：有默认值的字段可省略，`K` 为必填字段。 */
export type ConfigInput<T, K extends keyof T = never> = DeepPartial<Omit<T, K>> & Pick<T, K>
