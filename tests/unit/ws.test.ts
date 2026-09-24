import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AgentWsService, type AgentWsHandle } from '../../src/ws/service.js'
import { backoffDelay, validateUrl, type ConnectOptions, type ConnectionState } from '../../src/ws/connection.js'
import type { WsConfig } from '../../src/ws/config.js'
import { isKitError } from '../../src/common/errors.js'
import { clearSecretsForTesting } from '../../src/common/redact.js'
import { startTestWsServer, type TestWsServer } from '../../src/testing/ws-server.js'
import { createRoot, deferred, flushIo, until, type TestRoot } from '../helpers.js'

const FAST: Partial<WsConfig> = {
  pingIntervalMs: 1000,
  readTimeoutMs: 2000,
  reconnect: { initialDelayMs: 100, maxDelayMs: 1000, jitter: 0 },
  stableResetMs: 5000,
  fatalRetryDelayMs: 0,
}

let t: TestRoot
let server: TestWsServer

beforeEach(async () => {
  t = createRoot()
  server = await startTestWsServer()
})

afterEach(async () => {
  vi.useRealTimers()
  await t.dispose()
  await server.close()
  clearSecretsForTesting()
})

async function setup(config: Partial<WsConfig> = FAST) {
  await t.root.plugin(AgentWsService, config as never)
  let consumer!: Context
  const fiber = await t.root.inject(['agentWs'], (ctx) => {
    consumer = ctx
  })
  const connect = <T = unknown>(options: Partial<ConnectOptions<T>> = {}): AgentWsHandle =>
    consumer.agentWs.connect<T>({ url: server.url, onMessage: () => {}, ...options } as ConnectOptions<T>)
  return { consumer, fiber, connect, service: () => consumer.agentWs }
}

describe('url and config validation', () => {
  it('only allows wss://, and ws:// for localhost', () => {
    expect(() => validateUrl('ws://example.com/x')).toThrow(/only wss/)
    expect(() => validateUrl('http://127.0.0.1')).toThrow(/only wss/)
    expect(() => validateUrl('not a url')).toThrow(/invalid/)
    expect(validateUrl('wss://example.com/x').host).toBe('example.com')
    expect(validateUrl('ws://localhost:1234').hostname).toBe('localhost')
    expect(validateUrl('ws://127.0.0.1:1234').hostname).toBe('127.0.0.1')
  })

  it('applies defaults', async () => {
    const { service } = await setup({})
    expect(service().config).toEqual({
      pingIntervalMs: 30_000,
      readTimeoutMs: 75_000,
      reconnect: { initialDelayMs: 1000, maxDelayMs: 60_000, jitter: 0.2 },
      stableResetMs: 60_000,
      fatalRetryDelayMs: 300_000,
      maxPayloadBytes: 1_048_576,
      maxPendingMessages: 100,
    })
  })

  it.each([
    [{ pingIntervalMs: -1 }, /pingIntervalMs|expected/],
    [{ pingIntervalMs: 500 }, /expected/],
    [{ pingIntervalMs: 30_000, readTimeoutMs: 40_000 }, /readTimeoutMs must be/],
    [{ reconnect: { initialDelayMs: 5000, maxDelayMs: 1000, jitter: 0 } }, /maxDelayMs must be/],
    [{ reconnect: { initialDelayMs: 1000, maxDelayMs: 1000, jitter: 2 } }, /expected/],
    [{ fatalRetryDelayMs: 5000 }, /fatalRetryDelayMs must be 0 or/],
    [{ maxPayloadBytes: 10 }, /expected/],
    [{ maxPendingMessages: 0 }, /expected/],
  ])('rejects invalid config %j', async (config, pattern) => {
    await expect(t.root.plugin(AgentWsService, config as never)).rejects.toThrow(pattern)
  })

  it('rejects invalid connect() options synchronously', async () => {
    const { connect } = await setup()
    expect(() => connect({ url: 'ws://example.com' })).toThrow(/only wss/)
    expect(() => connect({ concurrency: 0 })).toThrow(/concurrency/)
    try {
      connect({ url: 'ws://example.com' })
    } catch (e) {
      expect(isKitError(e) && e.code).toBe('invalid_url')
    }
  })
})

describe('backoff', () => {
  const reconnect = { initialDelayMs: 1000, maxDelayMs: 60_000, jitter: 0.2 }
  it('grows exponentially, is capped by maxDelayMs, and jitter only lowers it', () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const upper = Math.min(60_000, 1000 * 2 ** attempt)
      expect(backoffDelay(attempt, reconnect, () => 0)).toBe(upper)
      expect(backoffDelay(attempt, reconnect, () => 0.999999)).toBeGreaterThanOrEqual(Math.floor(upper * 0.8))
      expect(backoffDelay(attempt, reconnect, Math.random)).toBeLessThanOrEqual(60_000)
    }
  })
})

describe('connect, send, receive', () => {
  it('sends static headers, receives frames in order and sends frames', async () => {
    const { connect } = await setup()
    const frames: unknown[] = []
    const conn = connect({ headers: { 'X-Token': 'static-token-1' }, onMessage: (f) => void frames.push(f) })
    await conn.whenOpen()
    const ws = await server.waitForConnection()
    expect(server.handshakes[0]!['x-token']).toBe('static-token-1')
    for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ i }))
    await until(() => frames.length === 5)
    expect(frames).toEqual([0, 1, 2, 3, 4].map((i) => ({ i })))
    await conn.send({ reply: true })
    await until(() => server.received.length === 1)
    expect(server.received[0]).toEqual({ reply: true })
    expect(conn.state).toBe('open')
  })

  it('calls headers() before every (re)connect to refresh tokens', async () => {
    const { connect } = await setup()
    let n = 0
    const conn = connect({ headers: async () => ({ 'X-Token': `token-${++n}-abcdef` }) })
    await conn.whenOpen()
    ;(await server.waitForConnection(1)).terminate()
    await server.waitForConnection(2)
    await until(() => conn.state === 'open')
    expect(server.handshakes.map((h) => h['x-token'])).toEqual(['token-1-abcdef', 'token-2-abcdef'])
  })

  it('never logs the auth header value', async () => {
    const { connect } = await setup()
    const conn = connect({ headers: { Authorization: 'Bearer supersecret-value-xyz' } })
    await conn.whenOpen()
    server.rejectNext(500)
    ;(await server.waitForConnection(1)).terminate()
    await until(() => t.logs.some((l) => l.includes('unexpected handshake response')))
    expect(t.logs.join('\n')).not.toContain('supersecret-value-xyz')
  })

  it('retries when headers() throws or returns an invalid header', async () => {
    const { connect } = await setup()
    let n = 0
    const conn = connect({
      headers: () => {
        n++
        if (n === 1) throw new Error('token service down')
        if (n === 2) return { 'X-Token': 'bad\nvalue' }
        return { 'X-Token': 'good-token-123' }
      },
    })
    await until(() => conn.state === 'open')
    expect(n).toBe(3)
    expect(t.logs.some((l) => l.includes('failed to resolve headers'))).toBe(true)
    expect(t.logs.some((l) => l.includes('failed to create websocket'))).toBe(true)
  })

  it('rejects send() when not open, without queueing', async () => {
    const { connect } = await setup({ ...FAST, reconnect: { initialDelayMs: 5000, maxDelayMs: 5000, jitter: 0 } })
    const conn = connect()
    const early = conn.send({ a: 1 })
    await expect(early).rejects.toMatchObject({ code: 'not_open', retryable: true })
    await conn.whenOpen()
    ;(await server.waitForConnection()).terminate()
    await until(() => conn.state === 'reconnecting')
    await expect(conn.send({ a: 2 })).rejects.toMatchObject({ code: 'not_open' })
    expect(server.received).toEqual([])
  })

  it('drops non-JSON, binary and parse()-rejected frames without disconnecting', async () => {
    const { connect } = await setup()
    const frames: unknown[] = []
    const conn = connect<{ ok: number }>({
      parse: (v) => {
        if (typeof v !== 'object' || v === null || !('ok' in v)) throw new Error('bad frame')
        return v as { ok: number }
      },
      onMessage: (f) => void frames.push(f),
    })
    await conn.whenOpen()
    const ws = await server.waitForConnection()
    ws.send('this is {not json} secret-body')
    ws.send(Buffer.from([1, 2, 3]), { binary: true })
    ws.send(JSON.stringify({ nope: 'secret-body' }))
    ws.send(JSON.stringify({ ok: 1 }))
    await until(() => frames.length === 1)
    expect(frames).toEqual([{ ok: 1 }])
    expect(conn.state).toBe('open')
    const logs = t.logs.join('\n')
    expect(logs).toContain('dropped non-JSON frame')
    expect(logs).toContain('dropped binary frame')
    expect(logs).toContain('dropped frame rejected by parse()')
    expect(logs).not.toContain('secret-body')
  })

  it('disconnects on oversized frames and reconnects', async () => {
    const { connect } = await setup({ ...FAST, maxPayloadBytes: 1024 })
    const frames: unknown[] = []
    const conn = connect({ onMessage: (f) => void frames.push(f) })
    await conn.whenOpen()
    ;(await server.waitForConnection(1)).send(JSON.stringify({ big: 'x'.repeat(4096) }))
    const ws2 = await server.waitForConnection(2)
    await until(() => conn.state === 'open')
    ws2.send(JSON.stringify({ small: 1 }))
    await until(() => frames.length === 1)
    expect(frames).toEqual([{ small: 1 }])
  })
})

describe('message handling', () => {
  it('runs onMessage serially by default', async () => {
    const { connect } = await setup()
    let active = 0
    let maxActive = 0
    const done: number[] = []
    const conn = connect<{ i: number }>({
      onMessage: async (f) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 5))
        done.push(f.i)
        active--
      },
    })
    await conn.whenOpen()
    const ws = await server.waitForConnection()
    for (let i = 0; i < 6; i++) ws.send(JSON.stringify({ i }))
    await until(() => done.length === 6)
    expect(maxActive).toBe(1)
    expect(done).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('runs up to `concurrency` handlers at once', async () => {
    const { connect } = await setup()
    let active = 0
    let maxActive = 0
    const gate = deferred()
    let count = 0
    const conn = connect({
      concurrency: 3,
      onMessage: async () => {
        active++
        count++
        maxActive = Math.max(maxActive, active)
        await gate.promise
        active--
      },
    })
    await conn.whenOpen()
    const ws = await server.waitForConnection()
    for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ i }))
    await until(() => count === 3)
    await flushIo(20)
    expect(active).toBe(3)
    gate.resolve()
    await until(() => count === 5 && active === 0)
    expect(maxActive).toBe(3)
  })

  it('routes onMessage errors to onError (default: log) and keeps the connection', async () => {
    const { connect } = await setup()
    const errors: Array<[unknown, unknown]> = []
    const conn = connect({
      onMessage: (f: any) => {
        if (f.fail) throw new Error('handler failed')
      },
      onError: (err, frame) => void errors.push([err, frame]),
    })
    const conn2 = connect({
      onMessage: () => {
        throw new Error('default handler failed')
      },
    })
    await conn.whenOpen()
    await conn2.whenOpen()
    server.broadcast({ fail: true })
    await until(() => errors.length === 1 && t.logs.some((l) => l.includes('onMessage failed')))
    expect((errors[0]![0] as Error).message).toBe('handler failed')
    expect(errors[0]![1]).toEqual({ fail: true })
    expect(conn.state).toBe('open')
    expect(conn2.state).toBe('open')
  })

  it('pauses socket reads when pending messages exceed maxPendingMessages and resumes below', async () => {
    const { connect, service } = await setup({ ...FAST, maxPendingMessages: 3 })
    const gate = deferred()
    let handled = 0
    const conn = connect({
      onMessage: async () => {
        await gate.promise
        handled++
      },
    })
    await conn.whenOpen()
    const ws = await server.waitForConnection()
    for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ i }))
    await until(() => t.logs.some((l) => l.includes('pausing socket reads')))
    await flushIo(20)
    const pendingAtPause = service().health().counters.pendingMessages
    expect(pendingAtPause).toBeGreaterThan(3)
    // 暂停后新到达的帧不再被读取
    for (let i = 5; i < 10; i++) ws.send(JSON.stringify({ i }))
    await new Promise((r) => setTimeout(r, 50))
    expect(service().health().counters.pendingMessages).toBe(pendingAtPause)
    gate.resolve()
    await until(() => handled === 10)
    expect(t.logs.some((l) => l.includes('resuming socket reads'))).toBe(true)
  })
})

describe('heartbeat and reconnect (fake timers)', () => {
  it('sends pings and reconnects after read timeout without any frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { connect } = await setup()
    // 小步推进伪造时钟，并让真实 I/O 有机会处理
    const advanceUntil = async (check: () => boolean, maxMs: number) => {
      for (let t = 0; t < maxMs && !check(); t += 100) {
        await vi.advanceTimersByTimeAsync(100)
        await flushIo()
      }
      await until(check)
    }
    let pings = 0
    const conn = connect()
    await until(() => conn.state === 'open')
    const ws = await server.waitForConnection(1)
    ws.on('ping', () => pings++)
    await advanceUntil(() => pings >= 2, 3000)
    // 有 pong 时连接保持
    expect(conn.state).toBe('open')
    server.autoPong = false
    await advanceUntil(() => conn.state === 'reconnecting', 3000)
    expect(t.logs.some((l) => l.includes('read timeout'))).toBe(true)
    server.autoPong = true
    await advanceUntil(() => conn.state === 'open', 1000)
    expect(server.clients).toHaveLength(2)
  })

  it('backs off exponentially and resets after the connection is stable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    // 读超时设得足够大：伪造时钟推进期间 pong 无法被处理
    const { connect } = await setup({ ...FAST, readTimeoutMs: 60_000, stableResetMs: 3000 })
    const delays = () => t.logs.filter((l) => l.includes('reconnect scheduled')).map((l) => Number(/"delayMs":(\d+)/.exec(l)![1]))
    const conn = connect()
    await until(() => conn.state === 'open')
    server.rejectNext(503, 3)
    ;(await server.waitForConnection(1)).terminate()
    await until(() => delays().length === 1)
    for (let i = 2; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(delays()[i - 2]!)
      await until(() => delays().length === i)
    }
    await vi.advanceTimersByTimeAsync(delays()[3]!)
    await until(() => conn.state === 'open')
    expect(delays()).toEqual([100, 200, 400, 800])
    // 未稳定就断开：继续退避
    ;(await server.waitForConnection(2)).terminate()
    await until(() => delays().length === 5)
    expect(delays()[4]).toBe(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await until(() => conn.state === 'open')
    // 稳定 stableResetMs 后断开：重置为初始值
    await vi.advanceTimersByTimeAsync(3000)
    ;(await server.waitForConnection(3)).terminate()
    await until(() => delays().length === 6)
    expect(delays()[5]).toBe(100)
  })

  it('treats 401 as fatal, emits service-failed, and slow-retries with fresh headers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { connect, service } = await setup({ ...FAST, fatalRetryDelayMs: 10_000 })
    let n = 0
    const states: ConnectionState[] = []
    server.rejectNext(401)
    const conn = connect({ headers: () => ({ 'X-Token': `tok-${++n}-abcdef` }), onStateChange: (s) => void states.push(s) })
    await until(() => conn.state === 'failed')
    expect(service().health().status).toBe('failed')
    expect(t.failures).toHaveLength(1)
    expect(t.failures[0]).toMatchObject({ service: 'agentWs' })
    expect(t.failures[0]!.detail).toContain('401')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(conn.state).toBe('failed')
    await vi.advanceTimersByTimeAsync(1)
    await until(() => conn.state === 'open')
    expect(n).toBe(2)
    expect(server.handshakes.at(-1)!['x-token']).toBe('tok-2-abcdef')
    expect(service().health().status).toBe('ok')
    expect(states).toEqual(['connecting', 'failed', 'connecting', 'open'])
  })

  it('treats 403 as fatal and does not retry when fatalRetryDelayMs is 0', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { connect } = await setup()
    server.rejectNext(403)
    const conn = connect()
    await until(() => conn.state === 'failed')
    await vi.advanceTimersByTimeAsync(600_000)
    await flushIo()
    expect(conn.state).toBe('failed')
    expect(server.handshakes).toHaveLength(1)
  })
})

describe('fatal close codes', () => {
  it('enters failed when closed with a configured fatal code, reconnects otherwise', async () => {
    const { connect, service } = await setup()
    const conn = connect({ fatalCloseCodes: [4001] })
    await conn.whenOpen()
    ;(await server.waitForConnection(1)).close(4000, 'transient')
    await server.waitForConnection(2)
    await until(() => conn.state === 'open')
    ;(await server.waitForConnection(2)).close(4001, 'bad token')
    await until(() => conn.state === 'failed')
    expect(service().health()).toMatchObject({ status: 'failed' })
    expect(service().health().detail).toContain('4001')
    expect(t.failures).toHaveLength(1)
  })
})

describe('state, health and lifecycle', () => {
  it('reports state transitions and whenOpen semantics', async () => {
    const { connect } = await setup()
    const states: ConnectionState[] = []
    const conn = connect({ onStateChange: (s) => void states.push(s) })
    const aborted = new AbortController()
    const p = conn.whenOpen({ signal: aborted.signal })
    aborted.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    await expect(conn.whenOpen({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted' })
    await conn.whenOpen()
    ;(await server.waitForConnection(1)).terminate()
    await server.waitForConnection(2)
    await until(() => conn.state === 'open')
    await conn.close()
    expect(states).toEqual(['connecting', 'open', 'reconnecting', 'open', 'closed'])
    await expect(conn.whenOpen()).rejects.toMatchObject({ code: 'closed' })
    await expect(conn.send({})).rejects.toMatchObject({ code: 'not_open' })
  })

  it('health() reports counters', async () => {
    const { connect, service } = await setup()
    expect(service().health().status).toBe('ok')
    const conn = connect()
    expect(service().health().status).toBe('degraded')
    await conn.whenOpen()
    ;(await server.waitForConnection()).send(JSON.stringify({ a: 1 }))
    await until(() => service().health().counters.lastFrameAt !== null)
    const h = service().health()
    expect(h.status).toBe('ok')
    expect(h.counters.connections[0]).toMatchObject({ state: 'open', reconnects: 0, url: `${server.url}/` })
  })

  it('closes with 1001 and aborts in-flight onMessage when the caller is unloaded', async () => {
    const { connect, fiber } = await setup()
    let signal: AbortSignal | undefined
    const started = deferred()
    const conn = connect({
      onMessage: async (_f, ctx) => {
        signal = ctx.signal
        started.resolve()
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
      },
    })
    await conn.whenOpen()
    const ws = await server.waitForConnection()
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    ws.send(JSON.stringify({ a: 1 }))
    await started.promise
    await fiber.dispose()
    expect(await closed).toBe(1001)
    expect(signal!.aborted).toBe(true)
    expect(conn.state).toBe('closed')
  })
})
