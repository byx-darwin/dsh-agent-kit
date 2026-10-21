import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { FeishuService } from '../../src/feishu/service.js'
import { NotifyService } from '../../src/notify/service.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createFakeFeishuSdk, useFakeFeishuSdk } from '../../src/testing/fake-feishu.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('NotifyService', () => {
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

  it('sends to DingTalk with its default target and to a named Feishu group in one call', async () => {
    process.env.FEISHU_APP_SECRET = 'secret-value'
    const fake = createFakeFeishuSdk()
    const restore = useFakeFeishuSdk(fake)
    try {
      await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
      await root.root.plugin(FeishuService, { appId: 'cli_test' })
      await root.root.plugin(NotifyService, { channel: 'dingtalk' })
      const notify = root.root.get('notify')!
      const r = await notify.send({ text: 'hello', targets: { dingtalk: 'default', feishu: { chatId: 'oc_ops' } } })
      expect(r.deliveries.map((d) => [d.channel, d.results[0]!.ok])).toEqual([['dingtalk', true], ['feishu', true]])
      expect(fake.sends[0]!.data.receive_id).toBe('oc_ops')
      await expect(notify.login('feishu')).rejects.toMatchObject({ code: 'login_unsupported' })
      expect((await notify.status()).channels.feishu).toMatchObject({ running: true, identity: 'bot' })
    } finally {
      restore()
    }
  })

  it('sends to the default channel with its default target when no targets are given', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const result = await notify.send({ text: 'hello', idempotencyKey: 'evt_1' })
    expect(result).toMatchObject({ deliveries: [{ channel: 'dingtalk', results: [{ ok: true }] }] })
    expect(dws.calls().some((call) => call.args.includes('--as=user') && call.args.some((a) => a.includes('cidA')))).toBe(true)
  })

  it('sends only to the channels named in targets, using their targets', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const result = await notify.send({ text: 'hello', targets: { dingtalk: { chatId: 'cidB' } } })
    expect(result.deliveries.map((d) => d.channel)).toEqual(['dingtalk'])
    const sends = dws.calls().filter((call) => call.args.some((a) => a.includes('cidB')))
    expect(sends).toHaveLength(1)
  })

  it('throws when the default channel is not running, but reports a named channel that is not running as a failed delivery', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.send({ text: 'hello' })).rejects.toMatchObject({ code: 'channel_unavailable' })
    const r = await notify.send({ text: 'hello', targets: { dingtalk: { chatId: 'cidA' } } })
    expect(r.deliveries).toEqual([{ channel: 'dingtalk', results: [{ ok: false, error: expect.objectContaining({ code: 'channel_unavailable' }) }] }])
    expect(notify.health()).toMatchObject({ status: 'failed' })
    expect(root.logs.some((l) => l.includes('notify delivery failed'))).toBe(true)
  })

  it('turns a DingtalkSendError into a failed result instead of rejecting, and degrades health', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    dws.setScenario({ send: [{ mode: 'fail', category: 'server', message: 'boom' }] })
    const notify = root.root.get('notify')!
    // 不带 idempotencyKey，钉钉不重试，测试保持快速。
    const result = await notify.send({ text: 'x' })
    expect(result.deliveries).toHaveLength(1)
    const first = result.deliveries[0]!.results[0]!
    expect(first.ok).toBe(false)
    // 假 dws 的 server 类失败 => exit_nonzero，且 server 属于可重试类别。
    expect(first.error).toMatchObject({ code: 'exit_nonzero', retryable: true })
    expect(notify.health()).toMatchObject({ status: 'degraded' })
  })

  it('rejects unknown channels in targets', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.send({ text: 'hello', targets: { wecom: { chatId: 'x' } } as never })).rejects.toMatchObject({ code: 'invalid_channel' })
  })

  it('reports the default channel and each channel without runtime switching', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const status = await notify.status()
    expect(status.defaultChannel).toBe('dingtalk')
    expect(status.channels.dingtalk).toMatchObject({ running: true, online: true })
    expect(status.channels.feishu).toMatchObject({ running: false })
    expect('use' in notify).toBe(false)
    expect(notify.health()).toMatchObject({ status: 'ok', detail: 'default channel: dingtalk' })
  })

  it("treats 'default' as naming the channel while letting it use its own default target", async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const r = await notify.send({ text: 'hello', targets: { dingtalk: 'default' } })
    expect(r.deliveries).toMatchObject([{ channel: 'dingtalk', results: [{ ok: true }] }])
    expect(dws.calls().some((call) => call.args.some((a) => a.includes('cidA')))).toBe(true)
  })

  it("reports a channel named with 'default' that is not running as a failed delivery instead of throwing", async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const r = await notify.send({ text: 'hello', targets: { dingtalk: 'default' } })
    expect(r.deliveries).toEqual([{ channel: 'dingtalk', results: [{ ok: false, error: expect.objectContaining({ code: 'channel_unavailable' }) }] }])
  })

  it('requires a channel name for login and logout', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.logout('dingtalk')).rejects.toMatchObject({ code: 'channel_unavailable' })
  })
})
