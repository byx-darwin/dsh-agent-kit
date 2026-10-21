import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFeishuEvent, type FeishuAtMessage } from '../../src/feishu/event.js'
import { FeishuService } from '../../src/feishu/service.js'
import { createFakeFeishuSdk, useFakeFeishuSdk, type FakeFeishu } from '../../src/testing/fake-feishu.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

const textEvent = (id: string, chatId: string, text: string, over: Record<string, unknown> = {}) => ({
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: id,
    chat_id: chatId,
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '告警机器人' }, { key: '@_user_2', id: { open_id: 'ou_a' }, name: '张三' }],
    create_time: '1700000000000',
    ...over,
  },
})

describe('parseFeishuEvent', () => {
  it('maps a group text message and replaces mention placeholders, dropping the bot mention', () => {
    expect(parseFeishuEvent(textEvent('om_1', 'oc_1', '@_user_1 请 @_user_2 处理'), 'ou_bot')).toEqual({
      eventId: 'om_1', messageId: 'om_1', conversationId: 'oc_1', chatType: 'group', senderId: 'ou_sender',
      content: '请 @张三 处理', messageType: 'text',
      mentions: [{ openId: 'ou_bot', name: '告警机器人' }, { openId: 'ou_a', name: '张三' }], timestamp: 1700000000000,
    })
  })

  it('extracts the text of post messages and leaves other types empty', () => {
    const post = { title: '日报', content: [[{ tag: 'text', text: '第一行' }, { tag: 'at', user_id: 'ou_bot' }], [{ tag: 'a', text: '链接', href: 'https://x' }]] }
    expect(parseFeishuEvent(textEvent('om_2', 'oc_1', '', { message_type: 'post', content: JSON.stringify(post) }), 'ou_bot')?.content).toBe('日报\n第一行\n链接')
    expect(parseFeishuEvent(textEvent('om_3', 'oc_1', '', { message_type: 'image', content: JSON.stringify({ image_key: 'k' }) }))).toMatchObject({ content: '', messageType: 'image' })
  })

  it('replaces mention placeholders in a single pass without prefix collisions', () => {
    const mentions = Array.from({ length: 11 }, (_, i) => ({ key: `@_user_${i + 1}`, id: { open_id: i === 0 ? 'ou_bot' : `ou_${i + 1}` }, name: i === 0 ? 'Bot' : `U${i + 1}` }))
    const event = textEvent('om_6', 'oc_1', '@_user_1 hi @_user_10 and @_user_11 and @_user_2 @_user_2', { mentions })
    expect(parseFeishuEvent(event, 'ou_bot')?.content).toBe('hi @U10 and @U11 and @U2 @U2')
    expect(parseFeishuEvent(textEvent('om_7', 'oc_1', '@_user_2 @_user_2', { mentions }), 'ou_bot')?.content).toBe('@U2 @U2')
  })

  it('keeps line breaks in text messages', () => {
    expect(parseFeishuEvent(textEvent('om_8', 'oc_1', '@_user_1 第一行\n  第二行  '), 'ou_bot')?.content).toBe('第一行\n第二行')
  })

  it('accepts the SDK payload wrapped in `event` and rejects malformed payloads', () => {
    expect(parseFeishuEvent({ event: textEvent('om_4', 'oc_1', 'hi') })?.eventId).toBe('om_4')
    expect(parseFeishuEvent({ message: { chat_id: 'oc_1' } })).toBeUndefined()
    expect(parseFeishuEvent(textEvent('om_5', 'oc_1', 'x', { content: 'not json' }))).toBeUndefined()
    expect(parseFeishuEvent(null)).toBeUndefined()
  })
})

describe('FeishuService inbox', () => {
  let root: TestRoot
  let fake: FakeFeishu
  let restore: () => void
  let dir: string
  const savedEnv = { ...process.env }

  beforeEach(() => {
    root = createRoot()
    dir = mkdtempSync(join(tmpdir(), 'feishu-'))
    root.root.baseUrl = pathToFileURL(`${dir}/`).href
    process.env.FEISHU_APP_SECRET = 'secret-value'
    fake = createFakeFeishuSdk({ botName: '告警机器人', botOpenId: 'ou_bot', chats: [{ chatId: 'oc_other', name: '研发群' }, { chatId: 'oc_ops', name: '运维值班群' }] })
    restore = useFakeFeishuSdk(fake)
  })
  afterEach(async () => {
    await root.dispose()
    restore()
    rmSync(dir, { recursive: true, force: true })
    process.env = { ...savedEnv }
  })

  it('queues messages until the connection is ready, then routes by conversation', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const got: FeishuAtMessage[] = []
    await root.root.plugin({ name: 'biz', inject: ['feishu'], apply(ctx: Context) { ctx.feishu.onMessage({ conversationId: 'oc_1' }, (m) => { got.push(m) }) } })
    const feishu = root.root.get('feishu')!
    await fake.emit(textEvent('om_1', 'oc_1', 'hello'))
    expect(got).toHaveLength(0)
    fake.ready()
    await until(() => got.length === 1)
    expect(got[0]).toMatchObject({ eventId: 'om_1', content: 'hello', chatType: 'group' })
    await fake.emit(textEvent('om_1', 'oc_1', 'hello'))
    expect(feishu.health().counters.inbox).toMatchObject({ listener: 'ready', duplicate: 1, routes: 1 })
  })

  it('delivers configured conversations to the business plugin and records unmatched ones with names', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test', groupRoutes: [{ conversationId: 'oc_1', pluginId: 'orders' }] })
    const feishu = root.root.get('feishu')!
    const got: string[] = []
    feishu.onPluginMessage('orders', (m) => { got.push(m.eventId) })
    fake.ready()
    await fake.emit(textEvent('om_1', 'oc_1', 'a'))
    await fake.emit(textEvent('om_2', 'oc_other', '没人处理'))
    await until(async () => got.length === 1 && (await feishu.unmatchedMessages())[0]?.conversationName === '研发群')
    expect(await feishu.unmatchedMessages()).toMatchObject([{ eventId: 'om_2', conversationId: 'oc_other', conversationName: '研发群', senderId: 'ou_sender', preview: '没人处理' }])
  })

  it('reports reconnecting as degraded and errors as failed with a service-failed event', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    fake.ready()
    expect(feishu.health().status).toBe('ok')
    fake.reconnecting()
    expect(feishu.health()).toMatchObject({ status: 'degraded', detail: expect.stringContaining('reconnecting') })
    fake.reconnected()
    expect(feishu.health().status).toBe('ok')
    fake.error(new Error('gave up'))
    expect(feishu.health().status).toBe('failed')
    expect(root.failures.some((f) => f.service === 'feishu')).toBe(true)
  })

  it('drops malformed events and closes the connection on unload', async () => {
    const fork = await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    fake.ready()
    await fake.emit({ nope: true })
    expect(feishu.health().counters.inbox.dropped).toBe(1)
    await fork.dispose()
    expect(fake.closed()).toBe(true)
  })

  it('searches groups the bot belongs to and refuses user search', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    expect(await feishu.searchRecipients('group', '运维')).toEqual({ candidates: [{ name: '运维值班群', target: { chatId: 'oc_ops' } }], complete: true })
    await expect(feishu.searchRecipients('user', '张三')).rejects.toThrow(/open_id/)
    await expect(feishu.searchRecipients('group', 'x')).rejects.toThrow(/2–80/)
  })

  it('reports starting (degraded) until the long connection is first ready', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    expect(feishu.health()).toMatchObject({ status: 'degraded', detail: 'feishu long connection starting' })
    fake.ready()
    expect(feishu.health().status).toBe('ok')
  })

  it('recovers from a failed connection and delivers messages held while failed', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    const got: string[] = []
    feishu.onMessage({ conversationId: 'oc_1' }, (m) => { got.push(m.eventId) })
    fake.ready()
    fake.error(new Error('gave up'))
    await fake.emit(textEvent('om_f', 'oc_1', 'held'))
    expect(got).toHaveLength(0)
    fake.ready()
    expect(feishu.health().status).toBe('ok')
    await until(() => got.length === 1)
    expect(got).toEqual(['om_f'])
  })

  it('holds messages during reconnecting and delivers them after reconnected', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    const got: string[] = []
    feishu.onMessage({ conversationId: 'oc_1' }, (m) => { got.push(m.eventId) })
    fake.ready()
    fake.reconnecting()
    await fake.emit(textEvent('om_r', 'oc_1', 'held'))
    expect(got).toHaveLength(0)
    fake.reconnected()
    await until(() => got.length === 1)
  })

  it('resolves subscription.ready after the connection is ready, or immediately if already ready', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    let early = false
    const sub = feishu.onMessage({ conversationId: 'oc_1' }, () => {})
    void sub.ready.then(() => { early = true })
    await Promise.resolve()
    expect(early).toBe(false)
    fake.ready()
    await sub.ready
    expect(early).toBe(true)
    await feishu.onMessage({ conversationId: 'oc_2' }, () => {}).ready
  })

  it('rejects subscription.ready when the long connection fails', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    const sub = feishu.onMessage({ conversationId: 'oc_1' }, () => {})
    fake.error(new Error('gave up'))
    await expect(sub.ready).rejects.toThrow(/gave up/)
    // 失败状态下新订阅的 ready 直接拒绝
    await expect(feishu.onMessage({ conversationId: 'oc_2' }, () => {}).ready).rejects.toThrow(/gave up/)
  })

  it('rejects subscription.ready when the credential check fails', async () => {
    restore()
    fake = createFakeFeishuSdk({ authCode: 99991663 })
    restore = useFakeFeishuSdk(fake)
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    await expect(root.root.get('feishu')!.onMessage({ conversationId: 'oc_1' }, () => {}).ready).rejects.toThrow(/99991663/)
  })

  it('rejects pending subscription.ready on unload without unhandled rejections', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const fork = await root.root.plugin(FeishuService, { appId: 'cli_test' })
      const feishu = root.root.get('feishu')!
      const sub = feishu.onMessage({ conversationId: 'oc_1' }, () => {})
      // 从不 await 的 ready
      feishu.onMessage({ conversationId: 'oc_2' }, () => {})
      await fork.dispose()
      await expect(sub.ready).rejects.toThrow(/feishu service stopped/)
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('still starts the long connection when the startup bot info request fails transiently', async () => {
    restore()
    fake = createFakeFeishuSdk({ botName: '告警机器人', botOpenId: 'ou_bot', botInfoThrows: true })
    restore = useFakeFeishuSdk(fake)
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    expect(fake.started()).toBe(1)
    expect(feishu.health()).toMatchObject({ status: 'degraded', detail: 'feishu long connection starting' })
    fake.ready()
    await until(() => feishu.health().detail.includes('告警机器人'))
    expect(feishu.health().status).toBe('ok')
    expect(await feishu.status()).toMatchObject({ account: '告警机器人' })
  })

  it('does not open a long connection when unloaded during the startup bot info request', async () => {
    restore()
    fake = createFakeFeishuSdk({ botInfoHang: true })
    restore = useFakeFeishuSdk(fake)
    const fork = root.root.plugin(FeishuService, { appId: 'cli_test', timeoutMs: 1000 })
    await until(() => fake.botInfoCalls() === 1)
    await fork.dispose()
    await new Promise((r) => setTimeout(r, 1100))
    expect(fake.started()).toBe(0)
  })

  it('does not look up names of p2p conversations for unmatched messages', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    fake.ready()
    await fake.emit(textEvent('om_p', 'oc_other', 'hi', { chat_type: 'p2p' }))
    await until(async () => (await feishu.unmatchedMessages()).length === 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.getChatCalls()).toBe(0)
  })

  it('rejects duplicate group routes', async () => {
    await expect(root.root.plugin(FeishuService, { appId: 'cli_test', groupRoutes: [{ conversationId: 'oc_1', pluginId: 'a' }, { conversationId: 'oc_1', pluginId: 'b' }] })).rejects.toThrow(/duplicate group route/)
  })

  it('refuses to listen in dryRun', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test', dryRun: true })
    expect(() => root.root.get('feishu')!.onMessage({ conversationId: 'oc_1' }, () => {})).toThrow(/cannot listen for messages in dryRun mode/)
  })
})
