import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { NotifyService } from '../../src/notify/service.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
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
  })

  it('rejects unknown channels in targets', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.send({ text: 'hello', targets: { feishu: { chatId: 'x' } } as never })).rejects.toMatchObject({ code: 'invalid_channel' })
  })

  it('reports the default channel and each channel without runtime switching', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const status = await notify.status()
    expect(status).toEqual({ defaultChannel: 'dingtalk', channels: { dingtalk: expect.objectContaining({ running: true, online: true }) } })
    expect('use' in notify).toBe(false)
    expect(notify.health()).toMatchObject({ status: 'ok', detail: 'default channel: dingtalk' })
  })

  it('requires a channel name for login and logout', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.logout('dingtalk')).rejects.toMatchObject({ code: 'channel_unavailable' })
  })
})
