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
  botInfo(signal: AbortSignal): Promise<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>
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
    error: (...m: unknown[]) => logger.error('feishu sdk', { message: m.map(String).join(' ') }),
    warn: (...m: unknown[]) => logger.warn('feishu sdk', { message: m.map(String).join(' ') }),
    info: (...m: unknown[]) => logger.debug('feishu sdk', { message: m.map(String).join(' ') }),
    debug: (...m: unknown[]) => logger.debug('feishu sdk', { message: m.map(String).join(' ') }),
    trace: () => {},
  })
  return {
    createClient({ appId, appSecret, domain, logger }) {
      const client = new lark.Client({ appId, appSecret, domain: domainOf(domain), logger: bridge(logger), loggerLevel: lark.LoggerLevel.warn })
      return {
        createMessage: (req) => client.im.v1.message.create(req) as Promise<FeishuApiResponse<{ message_id?: string }>>,
        searchChats: (query) => client.im.v1.chat.search({ params: { query, page_size: 20 } }) as Promise<FeishuApiResponse<{ items?: Array<{ chat_id?: string; name?: string }>; has_more?: boolean }>>,
        getChat: (chatId) => client.im.v1.chat.get({ path: { chat_id: chatId } }) as Promise<FeishuApiResponse<{ name?: string }>>,
        botInfo: () => client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }) as Promise<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>,
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
        eventDispatcher: new lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data: unknown) => { handlers.onMessage(data) },
        }),
      })
      return { close: () => ws.close() }
    },
  }
}
