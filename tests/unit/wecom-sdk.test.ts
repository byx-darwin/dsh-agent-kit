import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// 用假的 WSClient 替换真实 SDK：只测适配器的事件分流与断开顺序，不建立网络连接
const clients: FakeClient[] = []
class FakeClient extends EventEmitter {
  readonly calls: string[] = []
  isConnected = false
  constructor(readonly options: unknown) { super(); clients.push(this) }
  connect() { this.calls.push('connect'); return this }
  disconnect() { this.calls.push(`disconnect(listeners=${this.eventNames().length})`) }
  sendMessage() { return Promise.resolve({ headers: { req_id: 'r' } }) }
  replyStream() { return Promise.resolve({ headers: { req_id: 'r' } }) }
}
vi.mock('@wecom/aibot-node-sdk', () => ({ WSClient: FakeClient }))

const { isTerminalSdkError, loadWecomSdk } = await import('../../src/wecom/sdk.js')

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never
const named = (name: string, message = name) => Object.assign(new Error(message), { name })

function connect() {
  const handlers = { onAuthenticated: vi.fn(), onDisconnected: vi.fn(), onReconnecting: vi.fn(), onError: vi.fn(), onTransientError: vi.fn(), onKicked: vi.fn(), onMessage: vi.fn() }
  return loadWecomSdk().then((sdk) => {
    const connection = sdk.connect({ botId: 'b', secret: 's', requestTimeout: 1000, logger }, handlers)
    return { connection, handlers, client: clients.at(-1)! }
  })
}

describe('wecom SDK adapter', () => {
  it('classifies only auth-failure and reconnect exhaustion as terminal', () => {
    expect(isTerminalSdkError(named('WSAuthFailureError'))).toBe(true)
    expect(isTerminalSdkError(named('WSReconnectExhaustedError'))).toBe(true)
    expect(isTerminalSdkError(new Error('connect ECONNREFUSED'))).toBe(false)
    expect(isTerminalSdkError(new Error('Authentication failed: x (code: 40001)'))).toBe(false)
    expect(isTerminalSdkError(undefined)).toBe(false)
  })

  it('routes terminal errors to onError and everything else to onTransientError', async () => {
    const { client, handlers } = await connect()
    client.emit('error', new Error('getaddrinfo ENOTFOUND openws.work.weixin.qq.com'))
    client.emit('error', new Error('Authentication failed: invalid (code: 40001)'))
    expect(handlers.onTransientError).toHaveBeenCalledTimes(2)
    expect(handlers.onError).not.toHaveBeenCalled()
    client.emit('error', named('WSAuthFailureError', 'Max auth failure attempts exceeded (5)'))
    client.emit('error', named('WSReconnectExhaustedError'))
    expect(handlers.onError).toHaveBeenCalledTimes(2)
  })

  it('removes listeners before disconnecting so a late disconnected event is not delivered', async () => {
    const { client, handlers, connection } = await connect()
    connection.disconnect()
    expect(client.calls).toEqual(['connect', 'disconnect(listeners=0)'])
    client.emit('disconnected', 'late close')
    client.emit('authenticated')
    expect(handlers.onDisconnected).not.toHaveBeenCalled()
    expect(handlers.onAuthenticated).not.toHaveBeenCalled()
  })
})
