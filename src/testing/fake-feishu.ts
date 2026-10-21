import { FeishuService } from '../feishu/service.js'
import type { FeishuClient, FeishuCreateMessageRequest, FeishuSdk, FeishuWsHandlers } from '../feishu/sdk.js'

export interface FakeFeishuSendStep {
  code?: number
  msg?: string
  messageId?: string
  throw?: 'network' | 'timeout' | 'hang' | { status: number }
}

export interface FakeFeishu {
  sdk: FeishuSdk
  /** 每次 createMessage 的请求，按调用顺序。 */
  sends: FeishuCreateMessageRequest[]
  /** 按调用次序取，用完后重复最后一个；默认每次成功。 */
  setSend(steps: FakeFeishuSendStep[]): void
  /** 推送一条 `im.message.receive_v1` 事件。 */
  emit(event: unknown): Promise<void>
  ready(): void
  reconnecting(): void
  reconnected(): void
  error(error: Error): void
  closed(): boolean
  /** startWs 被调用的次数。 */
  started(): number
}

export function createFakeFeishuSdk(options: {
  botName?: string
  botOpenId?: string
  chats?: Array<{ chatId: string; name: string }>
  send?: FakeFeishuSendStep[]
  /** 非 0 时 botInfo 返回该错误码（模拟凭据错误）。 */
  authCode?: number
} = {}): FakeFeishu {
  let steps: FakeFeishuSendStep[] = options.send ?? []
  let calls = 0
  let handlers: FeishuWsHandlers | undefined
  let closed = false
  let started = 0
  const sends: FeishuCreateMessageRequest[] = []
  const chats = options.chats ?? []
  const client: FeishuClient = {
    async createMessage(req) {
      sends.push(req)
      const step = steps.length ? steps[Math.min(calls, steps.length - 1)]! : {}
      calls++
      if (step.throw === 'hang') return new Promise<never>(() => {})
      if (step.throw === 'network') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      if (step.throw === 'timeout') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
      if (step.throw) throw Object.assign(new Error(`HTTP ${step.throw.status}`), { response: { status: step.throw.status } })
      if (step.code) return { code: step.code, msg: step.msg ?? 'error' }
      return { code: 0, msg: 'ok', data: { message_id: step.messageId ?? `om_${sends.length}` } }
    },
    async searchChats(query) {
      return { code: 0, data: { items: chats.filter((c) => c.name.includes(query)).map((c) => ({ chat_id: c.chatId, name: c.name })), has_more: false } }
    },
    async getChat(chatId) {
      const chat = chats.find((c) => c.chatId === chatId)
      return chat ? { code: 0, data: { name: chat.name } } : { code: 230001, msg: 'not found' }
    },
    async botInfo() {
      if (options.authCode) return { code: options.authCode, msg: 'invalid app credential' }
      return { code: 0, bot: { app_name: options.botName ?? 'fake bot', open_id: options.botOpenId ?? 'ou_bot' } }
    },
  }
  const need = () => {
    if (!handlers) throw new Error('fake feishu: startWs has not been called')
    return handlers
  }
  return {
    sdk: {
      createClient: () => client,
      startWs: (_options, h) => {
        handlers = h
        closed = false
        started++
        return { close: () => { closed = true } }
      },
    },
    sends,
    setSend: (next) => { steps = next; calls = 0 },
    emit: async (event) => {
      need().onMessage(event)
      // 让路由器的投递有机会执行
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    },
    ready: () => need().onReady(),
    reconnecting: () => need().onReconnecting(),
    reconnected: () => need().onReconnected(),
    error: (e) => need().onError(e),
    closed: () => closed,
    started: () => started,
  }
}

/** 让 `FeishuService` 使用假 SDK；返回恢复函数。 */
export function useFakeFeishuSdk(fake: FakeFeishu): () => void {
  const previous = FeishuService.sdkLoader
  FeishuService.sdkLoader = async () => fake.sdk
  return () => { FeishuService.sdkLoader = previous }
}
