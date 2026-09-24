import { Service, type Context } from '@deepseek-ai/cordis'
import type { ServiceName } from './errors.js'
import type { KitLogger } from './logger.js'
import { redact, redactValue } from './redact.js'

export type HealthStatus = 'ok' | 'degraded' | 'failed'

export interface ServiceHealth<C = Record<string, unknown>> {
  status: HealthStatus
  detail: string
  counters: C
}

export interface ServiceFailedEvent {
  service: ServiceName
  detail: string
  error?: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 任一 Service 状态变为 `failed` 时触发。 */
    'agent-kit/service-failed'(event: ServiceFailedEvent): void
  }
}

/** 把 cordis logger 适配为结构化、已脱敏的 {@link KitLogger}。 */
export function createKitLogger(ctx: Context, name: string): KitLogger {
  const logger = ctx.logger(name)
  const format = (message: string, fields?: Record<string, unknown>) =>
    fields && Object.keys(fields).length > 0 ? `${redact(message)} ${JSON.stringify(redactValue(fields))}` : redact(message)
  return {
    debug: (message, fields) => logger.debug('%s', format(message, fields)),
    info: (message, fields) => logger.info('%s', format(message, fields)),
    warn: (message, fields) => logger.warn('%s', format(message, fields)),
    error: (message, fields) => logger.error('%s', format(message, fields)),
  }
}

/** 四个 Service 的公共基类：健康状态与 `agent-kit/service-failed` 事件。 */
export abstract class KitService<C = Record<string, unknown>> extends Service {
  protected readonly logger: KitLogger
  private failedDetail?: string

  protected constructor(
    ctx: Context,
    readonly serviceName: ServiceName,
  ) {
    super(ctx, serviceName)
    this.logger = createKitLogger(ctx, `agent-kit:${serviceName}`)
  }

  abstract health(): ServiceHealth<C>

  /** 标记为 failed；只在状态从非 failed 变为 failed 时触发一次事件。 */
  protected markFailed(detail: string, error?: unknown): void {
    const transitioned = this.failedDetail === undefined
    this.failedDetail = redact(detail)
    if (!transitioned) return
    this.logger.error('service failed', { detail, error: redactValue(error) })
    const event: ServiceFailedEvent = { service: this.serviceName, detail: this.failedDetail }
    if (error !== undefined) event.error = redactValue(error)
    this.ctx.emit('agent-kit/service-failed', event)
  }

  protected clearFailed(): void {
    if (this.failedDetail !== undefined) this.logger.info('service recovered')
    this.failedDetail = undefined
  }

  protected get failure(): string | undefined {
    return this.failedDetail
  }
}
