import { ConfigError } from '../common/errors.js'
import type { KitLogger } from '../common/logger.js'

export interface FeishuApiResponse<T = unknown> {
  code?: number
  msg?: string
  data?: T
}

export interface FeishuCreateMessageRequest {
  params: { receive_id_type: 'chat_id' | 'open_id' }
  data: { receive_id: string; msg_type: 'text' | 'interactive'; content: string; uuid?: string }
}

/** 本包用到的飞书接口；真实实现包装 @larksuiteoapi/node-sdk，测试用假实现。 */
export interface FeishuClient {
  createMessage(req: FeishuCreateMessageRequest, signal: AbortSignal): Promise<FeishuApiResponse<{ message_id?: string }>>
  searchChats(query: string, signal: AbortSignal): Promise<FeishuApiResponse<{ items?: Array<{ chat_id?: string; name?: string }>; has_more?: boolean }>>
  getChat(chatId: string, signal: AbortSignal): Promise<FeishuApiResponse<{ name?: string }>>
  /** `timeoutMs` 透传给 HTTP 请求；`signal` 中止时取消请求。 */
  botInfo(signal: AbortSignal, timeoutMs?: number): Promise<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>
}

export interface FeishuWsHandlers {
  onReady(): void
  onError(error: Error): void
  onReconnecting(): void
  onReconnected(): void
  /** `im.message.receive_v1` 事件；必须同步返回（飞书要求 3 秒内处理完）。 */
  onMessage(event: unknown): void
}

export interface FeishuWs {
  close(): void
}

export interface FeishuSdkOptions {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  logger: KitLogger
}

export interface FeishuSdk {
  createClient(options: FeishuSdkOptions): FeishuClient
  startWs(options: FeishuSdkOptions, handlers: FeishuWsHandlers): FeishuWs
}

export type FeishuSdkLoader = () => Promise<FeishuSdk>

/**
 * SDK 日志参数 → 文本。SDK 常把整个 axios 错误对象（含请求体：app_secret、消息正文）传进来，
 * 所以对象只取安全字段，绝不整体序列化。
 */
export function formatSdkLog(args: unknown[]): string {
  return args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg])).map((arg) => {
    if (typeof arg === 'string') return arg
    if (arg === null || typeof arg !== 'object') return String(arg)
    const e = arg as { message?: unknown; code?: unknown; response?: { status?: unknown; data?: { code?: unknown; msg?: unknown } } }
    const fields: string[] = []
    if (typeof e.message === 'string') fields.push(e.message)
    if (typeof e.code === 'string' || typeof e.code === 'number') fields.push(`code=${e.code}`)
    if (typeof e.response?.status === 'number') fields.push(`status=${e.response.status}`)
    if (typeof e.response?.data?.code === 'number') fields.push(`apiCode=${e.response.data.code}`)
    if (typeof e.response?.data?.msg === 'string') fields.push(`msg=${e.response.data.msg}`)
    return fields.length ? fields.join(' ') : '[object]'
  }).join(' ')
}

/** 默认从 @larksuiteoapi/node-sdk 加载（可选 peer，只在启用 feishu 时加载）。 */
export const loadFeishuSdk: FeishuSdkLoader = async () => {
  let lark: typeof import('@larksuiteoapi/node-sdk')
  try {
    lark = await import('@larksuiteoapi/node-sdk')
  } catch (e) {
    throw new ConfigError('feishu', '@larksuiteoapi/node-sdk is not installed; it is required when the feishu service is enabled', { cause: (e as Error).message })
  }
  const domainOf = (d: 'feishu' | 'lark') => (d === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu)
  // SDK 的 logger 接口为 error/warn/info/debug/trace(...msg)；统一转到已脱敏的 KitLogger
  const bridge = (logger: KitLogger) => ({
    error: (...m: unknown[]) => logger.error('feishu sdk', { message: formatSdkLog(m) }),
    warn: (...m: unknown[]) => logger.warn('feishu sdk', { message: formatSdkLog(m) }),
    info: (...m: unknown[]) => logger.debug('feishu sdk', { message: formatSdkLog(m) }),
    debug: (...m: unknown[]) => logger.debug('feishu sdk', { message: formatSdkLog(m) }),
    trace: () => {},
  })
  return {
    createClient({ appId, appSecret, domain, logger }) {
      const client = new lark.Client({ appId, appSecret, domain: domainOf(domain), logger: bridge(logger), loggerLevel: lark.LoggerLevel.warn })
      return {
        createMessage: (req) => client.im.v1.message.create(req) as Promise<FeishuApiResponse<{ message_id?: string }>>,
        searchChats: (query) => client.im.v1.chat.search({ params: { query, page_size: 20 } }) as Promise<FeishuApiResponse<{ items?: Array<{ chat_id?: string; name?: string }>; has_more?: boolean }>>,
        getChat: (chatId) => client.im.v1.chat.get({ path: { chat_id: chatId } }) as Promise<FeishuApiResponse<{ name?: string }>>,
        // client.request 接受 axios 配置，signal / timeout 原样传给 axios
        botInfo: (signal, timeoutMs) => client.request({ method: 'GET', url: '/open-apis/bot/v3/info', signal, ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}) }) as Promise<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>,
      }
    },
    startWs({ appId, appSecret, domain, logger }, handlers) {
      const ws = new lark.WSClient({
        appId,
        appSecret,
        domain: domainOf(domain),
        logger: bridge(logger),
        loggerLevel: lark.LoggerLevel.warn,
        onReady: handlers.onReady,
        onError: handlers.onError,
        onReconnecting: handlers.onReconnecting,
        onReconnected: handlers.onReconnected,
      })
      void ws.start({
        eventDispatcher: new lark.EventDispatcher({ logger: bridge(logger), loggerLevel: lark.LoggerLevel.warn }).register({
          'im.message.receive_v1': async (data: unknown) => { handlers.onMessage(data) },
        }),
      })
      return { close: () => ws.close() }
    },
  }
}
