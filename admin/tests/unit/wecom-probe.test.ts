import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWecomProbe, profileWecomSdkLoader, type WecomSdkLoader } from '../../src/wecom-probe.js'

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
    FakeClient.last.emit('error', new Error(`Authentication failed: bad secret ${input.secret} (code: 40001)`))
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('认证失败')
    expect(r.detail).not.toContain(input.secret)
    expect(FakeClient.last.disconnects).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('labels auth-exhaustion errors as auth failures and network errors as connection failures', async () => {
    vi.useFakeTimers()
    const exhausted = createWecomProbe(loader)(input)
    await vi.advanceTimersByTimeAsync(0)
    FakeClient.last.emit('error', Object.assign(new Error('Max auth failure attempts exceeded (0)'), { name: 'WSAuthFailureError' }))
    expect((await exhausted).detail).toMatch(/^认证失败：/)
    const network = createWecomProbe(loader)(input)
    await vi.advanceTimersByTimeAsync(0)
    FakeClient.last.emit('error', new Error('connect ECONNREFUSED 10.0.0.1:443'))
    const r = await network
    expect(r).toEqual({ ok: false, detail: '连接失败：connect ECONNREFUSED 10.0.0.1:443' })
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

describe('profileWecomSdkLoader', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('resolves the SDK relative to the Profile directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-profile-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    const sdkDir = join(dir, 'node_modules', '@wecom', 'aibot-node-sdk')
    mkdirSync(sdkDir, { recursive: true })
    writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: '@wecom/aibot-node-sdk', version: '1.0.7', type: 'module', main: 'index.mjs' }))
    writeFileSync(join(sdkDir, 'index.mjs'), "export class WSClient { static fromProfile = true }\n")
    const sdk = await profileWecomSdkLoader(dir)()
    expect((sdk.WSClient as unknown as { fromProfile?: boolean }).fromProfile).toBe(true)
  })

  it('reports a missing SDK when the Profile does not have it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-profile-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    await expect(profileWecomSdkLoader(dir)()).rejects.toThrow()
    expect(await createWecomProbe(profileWecomSdkLoader(dir))({ botId: 'b', secret: 'sup3r-secret-value' })).toEqual({ ok: false, detail: '未安装 @wecom/aibot-node-sdk' })
  })
})
