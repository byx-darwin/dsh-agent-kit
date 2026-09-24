import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { JevService, classify, defaultClientFactory, type JevConfig } from '../../src/jev/service.js'
import { macosKeychain } from '../../src/secrets/keychain.js'
import { SHARED_KEYCHAIN_SERVICE } from '../../src/secrets/typesafe-key.js'
import { choice, noul, score } from '../../src/jev/types.js'
import { clearSecretsForTesting } from '../../src/common/redact.js'
import { createJevMock, defaultAnswers, jevHttpError, type JevMock } from '../../src/testing/jev-mock.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

describe('question constructors', () => {
  it('match the @typesafe-ai/sdk wire format', async () => {
    const sdk = await import('@typesafe-ai/sdk')
    expect(noul('q', { true: 'yes', false: 'no' })).toEqual(sdk.noul('q', { true: 'yes', false: 'no' }))
    expect(noul()).toEqual(sdk.noul())
    expect(choice('pick', { A: 'a', B: null })).toEqual(sdk.choice('pick', { A: 'a', B: null }))
    expect(score('rate', ['bad', 'ok', 'good'])).toEqual(sdk.score('rate', ['bad', 'ok', 'good']))
  })

  it('defaultAnswers produces one typed answer per question', () => {
    const a = defaultAnswers({ n: noul('x'), c: choice('y', { A: null, B: null }), s: score('z', ['0', '1']) }) as any
    expect(a.n).toEqual({ type: 'noul', noul: 0.5 })
    expect(a.c).toMatchObject({ type: 'choice', choice: 'A', probabilities: { A: 1, B: 0 } })
    expect(a.s).toMatchObject({ type: 'score', score: 0, legend: { 0: '0', 1: '1' } })
  })
})

describe('error classification', () => {
  it.each([
    [jevHttpError(500), 'unavailable', true],
    [jevHttpError(503), 'unavailable', true],
    [jevHttpError(408), 'unavailable', true],
    [jevHttpError(429), 'rate_limited', true],
    [jevHttpError(401), 'unauthorized', false],
    [jevHttpError(403), 'unauthorized', false],
    [jevHttpError(400), 'bad_request', false],
    [jevHttpError(422), 'bad_request', false],
    [Object.assign(new Error('x'), { name: 'APIConnectionError' }), 'unavailable', true],
    [Object.assign(new Error('x'), { name: 'APITimeoutError' }), 'unavailable', true],
    [Object.assign(new Error('x'), { name: 'APIUserAbortError' }), 'aborted', false],
    [new Error('questions must not be empty'), 'bad_request', false],
  ])('%s -> %s', (err, code, retryable) => {
    expect(classify(err)).toMatchObject({ service: 'jev', code, retryable })
  })

  it('classifies real SDK errors', async () => {
    const sdk = await import('@typesafe-ai/sdk')
    expect(classify(sdk.APIError.fromResponse(429, {}, new Headers())).code).toBe('rate_limited')
    expect(classify(sdk.APIError.fromResponse(401, {}, new Headers())).code).toBe('unauthorized')
    expect(classify(sdk.APIError.fromResponse(502, {}, new Headers())).code).toBe('unavailable')
    expect(classify(new sdk.APIConnectionError('down')).code).toBe('unavailable')
    expect(classify(new sdk.APITimeoutError(10)).code).toBe('unavailable')
    expect(classify(new sdk.APIUserAbortError()).code).toBe('aborted')
  })
})

describe('JevService', () => {
  let t: TestRoot
  let mock: JevMock
  let restore: () => void
  const savedKey = process.env.TYPESAFE_API_KEY

  beforeEach(() => {
    t = createRoot()
    mock = createJevMock()
    restore = mock.install()
    process.env.TYPESAFE_API_KEY = 'ts-test-api-key-123'
  })

  afterEach(async () => {
    vi.useRealTimers()
    await t.dispose()
    restore()
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = savedKey
    clearSecretsForTesting()
    JevService.keyStore = {}
  })

  async function setup(config: Partial<JevConfig> = {}) {
    await t.root.plugin(JevService, config as never)
    let consumer!: Context
    await t.root.inject(['jev'], (ctx) => {
      consumer = ctx
    })
    return () => consumer.jev
  }

  it('fails to start when no key source has a key', async () => {
    delete process.env.TYPESAFE_API_KEY
    JevService.keyStore = { platform: 'linux', credentialsFile: join(tmpdir(), `agent-kit-none-${process.pid}.yaml`) }
    await expect(t.root.plugin(JevService, {})).rejects.toThrow(/TYPESAFE_API_KEY is not set/)
  })

  it('falls back to the dsh credentials service', async () => {
    delete process.env.TYPESAFE_API_KEY
    JevService.keyStore = { platform: 'linux' }
    let seenKey = ''
    mock.factory = async (opts) => ((seenKey = opts.apiKey), { systemOne: async () => ({ model: 'm', answers: {} }) })
    restore()
    restore = mock.install()
    t.root.provide('credentials', { resolve: async (ref: string) => (ref === 'TYPESAFE_API_KEY' ? { value: 'svc-key-123', source: 'file' } : undefined) } as never)
    await setup()
    expect(seenKey).toBe('svc-key-123')
    expect(t.logs.some((l) => l.includes('"source":"credentials"'))).toBe(true)
  })

  it.each([[{ timeoutMs: 10 }], [{ timeoutMs: 400_000 }]])('rejects invalid config %j', async (config) => {
    await expect(t.root.plugin(JevService, config as never)).rejects.toThrow(/expected/)
  })

  it('applies defaults, assembles the request and maps answers with types', async () => {
    const jev = await setup()
    expect(jev().config).toEqual({ model: 'jev-latest', timeoutMs: 30_000 })
    mock.handler = () => ({
      wrong: { type: 'noul', noul: 0.2 },
      pick: { type: 'choice', choice: 'B', confidence: 0.9, probabilities: { A: 0.1, B: 0.9 } },
    })
    const r = await jev().judge({
      state: { input: 'x', candidate: 'y' },
      questions: { wrong: noul('mismatch?', { true: 'yes', false: 'no' }), pick: choice('which?', { A: 'a', B: 'b' }) },
      traceId: 'evt_1',
    })
    const noulValue: number = r.answers.wrong.noul
    const picked: 'A' | 'B' = r.answers.pick.choice
    expect(noulValue).toBe(0.2)
    expect(picked).toBe('B')
    expect(r.model).toBe('jev-latest')
    expect(r.usage).toEqual({ input_tokens: 1, output_tokens: 1 })
    expect(mock.requests[0]).toEqual({
      state: { input: 'x', candidate: 'y' },
      questions: { wrong: { type: 'noul', instructions: 'mismatch?', criteria: { true: 'yes', false: 'no' } }, pick: { type: 'choice', instructions: 'which?', criteria: { A: 'a', B: 'b' } } },
    })
    await jev().judge({ state: 's', questions: { q: noul('x') }, model: 'jev-2' })
    expect(mock.requests[1]!.model).toBe('jev-2')
    expect(jev().health()).toMatchObject({ status: 'ok', counters: { success: 2, failure: 0 } })
  })

  it('maps errors, marks the service failed on 401 and recovers on success', async () => {
    const jev = await setup()
    const q = { state: 's', questions: { q: noul('x') } }
    mock.handler = () => {
      throw jevHttpError(503)
    }
    await expect(jev().judge(q)).rejects.toMatchObject({ code: 'unavailable', retryable: true })
    mock.handler = () => {
      throw jevHttpError(429)
    }
    await expect(jev().judge(q)).rejects.toMatchObject({ code: 'rate_limited', retryable: true })
    mock.handler = () => {
      throw jevHttpError(400)
    }
    await expect(jev().judge(q)).rejects.toMatchObject({ code: 'bad_request', retryable: false })
    expect(jev().health().status).toBe('ok')
    mock.handler = () => {
      throw jevHttpError(401, 'bad key ts-test-api-key-123')
    }
    const err = await jev().judge(q).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'unauthorized', retryable: false })
    expect(JSON.stringify((err as { toJSON(): unknown }).toJSON())).not.toContain('ts-test-api-key-123')
    expect(jev().health().status).toBe('failed')
    expect(t.failures).toEqual([expect.objectContaining({ service: 'jev' })])
    expect(jev().health().counters.failuresByCode).toEqual({ unavailable: 1, rate_limited: 1, bad_request: 1, unauthorized: 1 })
    mock.handler = (req) => defaultAnswers(req.questions)
    await jev().judge(q)
    expect(jev().health().status).toBe('ok')
    expect(t.logs.join('\n')).not.toContain('ts-test-api-key-123')
  })

  it('enforces timeoutMs as a total deadline including SDK retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const jev = await setup({ timeoutMs: 5000 })
    let signal: AbortSignal | undefined
    mock.handler = (_req, opts) => {
      signal = opts.signal
      return new Promise(() => {}) // 模拟 SDK 内部不断重试
    }
    const p = jev().judge({ state: 's', questions: { q: noul('x') } }).catch((e: unknown) => e)
    await until(() => signal !== undefined)
    await vi.advanceTimersByTimeAsync(4999)
    expect(signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toMatchObject({ code: 'unavailable', retryable: true })
    expect(signal!.aborted).toBe(true)
  })

  it('aborts with the caller signal and on unload', async () => {
    const jev = await setup()
    mock.handler = () => new Promise(() => {})
    const controller = new AbortController()
    const p = jev().judge({ state: 's', questions: { q: noul('x') }, signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted', retryable: false })
    await expect(jev().judge({ state: 's', questions: { q: noul('x') }, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted' })
    const service = jev()
    const pending = service.judge({ state: 's', questions: { q: noul('x') } }).catch((e: unknown) => e)
    await t.root.fiber.dispose()
    expect(await pending).toMatchObject({ code: 'aborted' })
  })

  describe('keychain fallback', () => {
    const saved = { keyStore: JevService.keyStore, user: process.env.USER }
    const calls: Array<[string, string]> = []
    const fakeKeychain = {
      read: async (service: string, account: string) => {
        calls.push([service, account])
        return service === 'gitflow-cli-typesafe' ? 'keychain-api-key-123' : undefined
      },
      write: async () => {},
      remove: async () => {},
    }
    beforeEach(() => {
      calls.length = 0
      JevService.keyStore = { platform: 'darwin', keychain: fakeKeychain }
    })
    afterEach(() => {
      JevService.keyStore = saved.keyStore
      if (saved.user === undefined) delete process.env.USER
      else process.env.USER = saved.user
    })

    it('prefers TYPESAFE_API_KEY and does not read the keychain', async () => {
      await setup({ keychainService: 'gitflow-cli-typesafe' })
      expect(calls).toEqual([])
    })

    it('reads the key from the keychain when the env var is missing, and redacts it', async () => {
      delete process.env.TYPESAFE_API_KEY
      let seenKey = ''
      mock.factory = async (opts) => ((seenKey = opts.apiKey), { systemOne: async () => ({ model: 'm', answers: {} }) })
      restore()
      restore = mock.install()
      const jev = await setup({ keychainService: 'gitflow-cli-typesafe', keychainAccount: 'alice' })
      expect(calls).toEqual([['gitflow-cli-typesafe', 'alice']])
      expect(seenKey).toBe('keychain-api-key-123')
      expect(jev().health().status).toBe('ok')
      expect(t.logs.some((l) => l.includes('api key resolved') && l.includes('keychain:gitflow-cli-typesafe'))).toBe(true)
      expect(t.logs.join('\n')).not.toContain('keychain-api-key-123')
    })

    it('tries multiple service names in order', async () => {
      delete process.env.TYPESAFE_API_KEY
      await setup({ keychainService: ['ai.typesafe.api-key', 'gitflow-cli-typesafe'], keychainAccount: 'alice' })
      expect(calls).toEqual([
        ['ai.typesafe.api-key', 'alice'],
        ['gitflow-cli-typesafe', 'alice'],
      ])
      expect(t.logs.some((l) => l.includes('keychain:gitflow-cli-typesafe'))).toBe(true)
    })

    it('defaults the account to $USER', async () => {
      delete process.env.TYPESAFE_API_KEY
      process.env.USER = 'bob'
      await setup({ keychainService: 'gitflow-cli-typesafe' })
      expect(calls).toEqual([['gitflow-cli-typesafe', 'bob']])
    })

    /**
     * I1 回归测试：Web 端 `JevForm` 从不设置 `keychainService`。之前只在 jev 配置显式给出
     * `keychainService` 时才查钥匙串，导致把 TypeSafe Key 保存到（Web 端保存动作写入的）
     * `SHARED_KEYCHAIN_SERVICE` 之后，`JevService.init` 依然读不到它。这里不配置
     * `keychainService`，确认在 macOS 上默认回退到 `SHARED_KEYCHAIN_SERVICE` 读取。
     */
    it('falls back to SHARED_KEYCHAIN_SERVICE when keychainService is not configured', async () => {
      delete process.env.TYPESAFE_API_KEY
      process.env.USER = 'bob'
      const readable = {
        read: async (service: string, account: string) => {
          calls.push([service, account])
          return service === SHARED_KEYCHAIN_SERVICE ? 'shared-default-key' : undefined
        },
        write: async () => {},
        remove: async () => {},
      }
      JevService.keyStore = { platform: 'darwin', keychain: readable }
      await setup({})
      expect(calls).toEqual([[SHARED_KEYCHAIN_SERVICE, 'bob']])
    })

    it('fails to start when neither the env var nor the keychain item exists', async () => {
      delete process.env.TYPESAFE_API_KEY
      JevService.keyStore = { platform: 'darwin', keychain: fakeKeychain, credentialsFile: join(tmpdir(), `agent-kit-none-${process.pid}.yaml`) }
      await expect(t.root.plugin(JevService, { keychainService: 'missing-service' })).rejects.toThrow(/TYPESAFE_API_KEY is not set/)
      await expect(t.root.plugin(JevService, { keychainService: ['a.b', 'c.d'] })).rejects.toThrow(/TYPESAFE_API_KEY is not set/)
    })

    it('ignores keychainService outside macOS', async () => {
      delete process.env.TYPESAFE_API_KEY
      JevService.keyStore = { platform: 'linux', keychain: fakeKeychain, credentialsFile: join(tmpdir(), `agent-kit-none-${process.pid}.yaml`) }
      await expect(t.root.plugin(JevService, { keychainService: 'gitflow-cli-typesafe' })).rejects.toThrow(/TYPESAFE_API_KEY is not set/)
      expect(calls).toEqual([])
      expect(t.logs.some((l) => l.includes('only supported on macOS'))).toBe(true)
    })

    it('rejects invalid keychain names', async () => {
      await expect(t.root.plugin(JevService, { keychainService: 'a b; rm' } as never)).rejects.toThrow(/invalid config[\s\S]*keychainService/)
    })

    it.skipIf(process.platform !== 'darwin')('real macOS keychain returns undefined for a missing item', async () => {
      expect(await macosKeychain.read('dsh-agent-kit-nonexistent-service', 'nobody')).toBeUndefined()
    })
  })

  it('creates a real SDK client with the configured model and without logging bodies', async () => {
    const client = (await defaultClientFactory({ apiKey: 'k-123456', model: 'jev-x', timeoutMs: 1234 })) as any
    expect(client.defaultModel).toBe('jev-x')
    expect(client.timeout).toBe(1234)
    expect(client.logLevel).toBe('off')
  })
})
