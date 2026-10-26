import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore, MAX_CONVERSATIONS } from '../../src/wecom/conversations.js'
import { parseWecomFrame, type WecomAtMessage } from '../../src/wecom/event.js'
import { WecomService } from '../../src/wecom/service.js'
import { createFakeWecomSdk, useFakeWecomSdk, type FakeWecom } from '../../src/testing/fake-wecom.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

const frame = (id: string, body: Record<string, unknown>) => ({ cmd: 'aibot_msg_callback', headers: { req_id: `req-${id}` }, body: { msgid: id, aibotid: 'bot1', from: { userid: 'zhangsan' }, create_time: 1700000000, ...body } })
const groupText = (id: string, chatid: string, content: string) => frame(id, { chatid, chattype: 'group', msgtype: 'text', text: { content } })
const singleText = (id: string, content: string) => frame(id, { chattype: 'single', msgtype: 'text', text: { content } })

describe('parseWecomFrame', () => {
  it('maps group and single text messages, stripping the leading @ in groups and keeping newlines', () => {
    expect(parseWecomFrame(groupText('m1', 'wrkG', '@告警机器人 第一行\n第二行'))?.message).toEqual({
      eventId: 'm1', messageId: 'm1', conversationId: 'wrkG', chatType: 'group', senderId: 'zhangsan', content: '第一行\n第二行', messageType: 'text', timestamp: 1700000000000,
    })
    expect(parseWecomFrame(singleText('m2', '你好'))?.message).toMatchObject({ conversationId: 'zhangsan', chatType: 'single', content: '你好' })
  })

  it('extracts mixed text, voice transcripts and quotes; other types are empty', () => {
    expect(parseWecomFrame(frame('m3', { chattype: 'single', msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: 'a' } }, { msgtype: 'image', image: { url: 'u' } }, { msgtype: 'text', text: { content: 'b' } }] } }))?.message.content).toBe('a\nb')
    expect(parseWecomFrame(frame('m4', { chattype: 'single', msgtype: 'voice', voice: { content: '语音转写' } }))?.message.content).toBe('语音转写')
    expect(parseWecomFrame(frame('m5', { chattype: 'single', msgtype: 'text', text: { content: '回复' }, quote: { msgtype: 'text', text: { content: '原文' } } }))?.message.quote).toBe('原文')
    expect(parseWecomFrame(frame('m6', { chattype: 'single', msgtype: 'image', image: { url: 'u' } }))?.message).toMatchObject({ content: '', messageType: 'image' })
  })

  it('rejects malformed frames', () => {
    expect(parseWecomFrame(null)).toBeUndefined()
    expect(parseWecomFrame({ headers: { req_id: 'r' }, body: { msgtype: 'text' } })).toBeUndefined()
    expect(parseWecomFrame(frame('m7', { chattype: 'group', msgtype: 'text', text: { content: 'x' } }))).toBeUndefined() // 群消息缺 chatid
  })
})

describe('ConversationStore', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wecom-conv-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records, updates, evicts the oldest beyond the cap, and persists privately', async () => {
    const file = join(dir, 'c', 'conv.json')
    const store = new ConversationStore(file, () => {})
    for (let i = 0; i < MAX_CONVERSATIONS + 3; i++) await store.record({ conversationId: `c${i}`, chatType: 'group', at: i })
    await store.record({ conversationId: 'c0', chatType: 'group', lastSenderId: 'u', at: 10_000 })
    const items = await new ConversationStore(file, () => {}).list()
    expect(items).toHaveLength(MAX_CONVERSATIONS)
    expect(items[0]).toMatchObject({ conversationId: 'c0', lastSenderId: 'u' })
    expect(items.some((c) => c.conversationId === 'c1')).toBe(false)
    expect(await store.has('c0')).toBe(true)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps every entry under concurrent records and holds the cap', async () => {
    const file = join(dir, 'conc.json')
    const store = new ConversationStore(file, () => {})
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.record({ conversationId: `k${i}`, chatType: 'single', at: i })))
    expect(await new ConversationStore(file, () => {}).list()).toHaveLength(20)
    const big = join(dir, 'big.json')
    const bigStore = new ConversationStore(big, () => {})
    await Promise.all(Array.from({ length: MAX_CONVERSATIONS + 20 }, (_, i) => bigStore.record({ conversationId: `b${i}`, chatType: 'group', at: i })))
    const items = await new ConversationStore(big, () => {}).list()
    expect(items).toHaveLength(MAX_CONVERSATIONS)
    expect(items.some((c) => c.conversationId === 'b0')).toBe(false)
    expect(items.some((c) => c.conversationId === `b${MAX_CONVERSATIONS + 19}`)).toBe(true)
  })
})

describe('WecomService inbox', () => {
  let root: TestRoot
  let fake: FakeWecom
  let restore: () => void
  let dir: string
  const savedEnv = { ...process.env }

  beforeEach(() => {
    root = createRoot()
    dir = mkdtempSync(join(tmpdir(), 'wecom-'))
    root.root.baseUrl = pathToFileURL(`${dir}/`).href
    process.env.WECOM_BOT_SECRET = 'secret-value'
    fake = createFakeWecomSdk()
    restore = useFakeWecomSdk(fake)
  })
  afterEach(async () => {
    await root.dispose()
    restore()
    rmSync(dir, { recursive: true, force: true })
    process.env = { ...savedEnv }
  })

  it('queues until authenticated, routes by conversation, and replies through the inbound frame', async () => {
    await root.root.plugin(WecomService, { botId: 'bot1' })
    const got: WecomAtMessage[] = []
    let replied: unknown
    await root.root.plugin({ name: 'biz', inject: ['wecom'], apply(ctx: Context) {
      ctx.wecom.onMessage({ conversationId: 'wrkG' }, async (m, { reply }) => { got.push(m); replied = await reply({ text: 'pong' }) })
    } })
    await fake.emit(groupText('m1', 'wrkG', '@bot ping'))
    expect(got).toHaveLength(0)
    fake.authenticate()
    await until(() => replied !== undefined)
    expect(got[0]).toMatchObject({ content: 'ping', chatType: 'group' })
    expect(fake.replies).toEqual([{ frame: expect.objectContaining({ headers: { req_id: 'req-m1' } }), streamId: expect.any(String), content: 'pong' }])
    expect(replied).toEqual({ results: [{ ok: true, messageId: 'req-m1' }] })
  })

  it('records talked-to conversations, finds them in searchRecipients, and uses them to classify 846607', async () => {
    await root.root.plugin(WecomService, { botId: 'bot1' })
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    await fake.emit(groupText('m1', 'wrkOps', 'hi'))
    await fake.emit(singleText('m2', 'hi'))
    await until(async () => (await wecom.searchRecipients('user', 'zhang')).candidates.length === 1)
    expect(await wecom.searchRecipients('group', 'Ops')).toEqual({ candidates: [{ name: 'wrkOps', target: { chatId: 'wrkOps' } }], complete: true })
    expect(await wecom.searchRecipients('user', 'zhang')).toEqual({ candidates: [{ name: 'zhangsan', target: { userId: 'zhangsan' } }], complete: true })
    fake.setSend([{ errcode: 846607, errmsg: 'limited' }])
    expect((await wecom.send({ text: 'x', target: { chatId: 'wrkOps' } })).results[0]).toMatchObject({ error: { code: 'rate_limited' } })
    expect((await wecom.send({ text: 'x', target: { chatId: 'wrkNever' } })).results[0]).toMatchObject({ error: { code: 'not_interacted' } })
    await expect(wecom.searchRecipients('group', '')).rejects.toThrow(/1–80/)
  })

  it('delivers configured conversations to plugins and records unmatched messages', async () => {
    await root.root.plugin(WecomService, { botId: 'bot1', groupRoutes: [{ conversationId: 'wrkG', pluginId: 'orders' }] })
    const wecom = root.root.get('wecom')!
    const got: string[] = []
    wecom.onPluginMessage('orders', (m) => { got.push(m.eventId) })
    fake.authenticate()
    await fake.emit(groupText('m1', 'wrkG', 'a'))
    await fake.emit(groupText('m2', 'wrkOther', '没人处理'))
    await until(async () => got.length === 1 && (await wecom.unmatchedMessages()).length === 1)
    expect(await wecom.unmatchedMessages()).toMatchObject([{ eventId: 'm2', conversationId: 'wrkOther', senderId: 'zhangsan', preview: '没人处理' }])
  })

  it('maps lifecycle: starting degraded, reconnecting degraded, auth error failed, kicked failed with a clear reason', async () => {
    const fork = await root.root.plugin(WecomService, { botId: 'bot1' })
    const wecom = root.root.get('wecom')!
    expect(wecom.health()).toMatchObject({ status: 'degraded', detail: expect.stringContaining('starting') })
    const sub = wecom.onMessage({ conversationId: 'wrkG' }, () => {})
    fake.authenticate()
    await sub.ready
    expect(wecom.health().status).toBe('ok')
    fake.reconnecting()
    expect(wecom.health()).toMatchObject({ status: 'degraded', detail: expect.stringContaining('reconnecting') })
    fake.authenticate()
    fake.kick()
    expect(wecom.health()).toMatchObject({ status: 'failed', detail: expect.stringContaining('另一个进程') })
    expect(root.failures.some((f) => f.service === 'wecom')).toBe(true)
    await fork.dispose()
    expect(fake.disconnected()).toBe(true)
  })

  it('rejects pending ready on auth failure', async () => {
    const fork = await root.root.plugin(WecomService, { botId: 'bot1' })
    const wecom = root.root.get('wecom')!
    const first = wecom.onMessage({ conversationId: 'a' }, () => {})
    fake.error(new Error('Max auth failure attempts reached'))
    await expect(first.ready).rejects.toThrow(/auth/i)
    expect(wecom.health().status).toBe('failed')
    await fork.dispose()
  })

  it('refuses duplicate routes and listening in dryRun', async () => {
    await expect(root.root.plugin(WecomService, { botId: 'bot1', groupRoutes: [{ conversationId: 'x', pluginId: 'a' }, { conversationId: 'x', pluginId: 'b' }] })).rejects.toThrow(/duplicate group route/)
    await root.root.plugin(WecomService, { botId: 'bot1', dryRun: true })
    expect(() => root.root.get('wecom')!.onMessage({ conversationId: 'x' }, () => {})).toThrow(/dryRun/)
  })
  it('keeps failed sticky across reconnecting until re-authenticated', async () => {
    await root.root.plugin(WecomService, { botId: 'bot1' })
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    fake.kick()
    fake.reconnecting()
    expect(wecom.health().status).toBe('failed')
    expect(wecom.health().counters?.inbox.listener).toBe('failed')
    fake.authenticate()
    expect(wecom.health().status).toBe('ok')
    expect(wecom.health().counters?.inbox.listener).toBe('ready')
  })

  it('rejects pending ready on unload', async () => {
    const fork = await root.root.plugin(WecomService, { botId: 'bot1' })
    const wecom = root.root.get('wecom')!
    const sub = wecom.onMessage({ conversationId: 'a' }, () => {})
    const assertion = expect(sub.ready).rejects.toThrow(/stopped/)
    await fork.dispose()
    await assertion
  })

  it('logs conversation record failures and still delivers the message', async () => {
    const spy = vi.spyOn(ConversationStore.prototype, 'record').mockRejectedValueOnce(new Error('disk full'))
    await root.root.plugin(WecomService, { botId: 'bot1' })
    const got: string[] = []
    root.root.get('wecom')!.onMessage({ conversationId: 'wrkG' }, (m) => { got.push(m.eventId) })
    fake.authenticate()
    await fake.emit(groupText('m1', 'wrkG', 'hi'))
    await until(() => got.length === 1)
    await until(() => root.logs.some((l) => l.includes('wecom conversation record failed')))
    spy.mockRestore()
  })

  it('returns api_error without throwing when the inbound frame was evicted', async () => {
    await root.root.plugin(WecomService, { botId: 'bot1' })
    const replies: Array<(o: { text: string }) => Promise<any>> = []
    root.root.get('wecom')!.onMessage({ conversationId: 'wrkG' }, (_m, { reply }) => { replies.push(reply as never) })
    fake.authenticate()
    for (let i = 0; i < 1001; i++) await fake.emit(groupText(`e${i}`, 'wrkG', 'x'))
    await until(() => replies.length === 1001, 15000)
    const result = await replies[0]!({ text: 'late' })
    expect(result.results[0]).toMatchObject({ ok: false, error: { code: 'api_error' } })
    expect(fake.replies).toHaveLength(0)
  }, 30000)
})
