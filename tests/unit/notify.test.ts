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

  it('forwards notifications through the logged-in DingTalk user', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const result = await notify.send({ text: 'hello', idempotencyKey: 'evt_1' })
    expect(result).toMatchObject({ channel: 'dingtalk', results: [{ ok: true }] })
    expect(dws.calls().some((call) => call.args.includes('--as=user'))).toBe(true)
    expect((await notify.status()).channels.dingtalk).toMatchObject({ running: true, online: true })
  })

  it('reports unavailable service and rejects other channels', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.send({ text: 'hello' })).rejects.toMatchObject({ code: 'channel_unavailable' })
    expect(() => notify.use('feishu' as never)).toThrow(/unknown channel/)
    expect((await notify.status()).channels.dingtalk).toMatchObject({ running: false })
  })
})
