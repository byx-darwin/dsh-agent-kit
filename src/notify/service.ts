import type { Context } from '@deepseek-ai/cordis'
import type { ChannelStatus, LoginSession } from '../common/channel.js'
import { KitError, type KitErrorOptions } from '../common/errors.js'
import { digest } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import type { DingtalkAt, DingtalkTarget } from '../dingtalk/args.js'
import type { DingtalkService } from '../dingtalk/service.js'
import type { FeishuAt, FeishuTarget } from '../feishu/args.js'
import type { FeishuService } from '../feishu/service.js'
import { NOTIFY_CHANNELS, NotifyConfig, type NotifyChannel } from './config.js'

export type NotifyErrorCode = 'channel_unavailable' | 'invalid_channel'

export class NotifyError extends KitError {
  declare readonly code: NotifyErrorCode

  constructor(code: NotifyErrorCode, message: string, options: KitErrorOptions = {}) {
    super('notify', code, message, options)
    this.name = 'NotifyError'
  }
}

export interface NotifySendOptions {
  title?: string
  /** Markdown 正文，与 `text` 二选一。 */
  markdown?: string
  text?: string
  /** 按渠道给出目标，切换渠道后自动用对应的一项；缺省用该渠道配置的 defaultTarget。 */
  targets?: { dingtalk?: DingtalkTarget; feishu?: FeishuTarget }
  /** 按渠道 @ 人（两个渠道的用户 id 体系不同）。 */
  at?: { dingtalk?: DingtalkAt; feishu?: FeishuAt }
  /** 透传给渠道；飞书与钉钉 user 身份据此去重与重试。 */
  idempotencyKey?: string
  traceId?: string
  signal?: AbortSignal
}

export interface NotifySendResult {
  /** 实际发往的渠道。 */
  channel: NotifyChannel
  /** 渠道自己的逐目标结果。 */
  results: Array<{ ok: boolean; messageId?: string; error?: KitError }>
}

/** 未运行的渠道（对应的行未启用或启动失败）。 */
export interface ChannelNotRunning {
  channel: NotifyChannel
  running: false
  detail: string
}

export interface NotifyStatus {
  /** 当前生效的渠道。 */
  channel: NotifyChannel
  /** `config`：来自配置；`runtime`：运行中被 `use()` 切换过（重启或修改配置后回到配置值）。 */
  source: 'config' | 'runtime'
  /** 每个渠道的登录状态。 */
  channels: Record<NotifyChannel, (ChannelStatus & { running: true }) | ChannelNotRunning>
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

type Channel = DingtalkService | FeishuService

/**
 * 与渠道无关的通知：业务包只调用 `ctx.notify.send()`，同一时间发往一个渠道（钉钉或飞书）。
 *
 * - 切换渠道：修改本行配置的 `channel`，或在运行中调用 `use()`。两种方式都不重载本服务与依赖它的
 *   业务插件：修改配置时在本 fiber 的 `internal/update` 钩子里原地换上新值（不调用 `next()`，否决
 *   cordis 默认的重启）；`use()` 只改内存中的选择，重启或配置变更后回到配置值。
 * - 不 inject 渠道服务，而是在发送时用 `ctx.get()` 取：cordis 的 inject 都是必需的，inject 了渠道就
 *   意味着停用任一渠道都会连带卸载本服务以及所有依赖它的业务插件。
 * - `status()` 给出每个渠道的实时登录状态；`login()` / `logout()` 转给对应渠道。
 */
export class NotifyService extends KitService<NotifyCounters> {
  static Config = NotifyConfig
  private current: NotifyConfig
  private override?: NotifyChannel
  private lastSuccessAt: number | null = null
  private readonly counters: NotifyCounters = { success: 0, failure: 0, lastFailureAt: null, lastErrorCode: null }

  constructor(ctx: Context, config: NotifyConfig) {
    super(ctx, 'notify')
    this.current = config
    const self = this
    ctx.on('internal/update', function (next, _noSave, _restart) {
      // this 为本插件的 fiber；next 已经过 NotifyConfig 解析。配置是运维的最新决定，覆盖 use() 的临时选择。
      self.current = next as NotifyConfig
      self.override = undefined
      ;(this as unknown as { config: NotifyConfig }).config = self.current
      self.logger.info('notify channel updated from config', { channel: self.current.channel })
    })
  }

  get config(): NotifyConfig {
    return this.current
  }

  /** 当前生效的渠道。 */
  get channel(): NotifyChannel {
    return this.override ?? this.current.channel
  }

  /** 运行中切换渠道，立即生效；重启或修改配置后回到配置值。要长期切换请改配置。 */
  use(channel: NotifyChannel): void {
    if (!NOTIFY_CHANNELS.includes(channel)) throw new NotifyError('invalid_channel', `unknown channel ${String(channel)}`)
    this.override = channel === this.current.channel ? undefined : channel
    this.logger.info('notify channel switched at runtime', { channel })
  }

  private service(name: NotifyChannel): Channel | undefined {
    return (this.ctx as unknown as { get(name: string): Channel | undefined }).get(name)
  }

  private require(name: NotifyChannel): Channel {
    const svc = this.service(name)
    if (!svc) throw new NotifyError('channel_unavailable', `${name} is not running; enable agent-kit-${name}`, { details: { channel: name } })
    return svc
  }

  async send(options: NotifySendOptions): Promise<NotifySendResult> {
    const channel = this.channel
    this.logger.info('notify send', { traceId: options.traceId, channel, body: digest(options.markdown ?? options.text ?? '') })
    try {
      const svc = this.require(channel)
      const common = { title: options.title, markdown: options.markdown, text: options.text, idempotencyKey: options.idempotencyKey, traceId: options.traceId, signal: options.signal }
      const r =
        channel === 'dingtalk'
          ? await (svc as DingtalkService).send({ ...common, target: options.targets?.dingtalk, at: options.at?.dingtalk })
          : await (svc as FeishuService).send({ ...common, target: options.targets?.feishu, at: options.at?.feishu })
      const results = r.results.map((x) => ({ ok: x.ok, ...(x.messageId ? { messageId: x.messageId } : {}), ...(x.error ? { error: x.error } : {}) }))
      const failed = results.find((x) => !x.ok)
      if (failed) this.recordFailure(failed.error?.code ?? 'send_failed')
      else this.recordSuccess()
      return { channel, results }
    } catch (e) {
      this.recordFailure((e as KitError).code ?? 'send_failed')
      throw e
    }
  }

  /** 当前渠道与每个渠道的实时登录状态。 */
  async status(): Promise<NotifyStatus> {
    const entries = await Promise.all(
      NOTIFY_CHANNELS.map(async (name) => {
        const svc = this.service(name)
        if (!svc) return [name, { channel: name, running: false, detail: `agent-kit-${name} is not running` }] as const
        return [name, { ...(await svc.status()), running: true }] as const
      }),
    )
    return { channel: this.channel, source: this.override ? 'runtime' : 'config', channels: Object.fromEntries(entries) as NotifyStatus['channels'] }
  }

  /** 登录指定渠道（缺省为当前渠道），见各渠道的 `login()`。 */
  async login(channel: NotifyChannel = this.channel, options: { signal?: AbortSignal } = {}): Promise<LoginSession> {
    return this.require(channel).login(options)
  }

  /** 退出指定渠道（缺省为当前渠道）的登录，见各渠道的 `logout()`。 */
  async logout(channel: NotifyChannel = this.channel): Promise<ChannelStatus> {
    return this.require(channel).logout()
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
    const channel = this.channel
    const svc = this.service(channel)
    if (!svc) return { status: 'failed', detail: `channel ${channel} is not running`, counters }
    if (svc.health().status === 'failed') return { status: 'failed', detail: `channel ${channel}: ${svc.health().detail}`, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: `channel: ${channel}${this.override ? ' (runtime)' : ''}`, counters }
  }
}

export default NotifyService
