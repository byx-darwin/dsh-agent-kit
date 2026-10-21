import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FeishuService } from '../../src/feishu/service.js'
import { buildCreateMessage } from '../../src/feishu/message.js'
import { createFakeFeishuSdk, useFakeFeishuSdk, type FakeFeishu } from '../../src/testing/fake-feishu.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('buildCreateMessage', () => {
  it('builds a text message with mentions appended', () => {
    const r = buildCreateMessage({ target: { chatId: 'oc_1' }, text: 'hi', at: { openIds: ['ou_a'], all: true }, idempotencyKey: 'evt-1' })
    expect(r.params.receive_id_type).toBe('chat_id')
    expect(r.data).toMatchObject({ receive_id: 'oc_1', msg_type: 'text', uuid: 'evt-1' })
    expect(JSON.parse(r.data.content)).toEqual({ text: 'hi <at user_id="ou_a"></at> <at user_id="all"></at>' })
  })

  it('builds a markdown card with a title and card-style mentions', () => {
    const r = buildCreateMessage({ target: { openId: 'ou_x' }, title: '告警', markdown: '**down**', at: { openIds: ['ou_a'] } })
    expect(r.params.receive_id_type).toBe('open_id')
    expect(r.data.msg_type).toBe('interactive')
    expect(JSON.parse(r.data.content)).toEqual({
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '告警' } },
      body: { elements: [{ tag: 'markdown', content: '**down** <at id=ou_a></at>' }] },
    })
  })

  it('rejects bad targets, bad keys, and missing or doubled bodies', () => {
    expect(() => buildCreateMessage({ text: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: '-oc' }, text: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: 'oc_1' } })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: 'oc_1' }, text: 'a', markdown: 'b' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: 'oc_1' }, text: 'a', idempotencyKey: 'x'.repeat(51) })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: 'oc_1' }, text: 'a', at: { openIds: ['bad id'] } })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
  })
})

describe('FeishuService send', () => {
  let root: TestRoot
  let fake: FakeFeishu
  let restore: () => void
  const savedEnv = { ...process.env }
  const config = { appId: 'cli_test', defaultTarget: { chatId: 'oc_default' } }

  beforeEach(() => {
    root = createRoot()
    process.env.FEISHU_APP_SECRET = 'secret-value'
    fake = createFakeFeishuSdk({ botName: '告警机器人', botOpenId: 'ou_bot' })
    restore = useFakeFeishuSdk(fake)
  })
  afterEach(async () => {
    await root.dispose()
    restore()
    process.env = { ...savedEnv }
  })

  it('sends to the default target and returns the message id', async () => {
    await root.root.plugin(FeishuService, config)
    const r = await root.root.get('feishu')!.send({ text: 'hello' })
    expect(r.results).toEqual([{ ok: true, messageId: 'om_1' }])
    expect(fake.sends[0]!.data.receive_id).toBe('oc_default')
  })

  it('maps API error codes and only retries with an idempotency key', async () => {
    await root.root.plugin(FeishuService, { ...config, retry: { maxAttempts: 1 } })
    const feishu = root.root.get('feishu')!
    fake.setSend([{ code: 99991400, msg: 'rate limited' }, { messageId: 'om_2' }])
    expect((await feishu.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'rate_limited', retryable: true } })
    fake.setSend([{ code: 99991400, msg: 'rate limited' }, { messageId: 'om_3' }])
    expect((await feishu.send({ text: 'x', idempotencyKey: 'k1' })).results).toEqual([{ ok: true, messageId: 'om_3' }])
    fake.setSend([{ code: 230002, msg: 'bot not in chat' }])
    expect((await feishu.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'permission_denied', retryable: false } })
    fake.setSend([{ throw: { status: 503 } }])
    expect((await feishu.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'api_error', retryable: true } })
    fake.setSend([{ throw: 'network' }])
    expect((await feishu.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'network', retryable: true } })
    expect(feishu.health()).toMatchObject({ status: 'degraded' })
  })

  it('throws on invalid input instead of returning a result', async () => {
    await root.root.plugin(FeishuService, config)
    await expect(root.root.get('feishu')!.send({ text: 'x', target: { chatId: 'has space' } })).rejects.toMatchObject({ code: 'invalid_target' })
  })

  it('does not call the API in dryRun', async () => {
    await root.root.plugin(FeishuService, { ...config, dryRun: true })
    expect((await root.root.get('feishu')!.send({ text: 'x' })).results).toEqual([{ ok: true }])
    expect(fake.sends).toHaveLength(0)
  })

  it('reports bot identity and online state, and has no login', async () => {
    await root.root.plugin(FeishuService, config)
    const feishu = root.root.get('feishu')!
    expect(await feishu.status()).toMatchObject({ channel: 'feishu', identity: 'bot', online: false, account: '告警机器人' })
    fake.ready()
    expect(await feishu.status()).toMatchObject({ online: true })
    expect('login' in feishu).toBe(false)
  })

  it('times out a hanging send as a retryable timeout', async () => {
    await root.root.plugin(FeishuService, { ...config, timeoutMs: 1000 })
    fake.setSend([{ throw: 'hang' }])
    expect((await root.root.get('feishu')!.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } })
  })

  it('does not call the API when the caller signal is already aborted', async () => {
    await root.root.plugin(FeishuService, config)
    const r = await root.root.get('feishu')!.send({ text: 'x', signal: AbortSignal.abort() })
    expect(r.results[0]).toMatchObject({ ok: false, error: { code: 'aborted', retryable: false } })
    expect(fake.sends).toHaveLength(0)
  })

  it('stops retrying when aborted during backoff', async () => {
    await root.root.plugin(FeishuService, config)
    fake.setSend([{ code: 99991400, msg: 'rate limited' }, { messageId: 'om_9' }])
    const ac = new AbortController()
    const p = root.root.get('feishu')!.send({ text: 'x', idempotencyKey: 'k', signal: ac.signal })
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    expect((await p).results[0]).toMatchObject({ ok: false, error: { code: 'aborted', retryable: false } })
    expect(fake.sends).toHaveLength(1)
  })

  it('marks the service failed when the credential check fails', async () => {
    fake = createFakeFeishuSdk({ authCode: 99991663 })
    restore()
    restore = useFakeFeishuSdk(fake)
    await root.root.plugin(FeishuService, config)
    const feishu = root.root.get('feishu')!
    expect(feishu.health().status).toBe('failed')
    expect((await feishu.status()).online).toBe(false)
    expect(fake.started()).toBe(0)
  })

  it('fails to start without a resolvable secret', async () => {
    delete process.env.FEISHU_APP_SECRET
    FeishuService.keyStore = { credentialsFile: '/nonexistent/credentials.yaml' }
    try {
      await expect(root.root.plugin(FeishuService, config)).rejects.toThrow(/FEISHU_APP_SECRET is not set/)
    } finally {
      FeishuService.keyStore = {}
    }
  })

  it('fails to start without appId', async () => {
    await expect(root.root.plugin(FeishuService, {} as never)).rejects.toThrow(/appId/)
  })
})
