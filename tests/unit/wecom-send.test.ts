import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildContent, resolveTarget, MAX_CONTENT_BYTES } from '../../src/wecom/message.js'
import { formatSdkLog } from '../../src/wecom/sdk.js'
import { classifyErrcode } from '../../src/wecom/errors.js'
import { WecomService } from '../../src/wecom/service.js'
import { createFakeWecomSdk, useFakeWecomSdk, type FakeWecom } from '../../src/testing/fake-wecom.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('wecom message building', () => {
  it('renders text and markdown as markdown, title as a bold first line, and mentions', () => {
    expect(buildContent({ text: 'hi' })).toBe('hi')
    expect(buildContent({ title: '告警', markdown: '**down**' })).toBe('**告警**\n\n**down**')
    expect(buildContent({ text: 'x', at: { userIds: ['zhangsan'], all: true } })).toBe('x <@zhangsan> <@all>')
  })

  it('validates bodies, sizes and targets', () => {
    expect(() => buildContent({})).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildContent({ text: 'a', markdown: 'b' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildContent({ text: '字'.repeat(Math.floor(MAX_CONTENT_BYTES / 3) + 1) })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(resolveTarget({ chatId: 'wrkXYZ' })).toEqual({ chatid: 'wrkXYZ', conversationId: 'wrkXYZ', chatType: 'group' })
    expect(resolveTarget({ userId: 'zhangsan' })).toEqual({ chatid: 'zhangsan', conversationId: 'zhangsan', chatType: 'single' })
    expect(() => resolveTarget(undefined)).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => resolveTarget({ chatId: 'has space' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => resolveTarget({ userId: '-x' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
  })

  it('classifies documented errcodes, using interaction history for 846607', () => {
    expect(classifyErrcode(853000, 'x', false).code).toBe('auth_failed')
    expect(classifyErrcode(93008, 'x', false).code).toBe('invalid_target')
    expect(classifyErrcode(846607, 'x', false).code).toBe('not_interacted')
    expect(classifyErrcode(846607, 'x', true)).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(classifyErrcode(45009, 'x', true)).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(classifyErrcode(123456, 'x', true)).toMatchObject({ code: 'api_error', retryable: false })
  })
})

describe('wecom sdk log formatting', () => {
  it('keeps message bodies out of SDK log lines', () => {
    const a = formatSdkLog(['[server -> plugin] cmd=aibot_msg_callback, reqId=r1, body={"text":{"content":"秘密内容"}}'])
    expect(a).toContain('cmd=aibot_msg_callback')
    expect(a).toContain('reqId=r1')
    expect(a).toContain('body=[omitted]')
    expect(a).not.toContain('秘密内容')
    const b = formatSdkLog(['Received unknown frame: {"headers":{"req_id":"x"},"body":{"secret":"s"}}'])
    expect(b).not.toContain('secret')
    expect(b).toContain('[json omitted]')
    const c = formatSdkLog([{ errcode: 846607, errmsg: 'limited', body: { content: 'x' } }])
    expect(c).toBe('errcode=846607 errmsg=limited')
    expect(c).not.toContain('content')
  })
})

describe('WecomService send', () => {
  let root: TestRoot
  let fake: FakeWecom
  let restore: () => void
  const savedEnv = { ...process.env }
  const config = { botId: 'bot1', defaultTarget: { chatId: 'wrkGroup' } }

  beforeEach(() => {
    root = createRoot()
    process.env.WECOM_BOT_SECRET = 'secret-value'
    fake = createFakeWecomSdk()
    restore = useFakeWecomSdk(fake)
  })
  afterEach(async () => {
    await root.dispose()
    restore()
    process.env = { ...savedEnv }
  })

  it('returns not_connected before authentication and sends markdown once connected', async () => {
    await root.root.plugin(WecomService, config)
    const wecom = root.root.get('wecom')!
    expect((await wecom.send({ text: 'hello' })).results[0]).toMatchObject({ ok: false, error: { code: 'not_connected', retryable: true } })
    fake.authenticate()
    expect((await wecom.send({ text: 'hello' })).results).toEqual([{ ok: true, messageId: expect.any(String) }])
    expect(fake.sends.at(-1)).toEqual({ chatid: 'wrkGroup', body: { msgtype: 'markdown', markdown: { content: 'hello' } } })
  })

  it('dedupes by idempotencyKey within the process and does not retry', async () => {
    await root.root.plugin(WecomService, config)
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    const first = await wecom.send({ text: 'x', idempotencyKey: 'k1' })
    const second = await wecom.send({ text: 'x', idempotencyKey: 'k1' })
    expect(second).toEqual(first)
    expect(fake.sends).toHaveLength(1)
    fake.setSend([{ errcode: 45009, errmsg: 'freq' }, {}])
    expect((await wecom.send({ text: 'y', idempotencyKey: 'k2' })).results[0]).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
    expect(fake.sends).toHaveLength(2)
    // 失败结果不进去重缓存：同一 key 再发会再次到达 SDK
    expect((await wecom.send({ text: 'y', idempotencyKey: 'k2' })).results[0]).toMatchObject({ ok: true })
    expect(fake.sends).toHaveLength(3)
  })

  it('maps a 846607 to an unknown conversation as not_interacted', async () => {
    await root.root.plugin(WecomService, config)
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    fake.setSend([{ errcode: 846607, errmsg: 'limited' }])
    expect((await wecom.send({ text: 'x', target: { chatId: 'wrkNew' } })).results[0]).toMatchObject({ ok: false, error: { code: 'not_interacted' } })
    expect(wecom.health()).toMatchObject({ status: 'degraded' })
  })

  it('times out and aborts without retrying', async () => {
    await root.root.plugin(WecomService, { ...config, timeoutMs: 1000 })
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    fake.setSend([{ throw: 'timeout' }])
    expect((await wecom.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } })
    const aborted = new AbortController()
    aborted.abort()
    expect((await wecom.send({ text: 'x', signal: aborted.signal })).results[0]).toMatchObject({ ok: false, error: { code: 'aborted', retryable: false } })
  })

  it('does not call the SDK in dryRun and reports bot status', async () => {
    await root.root.plugin(WecomService, { ...config, dryRun: true })
    const wecom = root.root.get('wecom')!
    expect((await wecom.send({ text: 'x' })).results).toEqual([{ ok: true }])
    expect(fake.sends).toHaveLength(0)
    expect(await wecom.status()).toMatchObject({ channel: 'wecom', identity: 'bot', online: false, account: 'bot1' })
    expect('login' in wecom).toBe(false)
  })

  it('fails to start without a secret or a botId', async () => {
    delete process.env.WECOM_BOT_SECRET
    WecomService.keyStore = { credentialsFile: '/nonexistent/credentials.yaml' }
    try {
      await expect(root.root.plugin(WecomService, config)).rejects.toThrow(/WECOM_BOT_SECRET is not set/)
      await expect(root.root.plugin(WecomService, {} as never)).rejects.toThrow(/botId/)
    } finally {
      WecomService.keyStore = {}
    }
  })
})
