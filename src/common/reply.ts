import type { ChannelSendResult } from './channel.js'
import { KitError, isKitError, type ServiceName } from './errors.js'
import { redact } from './redact.js'

/** 把渠道 `send()` 的异常转为失败结果，使 `reply()` 与 `notify` 一样不抛错。 */
export async function safeReply(service: ServiceName, send: () => Promise<ChannelSendResult>): Promise<ChannelSendResult> {
  try {
    return await send()
  } catch (e) {
    const error = isKitError(e) ? e : new KitError(service, 'send_failed', `${service} reply failed: ${redact(String((e as Error)?.message ?? e))}`, { retryable: true, cause: e })
    return { results: [{ ok: false, error }] }
  }
}

/** 渠道没有提供回复能力时的兜底结果。 */
export function replyUnsupported(service: ServiceName): Promise<ChannelSendResult> {
  return Promise.resolve({ results: [{ ok: false, error: new KitError(service, 'reply_unsupported', `${service} does not support replying to messages`, { retryable: false }) }] })
}
