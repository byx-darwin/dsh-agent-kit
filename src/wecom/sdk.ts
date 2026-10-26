import { ConfigError } from '../common/errors.js'
import type { KitLogger } from '../common/logger.js'

/** 长连接帧；回复与主动发送失败时 SDK 以带 `errcode` 的帧 reject。 */
export interface WecomFrame {
  cmd?: string
  headers: { req_id: string; [key: string]: unknown }
  body?: unknown
  errcode?: number
  errmsg?: string
}

export interface WecomSendBody {
  msgtype: 'markdown'
  markdown: { content: string }
}

export interface WecomHandlers {
  onAuthenticated(): void
  onDisconnected(reason: string): void
  onReconnecting(attempt: number): void
  /** 认证失败重试用尽等终态错误。 */
  onError(error: Error): void
  /** 被另一条连接挤下线；SDK 不会再自动重连。 */
  onKicked(): void
  /** 消息帧（`aibot_msg_callback`）；必须同步返回。 */
  onMessage(frame: WecomFrame): void
}

export interface WecomConnection {
  sendMessage(chatid: string, body: WecomSendBody): Promise<WecomFrame>
  /** 基于收到的帧一次性回复（流式消息直接 finish）。 */
  replyStream(frame: WecomFrame, streamId: string, content: string): Promise<WecomFrame>
  readonly connected: boolean
  disconnect(): void
}

export interface WecomSdkOptions {
  botId: string
  secret: string
  wsUrl?: string
  requestTimeout: number
  logger: KitLogger
}

export interface WecomSdk {
  connect(options: WecomSdkOptions, handlers: WecomHandlers): WecomConnection
}

export type WecomSdkLoader = () => Promise<WecomSdk>

/**
 * SDK 会把消息体、整帧 JSON 序列化进自己的日志字符串：先抹掉 JSON 对象 / 数组字面量，
 * 再把 `body=` 之后的内容整体丢弃，只保留 cmd、reqId、errcode 等定位信息。
 */
function sanitizeSdkText(text: string): string {
  return text
    .replace(/\{[\s\S]*\}/, '[json omitted]')
    .replace(/\[\s*[{"][\s\S]*\]/, '[json omitted]')
    .replace(/body=[\s\S]*$/, 'body=[omitted]')
}

/** 只取 SDK 日志参数中的安全字段，不序列化整个对象（帧里有消息正文）。 */
export function formatSdkLog(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === 'string') return sanitizeSdkText(arg)
    if (arg === null || typeof arg !== 'object') return String(arg)
    const e = arg as { message?: unknown; errcode?: unknown; errmsg?: unknown }
    const fields: string[] = []
    if (typeof e.message === 'string') fields.push(e.message)
    if (typeof e.errcode === 'number') fields.push(`errcode=${e.errcode}`)
    if (typeof e.errmsg === 'string') fields.push(`errmsg=${e.errmsg}`)
    return fields.length ? fields.join(' ') : '[object]'
  }).join(' ')
}

/** 默认从 @wecom/aibot-node-sdk 加载（可选 peer，只在启用 wecom 时加载）。 */
export const loadWecomSdk: WecomSdkLoader = async () => {
  let sdk: typeof import('@wecom/aibot-node-sdk')
  try {
    sdk = await import('@wecom/aibot-node-sdk')
  } catch (e) {
    throw new ConfigError('wecom', '@wecom/aibot-node-sdk is not installed; it is required when the wecom service is enabled', { cause: (e as Error).message })
  }
  return {
    connect({ botId, secret, wsUrl, requestTimeout, logger }, handlers) {
      const bridge = {
        debug: (m: string, ...a: unknown[]) => logger.debug('wecom sdk', { message: formatSdkLog([m, ...a]) }),
        // SDK 的 info 是逐帧的流水日志，降到 debug
        info: (m: string, ...a: unknown[]) => logger.debug('wecom sdk', { message: formatSdkLog([m, ...a]) }),
        warn: (m: string, ...a: unknown[]) => logger.warn('wecom sdk', { message: formatSdkLog([m, ...a]) }),
        error: (m: string, ...a: unknown[]) => logger.error('wecom sdk', { message: formatSdkLog([m, ...a]) }),
      }
      const client = new sdk.WSClient({
        botId,
        secret,
        ...(wsUrl ? { wsUrl } : {}),
        requestTimeout,
        maxReconnectAttempts: -1,
        maxAuthFailureAttempts: 5,
        logger: bridge,
      })
      client.on('authenticated', handlers.onAuthenticated)
      client.on('disconnected', handlers.onDisconnected)
      client.on('reconnecting', handlers.onReconnecting)
      client.on('error', handlers.onError)
      client.on('event.disconnected_event', () => handlers.onKicked())
      client.on('message', (frame) => handlers.onMessage(frame as unknown as WecomFrame))
      client.connect()
      return {
        sendMessage: (chatid, body) => client.sendMessage(chatid, body) as Promise<WecomFrame>,
        replyStream: (frame, streamId, content) => client.replyStream(frame as never, streamId, content, true) as Promise<WecomFrame>,
        get connected() { return client.isConnected },
        disconnect: () => client.disconnect(),
      }
    },
  }
}
