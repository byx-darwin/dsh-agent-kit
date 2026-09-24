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
  const feishu = () => t.root.plugin(FeishuService, { larkPath: lark.path, identity: 'bot', defaultTarget: { chatId: 'oc_a' } } as never)

  /** 一个只 inject notify 的业务插件，记录自己被加载了几次。 */
  async function consumer(config: object) {
    await t.root.plugin(NotifyService, config as never)
    let ctx!: Context
    let applied = 0
    await t.root.inject(['notify'], (c) => {
      ctx = c
      applied++
    })
    return { notify: () => ctx.notify, applied: () => applied }
  }

  const lastLarkArgs = () => lark.calls().filter((c) => c.args.includes('+messages-send')).at(-1)?.args
  const dwsSends = () => dws.calls().filter((c) => c.args[0] === 'chat')

  it('sends to every configured channel', async () => {
    await dingtalk()
    await feishu()
    const { notify } = await consumer({ channels: ['dingtalk', 'feishu'] })
    const r = await notify().send({ title: 'T', markdown: '## hi', idempotencyKey: 'evt_1' })
    expect(r.results.map((x) => [x.channel, x.ok])).toEqual([
      ['dingtalk', true],
      ['feishu', true],
    ])
    expect(dwsSends()).toHaveLength(1)
    expect(lastLarkArgs()).toContain('--idempotency-key=evt_1')
    expect(notify().health()).toMatchObject({ status: 'ok' })
  })

  it('switches channels without reloading its consumers', async () => {
    const d = dingtalk()
    await d
    const { notify, applied } = await consumer({ channels: ['dingtalk', 'feishu'] })
    // 飞书还没启用：钉钉照常发送，飞书报 channel_unavailable
    let r = await notify().send({ text: 'x' })
    expect(r.results.map((x) => [x.channel, x.ok, x.error?.code])).toEqual([
      ['dingtalk', true, undefined],
      ['feishu', false, 'channel_unavailable'],
    ])
    expect(notify().health()).toMatchObject({ status: 'degraded', detail: 'channel unavailable: feishu' })

    // 启用飞书、停用钉钉：业务插件不重新加载
    await feishu()
    await d.dispose()
    r = await notify().send({ text: 'y' })
    expect(r.results.map((x) => [x.channel, x.ok])).toEqual([
      ['dingtalk', false],
      ['feishu', true],
    ])
    expect(applied()).toBe(1)
  })

  it('fails over in order and stops at the first success', async () => {
    dws.setScenario({ send: [{ mode: 'fail', category: 'validation' }] })
    await dingtalk()
    await feishu()
    const { notify } = await consumer({ channels: ['dingtalk', 'feishu'], strategy: 'failover' })
    const r = await notify().send({ text: 'x' })
    expect(r.results.map((x) => [x.channel, x.ok])).toEqual([
      ['dingtalk', false],
      ['feishu', true],
    ])
    lark.setScenario({ send: [{ mode: 'fail' }] })
    dws.setScenario({ send: [{ mode: 'success' }] })
    expect((await notify().send({ text: 'y' })).results.map((x) => x.channel)).toEqual(['dingtalk'])
  })

  it('throws all_failed when no channel delivers', async () => {
    const { notify } = await consumer({ channels: ['feishu'] })
    await expect(notify().send({ text: 'x' })).rejects.toMatchObject({ service: 'notify', code: 'all_failed' })
    expect(notify().health()).toMatchObject({ status: 'failed', detail: 'no channel available: feishu' })
  })

  it('passes per-channel targets and mentions', async () => {
    await dingtalk()
    await feishu()
    const { notify } = await consumer({ channels: ['feishu', 'dingtalk'] })
    await notify().send({ text: 'x', targets: { feishu: { userId: 'ou_1' }, dingtalk: { chatId: 'cidB' } }, at: { feishu: { all: true } } })
    expect(lastLarkArgs()).toEqual(expect.arrayContaining(['--user-id=ou_1', '--text=x <at user_id="all"></at>']))
    expect(dwsSends()[0]!.args).toContain('--groups=cidB')
  })

  it.each([
    [{}, /channels|required/],
    [{ channels: [] }, /至少选择一个/],
    [{ channels: ['dingtalk', 'dingtalk'] }, /不能重复/],
    [{ channels: ['email'] }, /expected/],
  ])('rejects invalid config %j', async (config, pattern) => {
    await expect(t.root.plugin(NotifyService, config as never)).rejects.toThrow(pattern)
  })
})
