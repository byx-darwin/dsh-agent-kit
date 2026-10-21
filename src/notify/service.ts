import type { Context } from '@deepseek-ai/cordis'
import type { ChannelSendCommon, ChannelService, ChannelStatus, LoginSession } from '../common/channel.js'
import type { FeishuTarget } from '../feishu/config.js'
import type { FeishuAt } from '../feishu/message.js'
import { digest } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import type { DingtalkAt, DingtalkTarget } from '../dingtalk/args.js'
import { NOTIFY_CHANNELS, NotifyConfig, type NotifyChannel } from './config.js'
import { channelUnavailable, deliver, requireLogin, requireLogout, type NotifyDelivery } from './deliver.js'
import { NotifyError } from './errors.js'

export { NotifyError, type NotifyErrorCode } from './errors.js'

/** `targets` 中某渠道写 `'default'`：发往该渠道，并使用其配置的默认目标。 */
export const DEFAULT_TARGET = 'default' as const

/** 按渠道给出的发送目标；写 `'default'` 时该渠道使用自己配置的默认目标。 */
export interface NotifyTargets {
  dingtalk?: DingtalkTarget | typeof DEFAULT_TARGET
  feishu?: FeishuTarget | typeof DEFAULT_TARGET
}

/** 按渠道给出的 @ 人。 */
export interface NotifyAts {
  dingtalk?: DingtalkAt
  feishu?: FeishuAt
}

export interface NotifySendOptions extends ChannelSendCommon {
  /** 写了哪些渠道就只发这些渠道（值可为 'default'）；缺省或为空时发往默认渠道。 */
  targets?: NotifyTargets
  at?: NotifyAts
}

export interface NotifySendResult {
  /** 每个渠道一项，顺序与发送的渠道顺序一致。 */
  deliveries: NotifyDelivery<NotifyChannel>[]
}

/** 未运行的渠道（对应的行未启用或启动失败）。 */
export interface ChannelNotRunning {
  channel: NotifyChannel
  running: false
  detail: string
}

export interface NotifyStatus {
  defaultChannel: NotifyChannel
  /** 每个渠道是否运行及登录状态。 */
  channels: Partial<Record<NotifyChannel, (ChannelStatus & { running: true }) | ChannelNotRunning>>
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

/**
 * 通知入口：业务包调用 `ctx.notify.send()`，未指定 `targets` 时发往默认渠道，指定了则只发这些渠道。
 *
 * - 修改本行配置的 `channel`（默认渠道）不重载本服务与依赖它的业务插件：在本 fiber 的 `internal/update`
 *   钩子里原地换上新值（不调用 `next()`，否决 cordis 默认的重启）。
 * - 不 inject 渠道服务，而是在发送时用 `ctx.get()` 取：cordis 的 inject 都是必需的，inject 了渠道就
 *   意味着停用任一渠道都会连带卸载本服务以及所有依赖它的业务插件。
 * - 多渠道时并行发送；某个渠道未运行或失败只体现在它自己的结果里，不影响其他渠道。
 */
export class NotifyService extends KitService<NotifyCounters> {
  static Config = NotifyConfig
  private current: NotifyConfig
  private lastSuccessAt: number | null = null
  private readonly counters: NotifyCounters = { success: 0, failure: 0, lastFailureAt: null, lastErrorCode: null }

  constructor(ctx: Context, config: NotifyConfig) {
    super(ctx, 'notify')
    this.current = config
    const self = this
    ctx.on('internal/update', function (next, _noSave, _restart) {
      // this 为本插件的 fiber；next 已经过 NotifyConfig 解析。
      self.current = next as NotifyConfig
      ;(this as unknown as { config: NotifyConfig }).config = self.current
      self.logger.info('notify default channel updated from config', { channel: self.current.channel })
    })
  }

  get config(): NotifyConfig {
    return this.current
  }

  /** 默认渠道。 */
  get defaultChannel(): NotifyChannel {
    return this.current.channel
  }

  private service(name: NotifyChannel): ChannelService | undefined {
    return (this.ctx as unknown as { get(name: string): ChannelService | undefined }).get(name)
  }

  private require(name: NotifyChannel): ChannelService {
    const svc = this.service(name)
    if (!svc) throw channelUnavailable(name)
    return svc
  }

  async send(options: NotifySendOptions): Promise<NotifySendResult> {
    const named = Object.entries(options.targets ?? {}).filter(([, target]) => target !== undefined).map(([name]) => name)
    for (const name of named) {
      if (!NOTIFY_CHANNELS.includes(name as NotifyChannel)) throw new NotifyError('invalid_channel', `unknown channel ${name}`, { details: { channel: name } })
    }
    const channels = named.length > 0 ? (named as NotifyChannel[]) : [this.defaultChannel]
    this.logger.info('notify send', { traceId: options.traceId, channels, body: digest(options.markdown ?? options.text ?? '') })
    if (named.length === 0 && !this.service(this.defaultChannel)) {
      this.recordFailure('channel_unavailable')
      throw channelUnavailable(this.defaultChannel)
    }
    const common: ChannelSendCommon = { title: options.title, markdown: options.markdown, text: options.text, idempotencyKey: options.idempotencyKey, traceId: options.traceId, signal: options.signal }
    const targets = options.targets as Partial<Record<NotifyChannel, unknown>> | undefined
    const ats = options.at as Partial<Record<NotifyChannel, unknown>> | undefined
    const deliveries = await deliver(
      channels.map((channel) => {
        const target = targets?.[channel]
        return { channel, service: this.service(channel), target: target === DEFAULT_TARGET ? undefined : target, at: ats?.[channel] }
      }),
      common,
    )
    for (const d of deliveries) {
      const failed = d.results.find((x) => !x.ok)
      if (failed) {
        const code = failed.error?.code ?? 'send_failed'
        // 渠道失败不再抛出，这里留一条日志（不含消息正文）。
        this.logger.warn('notify delivery failed', { traceId: options.traceId, channel: d.channel, code })
        this.recordFailure(code)
      }
      else this.recordSuccess()
    }
    return { deliveries }
  }

  /** 默认渠道与每个渠道的实时登录状态。 */
  async status(): Promise<NotifyStatus> {
    const entries = await Promise.all(
      NOTIFY_CHANNELS.map(async (name) => {
        const svc = this.service(name)
        if (!svc) return [name, { channel: name, running: false, detail: `agent-kit-${name} is not running` }] as const
        return [name, { ...(await svc.status()), running: true }] as const
      }),
    )
    return { defaultChannel: this.defaultChannel, channels: Object.fromEntries(entries) as NotifyStatus['channels'] }
  }

  /** 登录指定渠道；渠道不需要登录（如机器人）时抛出 `login_unsupported`。 */
  async login(channel: NotifyChannel, options: { signal?: AbortSignal } = {}): Promise<LoginSession> {
    return requireLogin(channel, this.require(channel))(options)
  }

  /** 退出指定渠道的登录；渠道不需要登录时抛出 `login_unsupported`。 */
  async logout(channel: NotifyChannel): Promise<ChannelStatus> {
    return requireLogout(channel, this.require(channel))()
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
    const channel = this.defaultChannel
    const svc = this.service(channel)
    if (!svc) return { status: 'failed', detail: `default channel ${channel} is not running`, counters }
    const channelHealth = svc.health()
    if (channelHealth.status === 'failed') return { status: 'failed', detail: `default channel ${channel}: ${channelHealth.detail}`, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: `default channel: ${channel}`, counters }
  }
}

export default NotifyService
