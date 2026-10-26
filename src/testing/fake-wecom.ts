import { WecomService } from '../wecom/service.js'
import type { WecomConnection, WecomFrame, WecomHandlers, WecomSdk, WecomSendBody } from '../wecom/sdk.js'

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
  error(error: Error): void
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
  let connects = 0
  let seq = 0
  const need = () => {
    if (!handlers) throw new Error('fake wecom: connect has not been called')
    return handlers
  }
  return {
    sdk: {
      connect(_options, h): WecomConnection {
        handlers = h
        closed = false
        connects++
        return {
          sendMessage: (chatid, body) => { sends.push({ chatid, body }); return settle(send.next(), `send_${++seq}`) },
          replyStream: (frame, streamId, content) => { replies.push({ frame, streamId, content }); return settle(reply.next(), frame.headers.req_id) },
          get connected() { return connected },
          disconnect: () => { closed = true; connected = false },
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
    error: (e) => { connected = false; need().onError(e) },
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
