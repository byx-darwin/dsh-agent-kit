import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { FeishuService } from '../../src/feishu/service.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createFakeFeishuSdk, useFakeFeishuSdk } from '../../src/testing/fake-feishu.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

const dingtalkEvent = (id: string, group: string, sender = 'sender-1') => ({
  type: 'user_im_message_receive_at', event_id: id, message_id: `msg-${id}`, conversation_id: group, sender_open_dingtalk_id: sender, content: 'ping', timestamp: 1,
})

describe('context.reply()', () => {
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

  it('DingTalk replies to the group, or to the sender in a single chat', async () => {
    dws.setScenario({ eventDelayMs: 50, events: [dingtalkEvent('e1', 'cidGroup'), dingtalkEvent('e2', 'cidmeSingle', 'od-user')] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const results: unknown[] = []
    await root.root.plugin({
      name: 'biz', inject: ['dingtalk'], apply(ctx: Context) {
        for (const conversationId of ['cidGroup', 'cidmeSingle']) {
          ctx.dingtalk.onMessage({ conversationId }, async (_m, { reply }) => { results.push(await reply({ text: 'pong' })) })
        }
      },
    })
    await until(() => results.length === 2)
    const sends = dws.calls().filter((c) => c.args[1] === '+messages-send')
    expect(sends.some((c) => c.args.includes('--chat-id=cidGroup'))).toBe(true)
    expect(sends.some((c) => c.args.includes('--open-dingtalk-id=od-user'))).toBe(true)
    expect(results).toEqual([expect.objectContaining({ results: [expect.objectContaining({ ok: true })] }), expect.objectContaining({ results: [expect.objectContaining({ ok: true })] })])
  })

  it('DingTalk reply failures are returned, not thrown', async () => {
    dws.setScenario({ eventDelayMs: 50, events: [dingtalkEvent('e1', 'cidGroup')], send: [{ mode: 'fail', category: 'server', message: 'boom' }] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    let replied: any
    await root.root.plugin({ name: 'biz', inject: ['dingtalk'], apply(ctx: Context) { ctx.dingtalk.onMessage({ conversationId: 'cidGroup' }, async (_m, { reply }) => { replied = await reply({ text: 'pong' }) }) } })
    await until(() => replied !== undefined)
    expect(replied.results[0]).toMatchObject({ ok: false })
  })

  it('Feishu replies to the conversation chat_id', async () => {
    process.env.FEISHU_APP_SECRET = 'secret-value'
    const fake = createFakeFeishuSdk({ botOpenId: 'ou_bot' })
    const restore = useFakeFeishuSdk(fake)
    try {
      await root.root.plugin(FeishuService, { appId: 'cli_test' })
      let replied: unknown
      root.root.get('feishu')!.onMessage({ conversationId: 'oc_1' }, async (_m, { reply }) => { replied = await reply({ text: 'pong' }) })
      fake.ready()
      await fake.emit({ sender: { sender_id: { open_id: 'ou_a' } }, message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'ping' }), create_time: '1' } })
      await until(() => replied !== undefined)
      expect(fake.sends.at(-1)!.data.receive_id).toBe('oc_1')
      expect(replied).toEqual({ results: [{ ok: true, messageId: expect.any(String) }] })
    } finally {
      restore()
    }
  })
})
