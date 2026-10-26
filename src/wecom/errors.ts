import { KitError, type KitErrorOptions } from '../common/errors.js'

export type WecomErrorCode = 'invalid_target' | 'auth_failed' | 'not_interacted' | 'rate_limited' | 'not_connected' | 'timeout' | 'aborted' | 'api_error'

const RETRYABLE: ReadonlySet<WecomErrorCode> = new Set(['rate_limited', 'not_connected', 'timeout'])

export class WecomSendError extends KitError {
  declare readonly code: WecomErrorCode

  constructor(code: WecomErrorCode, message: string, options: KitErrorOptions = {}) {
    super('wecom', code, message, { retryable: options.retryable ?? RETRYABLE.has(code), ...options })
    this.name = 'WecomSendError'
  }
}

/**
 * 企业微信全局错误码 → 分类（https://developer.work.weixin.qq.com/document/path/90313，已核实）。
 * 846607「发送消息命中限制」既可能是会话未与机器人互动，也可能是超出频率；用本地会话记录区分。
 */
const ERRCODES: Record<number, WecomErrorCode> = {
  853000: 'auth_failed', // 无效的 bot_id 或者 secret
  40001: 'auth_failed', // 不合法的 secret 参数
  40091: 'auth_failed', // secret 不合法
  846601: 'auth_failed', // 机器人未开启长连接模式
  846609: 'auth_failed', // 机器人未订阅
  40003: 'invalid_target', // 无效的 UserID
  60111: 'invalid_target', // UserID 不存在
  40050: 'invalid_target', // chatid 不存在
  86001: 'invalid_target', // 参数 chatid 不合法
  86003: 'invalid_target', // 参数 chatid 不存在
  93006: 'invalid_target', // 不合法的群 ID
  93008: 'invalid_target', // 不在群里
  45002: 'invalid_target', // 消息内容大小超过限制
  44004: 'invalid_target', // 内容为空
  93017: 'invalid_target', // 请求内容不能为空
  82004: 'invalid_target', // 不合法的消息内容
  40058: 'invalid_target', // 不合法的参数
  45009: 'rate_limited', // 接口调用超过限制
  45033: 'rate_limited', // 接口并发调用超过限制
  [-1]: 'rate_limited', // 系统繁忙（官方建议重试）
  846604: 'api_error', // req_id 已过期（超过 24 小时的回复）
  846605: 'api_error', // 不合法的 req_id
  846606: 'api_error', // 不允许重复回复
}

export function classifyErrcode(errcode: number, errmsg: string, interacted: boolean): WecomSendError {
  if (errcode === 846607) {
    return interacted
      ? new WecomSendError('rate_limited', `wecom send limited (846607): ${errmsg}`, { details: { errcode } })
      : new WecomSendError('not_interacted', '该会话还没有人给机器人发过消息，无法主动发送；先在群里 @ 机器人一次（846607）', { details: { errcode } })
  }
  const code = ERRCODES[errcode] ?? 'api_error'
  return new WecomSendError(code, `wecom error ${errcode}: ${errmsg}`, { details: { errcode } })
}

/**
 * SDK reject 的值：带 errcode 的帧，或超时 / 连接断开的 Error。
 * 真实文案（SDK 1.0.7）：`Reply ack timeout (…ms) for reqId: …`、`…, reply for reqId: … cancelled`、
 * `WebSocket not connected, unable to send data`、`Reply queue for reqId … exceeds max size (…)`。
 */
export function classifyThrown(e: unknown, interacted: boolean): WecomSendError {
  if (e instanceof WecomSendError) return e
  const frame = e as { errcode?: unknown; errmsg?: unknown; message?: unknown }
  if (typeof frame?.errcode === 'number' && frame.errcode !== 0) return classifyErrcode(frame.errcode, String(frame.errmsg ?? ''), interacted)
  const message = String(frame?.message ?? e)
  if (/timeout/i.test(message)) return new WecomSendError('timeout', `wecom request timed out: ${message}`, { cause: e })
  if (/not connected|disconnect|cancelled|closed/i.test(message)) return new WecomSendError('not_connected', `wecom connection unavailable: ${message}`, { cause: e })
  return new WecomSendError('api_error', `wecom request failed: ${message}`, { cause: e })
}
