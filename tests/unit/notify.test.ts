import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { FeishuService } from '../../src/feishu/service.js'
import { NotifyService } from '../../src/notify/service.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createFakeLark } from '../../src/testing/fake-lark.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('NotifyService', () => {
  const savedEnv = { ...process.env }
  let t: TestRoot
  let dws: ReturnType<typeof createFakeDws>
  let lark: ReturnType<typeof createFakeLark>

  beforeEach(() => {
    t = createRoot()
    dws = createFakeDws()
    lark = createFakeLark()
    process.env.DWS_CONFIG_DIR = dws.dir
    process.env.LARKSUITE_CLI_CONFIG_DIR = lark.dir
  })
  afterEach(async () => {
    await t.dispose()
    dws.cleanup()
    lark.cleanup()
    process.env = { ...savedEnv }
  })

  const dingtalk = () => t.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'bot', robotCode: 'ding1', defaultTarget: { chatId: 'cidA' } } as never)
  const feishu = (config: object = {}) => t.root.plugin(FeishuService, { larkPath: lark.path, identity: 'bot', defaultTarget: { chatId: 'oc_a' }, ...config } as never)

  /** 加载 notify 与一个只 inject notify 的业务插件，记录业务插件被加载了几次。 */
  async function consumer(config: object) {
    const fiber = t.root.plugin(NotifyService, config as never)
    await fiber
    let ctx!: Context
    let applied = 0
    await t.root.inject(['notify'], (c) => {
      ctx = c
      applied++
    })
    return { notify: () => ctx.notify, applied: () => applied, fiber }
  }

  const larkSends = () => lark.calls().filter((c) => c.args.includes('+messages-send'))
  const dwsSends = () => dws.calls().filter((c) => c.args[0] === 'chat')

  it('sends to the one configured channel', async () => {
    await dingtalk()
    await feishu()
    const { notify } = await consumer({ channel: 'feishu' })
    const r = await notify().send({ title: 'T', markdown: '## hi', idempotencyKey: 'evt_1' })
    expect(r).toMatchObject({ channel: 'feishu', results: [{ ok: true, messageId: 'om_oc_a' }] })
    expect(larkSends()).toHaveLength(1)
    expect(dwsSends()).toHaveLength(0)
    expect(notify().health()).toMatchObject({ status: 'ok', detail: 'channel: feishu' })
  })

  it('switches at runtime with use() and back to the configured channel on a config change, without reloading consumers', async () => {
    await dingtalk()
    await feishu()
    const { notify, applied, fiber } = await consumer({ channel: 'dingtalk' })
    notify().use('feishu')
    expect(notify().channel).toBe('feishu')
    expect((await notify().send({ text: 'x' })).channel).toBe('feishu')
    expect((await notify().status()).source).toBe('runtime')

    await fiber.update({ channel: 'dingtalk' })
    expect(notify().channel).toBe('dingtalk')
    expect((await notify().status()).source).toBe('config')
    await fiber.update({ channel: 'feishu' })
    expect(notify().config).toEqual({ channel: 'feishu' })
    expect((await notify().send({ text: 'y' })).channel).toBe('feishu')
    // 同一个实例：计数一直累加，业务插件只加载过一次
    expect(notify().health().counters.success).toBe(2)
    expect(applied()).toBe(1)
    expect(() => notify().use('email' as never)).toThrow(/unknown channel/)
  })

  it('reports channel_unavailable when the channel row is not running, and keeps consumers loaded when a channel goes away', async () => {
    const d = dingtalk()
    await d
    const { notify, applied } = await consumer({ channel: 'dingtalk' })
    await d.dispose()
    await expect(notify().send({ text: 'x' })).rejects.toMatchObject({ service: 'notify', code: 'channel_unavailable' })
    expect(notify().health()).toMatchObject({ status: 'failed', detail: 'channel dingtalk is not running' })
    await dingtalk()
    expect((await notify().send({ text: 'y' })).results[0]!.ok).toBe(true)
    expect(applied()).toBe(1)
  })

  it('propagates the channel error for a failed send', async () => {
    lark.setScenario({ send: [{ mode: 'fail' }] })
    await feishu()
    const { notify } = await consumer({ channel: 'feishu' })
    await expect(notify().send({ text: 'x' })).rejects.toMatchObject({ service: 'feishu', code: 'exit_nonzero' })
    expect(notify().health()).toMatchObject({ status: 'degraded' })
  })

  it('passes the per-channel target and mentions of the active channel', async () => {
    await dingtalk()
    await feishu()
    const { notify } = await consumer({ channel: 'feishu' })
    const options = { text: 'x', targets: { feishu: { userId: 'ou_1' }, dingtalk: { chatId: 'cidB' } }, at: { feishu: { all: true } } }
    await notify().send(options)
    expect(larkSends().at(-1)!.args).toEqual(expect.arrayContaining(['--user-id=ou_1', '--text=x <at user_id="all"></at>']))
    notify().use('dingtalk')
    await notify().send(options)
    expect(dwsSends()[0]!.args).toContain('--groups=cidB')
  })

  it('reports every channel\'s login state, and logs in / out through the active channel', async () => {
    await dingtalk()
    await feishu({ identity: 'user' })
    const { notify } = await consumer({ channel: 'feishu' })
    let s = await notify().status()
    expect(s.channel).toBe('feishu')
    expect(s.channels.dingtalk).toMatchObject({ running: true, online: true, account: '测试用户 @ 测试组织' })
    expect(s.channels.feishu).toMatchObject({ running: true, identity: 'user', online: false })

    const session = await notify().login()
    expect(session).toMatchObject({ channel: 'feishu', verificationUrl: expect.stringContaining('user_code=ABCD-EFGH'), userCode: 'ABCD-EFGH' })
    expect(await session.completed).toMatchObject({ channel: 'feishu', online: true, account: 'Tester' })
    s = await notify().status()
    expect(s.channels.feishu).toMatchObject({ online: true })

    expect(await notify().logout()).toMatchObject({ online: false })
    expect(await notify().logout('dingtalk')).toMatchObject({ channel: 'dingtalk', online: false })
    await expect(notify().login('dingtalk')).resolves.toMatchObject({ channel: 'dingtalk', userCode: 'FAKE-CODE' })
  })

  it('reports channels that are not running in status()', async () => {
    const { notify } = await consumer({ channel: 'dingtalk' })
    expect((await notify().status()).channels).toEqual({
      dingtalk: { channel: 'dingtalk', running: false, detail: 'agent-kit-dingtalk is not running' },
      feishu: { channel: 'feishu', running: false, detail: 'agent-kit-feishu is not running' },
    })
    await expect(notify().login()).rejects.toMatchObject({ code: 'channel_unavailable' })
  })

  it.each([
    [{}, /channel|required/],
    [{ channel: 'email' }, /expected/],
    [{ channels: ['dingtalk'] }, /channel|required/],
  ])('rejects invalid config %j', async (config, pattern) => {
    await expect(t.root.plugin(NotifyService, config as never)).rejects.toThrow(pattern)
  })
})
