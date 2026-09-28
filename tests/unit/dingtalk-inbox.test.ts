import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { parseAtMessage, type DingtalkAtMessage } from '../../src/dingtalk/inbox.js'
import { DingtalkUnmatchedStore } from '../../src/dingtalk/unmatched.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

const event = (id: string, group: string, content: string) => ({
  type: 'user_im_message_receive_at',
  event_id: id,
  message_id: `msg-${id}`,
  conversation_id: group,
  sender_open_dingtalk_id: 'sender-1',
  content,
  timestamp: 123,
})

describe('DingTalk @-message inbox', () => {
  let root: TestRoot
  let dws: ReturnType<typeof createFakeDws>
  const savedEnv = { ...process.env }

  beforeEach(() => {
    root = createRoot()
    dws = createFakeDws()
    process.env.DWS_CONFIG_DIR = dws.dir
  })
  afterEach(async () => {
    await root.dispose()
    dws.cleanup()
    process.env = { ...savedEnv }
  })

  it('accepts only flattened @ events with stable routing IDs', () => {
    expect(parseAtMessage(JSON.stringify(event('e1', 'cidA', 'hello')))).toMatchObject({ eventId: 'e1', conversationId: 'cidA', content: 'hello' })
    expect(parseAtMessage(JSON.stringify({ ...event('e1', 'cidA', 'hello'), type: 'other' }))).toBeUndefined()
    expect(parseAtMessage(JSON.stringify({ ...event('e1', 'cidA', 'hello'), conversation_id: '' }))).toBeUndefined()
    expect(parseAtMessage(JSON.stringify({ ...event('e2', 'cidA', ''), sender_open_dingtalk_id: '' }))).toMatchObject({ eventId: 'e2', content: '' })
    expect(parseAtMessage('not json')).toBeUndefined()
  })

  it('starts one listener and routes each group message to one matching plugin', async () => {
    dws.setScenario({ eventDelayMs: 100, events: [
      event('e1', 'cidA', '工单 123'),
      event('e2', 'cidB', '告警'),
      event('e1', 'cidA', '工单 123'),
      event('e3', 'cidA', '未命中'),
      event('e4', 'cidOther', '告警'),
    ] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const received: Array<[string, DingtalkAtMessage]> = []
    const pluginA = await root.root.plugin({
      name: 'orders', inject: ['dingtalk'], apply(ctx: Context) {
        ctx.dingtalk.onMessage({ conversationId: 'cidA', match: (m) => m.content.startsWith('工单') }, (m) => { received.push(['orders', m]) })
      },
    })
    const pluginB = await root.root.plugin({
      name: 'alerts', inject: ['dingtalk'], apply(ctx: Context) {
        ctx.dingtalk.onMessage({ conversationId: 'cidB' }, (m) => { received.push(['alerts', m]) })
      },
    })
    await until(() => root.root.get('dingtalk')!.health().counters.inbox.received === 5)
    await until(() => received.length === 2)
    expect(received.map(([name, m]) => [name, m.eventId])).toEqual([['orders', 'e1'], ['alerts', 'e2']])
    expect(root.root.get('dingtalk')!.health().counters.inbox).toMatchObject({ listener: 'ready', routes: 2, duplicate: 1, unmatched: 2 })
    expect(dws.calls().filter((call) => call.args[0] === 'event')).toHaveLength(1)
    expect(dws.calls().find((call) => call.args[0] === 'event')?.args).toEqual(['event', '+listen-im', '--kind', 'at-me', '-f', 'ndjson', '--profile', 'dingcorp:u1'])
    await pluginA.dispose()
    expect(root.root.get('dingtalk')!.health().counters.inbox.routes).toBe(1)
    await pluginB.dispose()
    expect(root.root.get('dingtalk')!.health().counters.inbox).toMatchObject({ listener: 'ready', routes: 0 })
  })

  it('dispatches configured groups to the selected business plugin and records unavailable targets', async () => {
    dws.setScenario({ eventDelayMs: 100, events: [
      event('e1', 'cidOrders', '新工单'),
      event('e2', 'cidAlerts', '告警'),
      event('e3', 'cidUnknown', '其他'),
    ] })
    await root.root.plugin(DingtalkService, {
      dwsPath: dws.path, killGraceMs: 50,
      groupRoutes: [
        { conversationId: 'cidOrders', pluginId: 'business-orders' },
        { conversationId: 'cidAlerts', pluginId: 'business-alerts' },
      ],
    })
    const service = root.root.get('dingtalk')!
    const received: string[] = []
    const plugin = await root.root.plugin({
      name: 'business-orders', inject: ['dingtalk'], apply(ctx: Context) {
        ctx.dingtalk.onPluginMessage('business-orders', (message) => { received.push(message.eventId) })
      },
    })
    service.onMessage({ conversationId: 'cidAlerts' }, () => { received.push('wrong-fallback') })
    await until(() => service.health().counters.inbox.received === 3)
    await until(async () => (await service.unmatchedMessages()).length === 2)
    expect(received).toEqual(['e1'])
    expect((await service.unmatchedMessages()).map((message) => message.eventId)).toEqual(['e3', 'e2'])
    await plugin.dispose()
    expect(service.health().counters.inbox.routes).toBe(1)
  })

  it('records unmatched messages with a stable group ID and resolved display name', async () => {
    dws.setScenario({ eventDelayMs: 80, groupNames: { cidOther: '研发讨论群' }, events: [event('missing', 'cidOther', '请处理这条消息')] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    const sub = service.onMessage({ conversationId: 'cidA' }, () => {})
    await sub.ready
    await until(async () => (await service.unmatchedMessages())[0]?.groupName === '研发讨论群')
    expect(await service.unmatchedMessages()).toMatchObject([{
      eventId: 'missing', conversationId: 'cidOther', groupName: '研发讨论群', preview: '请处理这条消息',
    }])
    expect(dws.calls().filter((call) => call.args[1] === '+conversation-info')).toHaveLength(1)
    await sub.close()
  })

  it('captures an unmatched group message before any business route is registered', async () => {
    dws.setScenario({ eventDelayMs: 30, events: [event('unrouted', 'cidNew', '新业务需求')] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    await until(async () => (await service.unmatchedMessages()).length === 1)
    await until(() => dws.calls().some((call) => call.args[1] === '+conversation-info'))
    expect(await service.unmatchedMessages()).toMatchObject([{ eventId: 'unrouted', conversationId: 'cidNew', preview: '新业务需求' }])
    expect(service.health().counters.inbox).toMatchObject({ routes: 0, unmatched: 1 })
  })

  it('keeps only a bounded preview in a private, restart-readable file', async () => {
    const file = join(dws.dir, 'private', 'unmatched.json')
    const errors: unknown[] = []
    const store = new DingtalkUnmatchedStore(file, async () => undefined, (e) => { errors.push(e) })
    await store.add({ eventId: 'e1', conversationId: 'cidA', content: '密'.repeat(300) })
    const restarted = new DingtalkUnmatchedStore(file, async () => undefined, (e) => { errors.push(e) })
    expect(await restarted.list()).toMatchObject([{ eventId: 'e1', conversationId: 'cidA', preview: '密'.repeat(240) }])
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(join(dws.dir, 'private')).mode & 0o777).toBe(0o700)
    }
    expect(errors).toEqual([])
  })

  it('keeps different logged-in accounts in separate unmatched files', async () => {
    root.root.baseUrl = pathToFileURL(`${dws.dir}/`).href
    dws.setScenario({ corpId: 'corpA', userId: 'u1', eventDelayMs: 30, events: [event('e1', 'cidA', '账号一')] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    await until(async () => (await service.unmatchedMessages()).some((m) => m.eventId === 'e1'))
    dws.setScenario({ corpId: 'corpB', userId: 'u2', eventDelayMs: 30, events: [event('e2', 'cidB', '账号二')] })
    await service.preflight()
    await until(async () => (await service.unmatchedMessages()).some((m) => m.eventId === 'e2'))
    expect((await service.unmatchedMessages()).map((m) => m.eventId)).toEqual(['e2'])
  })

  it('uses priority for overlapping routes and isolates a failing handler', async () => {
    dws.setScenario({ eventDelayMs: 80, events: [event('e1', 'cidA', 'a'), event('e2', 'cidA', 'b')] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    const called: string[] = []
    service.onMessage({ conversationId: 'cidA' }, () => { called.push('fallback') })
    service.onMessage({ conversationId: 'cidA', priority: 10 }, (m) => {
      called.push(m.eventId)
      if (m.eventId === 'e1') throw new Error('bad handler')
    })
    await until(() => service.health().counters.inbox.handlerErrors === 1 && called.length === 2)
    expect(called).toEqual(['e1', 'e2'])
    expect(service.health().counters.inbox.dispatched).toBe(1)
  })

  it('aborts an in-flight handler when its owning plugin unloads', async () => {
    dws.setScenario({ eventDelayMs: 80, events: [event('e1', 'cidA', 'slow'), event('e2', 'cidB', 'next')] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    let started = false
    let aborted = false
    let next = false
    const a = await root.root.plugin({
      name: 'slow-business', inject: ['dingtalk'], apply(ctx: Context) {
        ctx.dingtalk.onMessage({ conversationId: 'cidA' }, async (_message, { signal }) => {
          started = true
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
        })
      },
    })
    await root.root.plugin({
      name: 'next-business', inject: ['dingtalk'], apply(ctx: Context) {
        ctx.dingtalk.onMessage({ conversationId: 'cidB' }, () => { next = true })
      },
    })
    await until(() => started)
    await a.dispose()
    await until(() => aborted && next)
    expect(root.root.get('dingtalk')!.health().counters.inbox.routes).toBe(1)
  })

  it('reports a subscription startup failure without pretending to listen', async () => {
    dws.setScenario({ eventStartup: 'fail' })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    const sub = service.onMessage({ conversationId: 'cidA' }, () => {})
    await expect(sub.ready).rejects.toThrow(/exited|failed/)
    await until(() => service.health().counters.inbox.listener === 'failed')
    expect(service.health().status).toBe('failed')
    await sub.close()
  })

  it('times out if dws never emits a ready marker', async () => {
    dws.setScenario({ eventStartup: 'hang' })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, timeoutMs: 1000, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    const sub = service.onMessage({ conversationId: 'cidA' }, () => {})
    await expect(sub.ready).rejects.toThrow(/did not become ready/)
    expect(service.health().status).toBe('failed')
    await sub.close()
  })

  it('keeps the discovery listener alive when business routes change', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    const first = service.onMessage({ conversationId: 'cidA' }, () => {})
    await first.ready
    const closing = first.close()
    const second = service.onMessage({ conversationId: 'cidB' }, () => {})
    await second.ready
    await closing
    expect(service.health().counters.inbox).toMatchObject({ listener: 'ready', routes: 1 })
    expect(dws.calls().filter((call) => call.args[0] === 'event')).toHaveLength(1)
    await second.close()
  })
})
