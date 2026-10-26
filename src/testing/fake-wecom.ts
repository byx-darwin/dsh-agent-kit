import { WecomService } from '../wecom/service.js'
import { isTerminalSdkError, type WecomConnection, type WecomFrame, type WecomHandlers, type WecomSdk, type WecomSendBody } from '../wecom/sdk.js'

export interface FakeWecomStep {
  errcode?: number
  errmsg?: string
  throw?: 'timeout' | 'disconnected'
}

export interface FakeWecom {
  sdk: WecomSdk
  sends: Array<{ chatid: string; body: WecomSendBody }>
  replies: Array<{ frame: WecomFrame; streamId: string; content: string }>
  /** 按调用次序取，用完重复最后一个；默认成功。 */
  setSend(steps: FakeWecomStep[]): void
  setReply(steps: FakeWecomStep[]): void
  authenticate(): void
  disconnect(reason?: string): void
  reconnecting(): void
  /** 终态错误：默认 `WSAuthFailureError`（认证失败重试用尽）；传入的错误若不是终态名称，也按认证失败用尽处理。 */
  error(error?: Error): void
  /** 非终态错误（如 ECONNREFUSED）：普通 Error，SDK 会继续重连。 */
  transientError(message?: string): void
  kick(): void
  /** 推送一帧消息并让路由器有机会投递。 */
  emit(frame: WecomFrame): Promise<void>
  connects(): number
  disconnected(): boolean
}

function stepper(initial: FakeWecomStep[]) {
  let steps = initial
  let calls = 0
  return {
    set(next: FakeWecomStep[]) { steps = next; calls = 0 },
    next(): FakeWecomStep { const s = steps.length ? steps[Math.min(calls, steps.length - 1)]! : {}; calls++; return s },
  }
}

async function settle(step: FakeWecomStep, reqId: string): Promise<WecomFrame> {
  if (step.throw === 'timeout') throw new Error(`Reply ack timeout (10000ms) for reqId: ${reqId}`)
  if (step.throw === 'disconnected') throw new Error(`Connection closed, reply for reqId: ${reqId} cancelled`)
  if (step.errcode) throw { headers: { req_id: reqId }, errcode: step.errcode, errmsg: step.errmsg ?? 'error' }
  return { headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }
}

export function createFakeWecomSdk(options: { send?: FakeWecomStep[]; reply?: FakeWecomStep[] } = {}): FakeWecom {
  const send = stepper(options.send ?? [])
  const reply = stepper(options.reply ?? [])
  const sends: FakeWecom['sends'] = []
  const replies: FakeWecom['replies'] = []
  let handlers: WecomHandlers | undefined
  let connected = false
  let closed = false
  /** 与适配器一致：disconnect 时先摘掉监听，之后的回调都不再送达。 */
  let detached = false
  let connects = 0
  let seq = 0
  const noop: WecomHandlers = { onAuthenticated() {}, onDisconnected() {}, onReconnecting() {}, onError() {}, onTransientError() {}, onKicked() {}, onMessage() {} }
  const need = () => {
    if (!handlers) throw new Error('fake wecom: connect has not been called')
    return detached ? noop : handlers
  }
  return {
    sdk: {
      connect(_options, h): WecomConnection {
        handlers = h
        closed = false
        detached = false
        connects++
        return {
          sendMessage: (chatid, body) => { sends.push({ chatid, body }); return settle(send.next(), `send_${++seq}`) },
          replyStream: (frame, streamId, content) => { replies.push({ frame, streamId, content }); return settle(reply.next(), frame.headers.req_id) },
          get connected() { return connected },
          disconnect: () => { detached = true; closed = true; connected = false },
        }
      },
    },
    sends,
    replies,
    setSend: (s) => send.set(s),
    setReply: (s) => reply.set(s),
    authenticate: () => { connected = true; need().onAuthenticated() },
    disconnect: (reason = 'network') => { connected = false; need().onDisconnected(reason) },
    reconnecting: () => need().onReconnecting(1),
    error: (e) => {
      connected = false
      const terminal = e && isTerminalSdkError(e) ? e : Object.assign(new Error(e?.message ?? 'Max auth failure attempts exceeded (5)'), { name: 'WSAuthFailureError' })
      need().onError(terminal)
    },
    transientError: (message = 'connect ECONNREFUSED 127.0.0.1:443') => { connected = false; need().onTransientError(new Error(message)) },
    kick: () => { connected = false; need().onKicked(); need().onDisconnected('New connection established, server disconnected this connection') },
    emit: async (frame) => {
      need().onMessage(frame)
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    },
    connects: () => connects,
    disconnected: () => closed,
  }
}

/** 让 `WecomService` 使用假 SDK；返回恢复函数。 */
export function useFakeWecomSdk(fake: FakeWecom): () => void {
  const previous = WecomService.sdkLoader
  WecomService.sdkLoader = async () => fake.sdk
  return () => { WecomService.sdkLoader = previous }
}
