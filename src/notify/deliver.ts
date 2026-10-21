import type { ChannelSendCommon, ChannelSendResult, ChannelService } from '../common/channel.js'
import { isKitError } from '../common/errors.js'
import { redact } from '../common/redact.js'
import { NotifyError } from './errors.js'

export interface NotifyDelivery<C extends string = string> {
  channel: C
  results: ChannelSendResult['results']
}

export interface PlannedDelivery<C extends string = string> {
  channel: C
  /** 未运行时为 undefined。 */
  service: ChannelService | undefined
  /** 缺省时由渠道使用自己配置的默认目标。 */
  target?: unknown
  at?: unknown
}

export function channelUnavailable(channel: string): NotifyError {
  return new NotifyError('channel_unavailable', `${channel} is not running; enable agent-kit-${channel}`, { details: { channel } })
}

/** 并行投递到各渠道。渠道未运行或 `send()` 抛错，都只转为该渠道的失败结果，不影响其他渠道。 */
export function deliver<C extends string>(plans: PlannedDelivery<C>[], common: ChannelSendCommon): Promise<NotifyDelivery<C>[]> {
  return Promise.all(plans.map(async ({ channel, service, target, at }): Promise<NotifyDelivery<C>> => {
    if (!service) return { channel, results: [{ ok: false, error: channelUnavailable(channel) }] }
    try {
      const r = await service.send({ ...common, target, at })
      return { channel, results: r.results.map((x) => ({ ok: x.ok, ...(x.messageId ? { messageId: x.messageId } : {}), ...(x.error ? { error: x.error } : {}) })) }
    } catch (e) {
      const error = isKitError(e) ? e : new NotifyError('send_failed', `${channel} send failed: ${redact(String((e as Error)?.message ?? e))}`, { retryable: true, cause: e, details: { channel } })
      return { channel, results: [{ ok: false, error }] }
    }
  }))
}

export function requireLogin(channel: string, service: ChannelService): NonNullable<ChannelService['login']> {
  if (!service.login) throw new NotifyError('login_unsupported', `${channel} does not support login`, { details: { channel } })
  return service.login.bind(service)
}

export function requireLogout(channel: string, service: ChannelService): NonNullable<ChannelService['logout']> {
  if (!service.logout) throw new NotifyError('login_unsupported', `${channel} does not support logout`, { details: { channel } })
  return service.logout.bind(service)
}
