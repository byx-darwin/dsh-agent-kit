import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWecomProbe, type WecomSdkLoader } from '../../src/wecom-probe.js'

class FakeClient extends EventEmitter {
  static last: FakeClient
  disconnects = 0
  constructor(public options: Record<string, unknown>) {
    super()
    FakeClient.last = this
  }
  connect(): void {}
  disconnect(): void {
    this.disconnects++
  }
}
const loader: WecomSdkLoader = async () => ({ WSClient: FakeClient })
const input = { botId: 'bot1', secret: 'sup3r-secret-value' }

afterEach(() => vi.useRealTimers())

describe('probeWecom', () => {
  it('resolves ok on authenticated, disconnects once and clears the timer', async () => {
    vi.useFakeTimers()
    const p = createWecomProbe(loader)(input)
    await vi.advanceTimersByTimeAsync(0)
    FakeClient.last.emit('authenticated')
    expect(await p).toEqual({ ok: true, detail: '认证成功' })
    expect(FakeClient.last.disconnects).toBe(1)
    expect(FakeClient.last.options).toMatchObject({ maxReconnectAttempts: 0, maxAuthFailureAttempts: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('redacts the secret from SDK error messages', async () => {
    vi.useFakeTimers()
    const p = createWecomProbe(loader)(input)
    await vi.advanceTimersByTimeAsync(0)
    FakeClient.last.emit('error', new Error(`bad secret ${input.secret}`))
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('认证失败')
    expect(r.detail).not.toContain(input.secret)
    expect(FakeClient.last.disconnects).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maps reconnect exhaustion to a clear message', async () => {
    vi.useFakeTimers()
    const p = createWecomProbe(loader)(input)
    await vi.advanceTimersByTimeAsync(0)
    const e = new Error('Max reconnect attempts reached (0)')
    e.name = 'WSReconnectExhaustedError'
    FakeClient.last.emit('error', e)
    const r = await p
    expect(r.detail).toContain('连接被服务端断开')
    expect(r.detail).not.toContain('Max reconnect')
  })

  it('resolves not-ok when disconnected before authenticating', async () => {
    vi.useFakeTimers()
    const p = createWecomProbe(loader)(input)
    await vi.advanceTimersByTimeAsync(0)
    FakeClient.last.emit('disconnected', 'kicked')
    expect(await p).toMatchObject({ ok: false, detail: expect.stringContaining('连接被服务端断开') })
    expect(FakeClient.last.disconnects).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out with rounded-up seconds and disconnects', async () => {
    vi.useFakeTimers()
    const p = createWecomProbe(loader)({ ...input, timeoutMs: 1500 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(await p).toEqual({ ok: false, detail: '2 秒内没有完成认证' })
    expect(FakeClient.last.disconnects).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not report twice when events repeat', async () => {
    vi.useFakeTimers()
    const p = createWecomProbe(loader)(input)
    await vi.advanceTimersByTimeAsync(0)
    FakeClient.last.emit('authenticated')
    FakeClient.last.emit('error', new Error('late'))
    expect(await p).toMatchObject({ ok: true })
    expect(FakeClient.last.disconnects).toBe(1)
  })

  it('reports a missing SDK', async () => {
    const r = await createWecomProbe(async () => { throw new Error('nope') })(input)
    expect(r).toEqual({ ok: false, detail: '未安装 @wecom/aibot-node-sdk' })
  })

  it('turns a constructor throw into a redacted result', async () => {
    class Boom {
      constructor() {
        throw new Error(`init failed ${input.secret}`)
      }
      on(): void {}
      connect(): void {}
      disconnect(): void {}
    }
    const r = await createWecomProbe(async () => ({ WSClient: Boom }))(input)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('连接失败')
    expect(r.detail).not.toContain(input.secret)
  })

  it('turns a connect() throw into a result and still disconnects', async () => {
    class ConnectBoom extends FakeClient {
      override connect(): void {
        throw new Error('sync boom')
      }
    }
    const r = await createWecomProbe(async () => ({ WSClient: ConnectBoom }))(input)
    expect(r).toMatchObject({ ok: false, detail: expect.stringContaining('sync boom') })
    expect(FakeClient.last.disconnects).toBe(1)
  })
})
