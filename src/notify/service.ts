import type { Context } from '@deepseek-ai/cordis'
import { ConfigError, KitError, type KitErrorOptions } from '../common/errors.js'
import { digest } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import type { DingtalkAt, DingtalkTarget } from '../dingtalk/args.js'
import type { DingtalkService } from '../dingtalk/service.js'
import type { FeishuAt, FeishuTarget } from '../feishu/args.js'
import type { FeishuService } from '../feishu/service.js'
import { NotifyConfig, assertNotifyConfig, type NotifyChannel } from './config.js'

export type NotifyErrorCode = 'channel_unavailable' | 'all_failed'

export class NotifyError extends KitError {
  declare readonly code: NotifyErrorCode

  constructor(code: NotifyErrorCode, message: string, options: KitErrorOptions = {}) {
    super('notify', code, message, options)
    this.name = 'NotifyError'
  }
}

export interface NotifySendOptions {
  title?: string
  /** Markdown 正文，与 `text` 二选一。各渠道按自己的方式渲染。 */
  markdown?: string
  text?: string
  /** 按渠道覆盖目标；缺省用各渠道配置的 defaultTarget。 */
  targets?: { dingtalk?: DingtalkTarget; feishu?: FeishuTarget }
  /** 按渠道 @ 人（两个渠道的用户 id 体系不同）。 */
  at?: { dingtalk?: DingtalkAt; feishu?: FeishuAt }
  /** 透传给各渠道；飞书与钉钉 user 身份据此去重与重试。 */
  idempotencyKey?: string
  traceId?: string
  signal?: AbortSignal
}

export interface NotifyChannelResult {
  channel: NotifyChannel
  ok: boolean
  /** 渠道自己的逐目标结果。 */
  results?: Array<{ ok: boolean; messageId?: string; error?: KitError }>
  error?: KitError
}

export interface NotifySendResult {
  results: NotifyChannelResult[]
}

export interface NotifyCounters {
  success: number
  failure: number
  lastFailureAt: number | null
  lastErrorCode: string | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    notify: NotifyService
  }
}

type Channel = Pick<DingtalkService, 'send' | 'health'> | Pick<FeishuService, 'send' | 'health'>

/**
 * 与渠道无关的通知：业务包只调用 `ctx.notify.send()`，发到钉钉还是飞书由本行的 `channels` 决定，
 * 运维可以在设置页或 `setup` 中随时修改，不需要改业务代码。
 *
 * 不 inject 渠道服务，而是在发送时用 `ctx.get()` 取：cordis 的 inject 都是必需的，inject 了
 * 渠道就意味着停用任一渠道都会连带卸载本服务以及所有依赖它的业务插件。现在停用或切换渠道只影响
 * 发送结果（未运行的渠道报 `channel_unavailable`），业务插件不受影响。
 *
 * 修改本行自己的配置（channels / strategy）同样不重载：cordis 默认在配置变更时重启插件，进而重启
 * 所有 inject 了 notify 的业务插件；这里在本 fiber 的 `internal/update` 钩子里校验新配置并原地替换，
 * 不调用 `next()`，从而否决这次重启。
 */
export class NotifyService extends KitService<NotifyCounters> {
  static Config = NotifyConfig
  private current: NotifyConfig
  private lastSuccessAt: number | null = null
  private readonly counters: NotifyCounters = { success: 0, failure: 0, lastFailureAt: null, lastErrorCode: null }

  constructor(ctx: Context, config: NotifyConfig) {
    super(ctx, 'notify')
    this.current = checked(config)
    const self = this
    ctx.on('internal/update', function (next, _noSave, _restart) {
      // this 为本插件的 fiber；next 已经过 NotifyConfig 解析
      self.current = checked(next as NotifyConfig)
      ;(this as unknown as { config: NotifyConfig }).config = self.current
      self.logger.info('notify config updated in place', { channels: self.current.channels, strategy: self.current.strategy })
    })
  }

  /** 当前生效的配置；修改本行配置后原地更新。 */
  get config(): NotifyConfig {
    return this.current
  }

  private channel(name: NotifyChannel): Channel | undefined {
    return (this.ctx as unknown as { get(name: string): Channel | undefined }).get(name)
  }

  async send(options: NotifySendOptions): Promise<NotifySendResult> {
    const { channels, strategy } = this.config
    this.logger.info('notify send', { traceId: options.traceId, channels, strategy, body: digest(options.markdown ?? options.text ?? '') })
    const results: NotifyChannelResult[] = []
    if (strategy === 'failover') {
      for (const name of channels) {
        const r = await this.sendChannel(name, options)
        results.push(r)
        if (r.ok || options.signal?.aborted) break
      }
    } else {
      results.push(...(await Promise.all(channels.map((name) => this.sendChannel(name, options)))))
    }
    if (!results.some((r) => r.ok)) {
      const err = new NotifyError('all_failed', `notification failed on every channel: ${results.map((r) => `${r.channel}: ${r.error?.message ?? 'failed'}`).join('; ')}`, {
        details: { results: results.map((r) => ({ channel: r.channel, code: r.error?.code })) },
      })
      this.recordFailure(err.code)
      throw err
    }
    const failed = results.find((r) => !r.ok)
    if (failed) this.recordFailure(failed.error?.code ?? 'send_failed')
    else this.recordSuccess()
    return { results }
  }

  private async sendChannel(name: NotifyChannel, options: NotifySendOptions): Promise<NotifyChannelResult> {
    const svc = this.channel(name)
    if (!svc) return { channel: name, ok: false, error: new NotifyError('channel_unavailable', `${name} is not running; enable agent-kit-${name}`) }
    try {
      const common = { title: options.title, markdown: options.markdown, text: options.text, idempotencyKey: options.idempotencyKey, traceId: options.traceId, signal: options.signal }
      const r =
        name === 'dingtalk'
          ? await (svc as DingtalkService).send({ ...common, target: options.targets?.dingtalk, at: options.at?.dingtalk })
          : await (svc as FeishuService).send({ ...common, target: options.targets?.feishu, at: options.at?.feishu })
      const results = r.results.map((x) => ({ ok: x.ok, ...(x.messageId ? { messageId: x.messageId } : {}), ...(x.error ? { error: x.error } : {}) }))
      const error = results.find((x) => !x.ok)?.error
      return { channel: name, ok: !error, results, ...(error ? { error } : {}) }
    } catch (e) {
      return { channel: name, ok: false, error: e instanceof KitError ? e : new NotifyError('all_failed', (e as Error).message, { cause: e }) }
    }
  }

  private recordSuccess(): void {
    this.counters.success++
    this.lastSuccessAt = Date.now()
  }

  private recordFailure(code: string): void {
    this.counters.failure++
    this.counters.lastFailureAt = Date.now()
    this.counters.lastErrorCode = code
  }

  health(): ServiceHealth<NotifyCounters> {
    const counters = { ...this.counters }
    const missing = this.config.channels.filter((name) => !this.channel(name))
    const unhealthy = this.config.channels.filter((name) => this.channel(name)?.health().status === 'failed')
    const down = [...new Set([...missing, ...unhealthy])]
    if (down.length === this.config.channels.length) return { status: 'failed', detail: `no channel available: ${down.join(', ')}`, counters }
    if (down.length > 0) return { status: 'degraded', detail: `channel unavailable: ${down.join(', ')}`, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: `channels: ${this.config.channels.join(', ')} (${this.config.strategy})`, counters }
  }
}

function checked(config: NotifyConfig): NotifyConfig {
  try {
    assertNotifyConfig(config)
  } catch (e) {
    throw new ConfigError('notify', (e as Error).message, { field: 'channels' })
  }
  return config
}

export default NotifyService
