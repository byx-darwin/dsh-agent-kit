import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

describe('DingTalk health', () => {
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

  it('keeps the listener failure as the reason when a later login check succeeds', async () => {
    dws.setScenario({ eventStartup: 'fail' })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    await until(() => service.health().counters.inbox.listener === 'failed')
    const reason = service.health().detail
    expect(await service.preflight()).toBe(true)
    expect(service.health()).toMatchObject({ status: 'failed', detail: reason })
    expect(service.health().detail).not.toMatch(/logged in/)
  })

  it('keeps the event listener running until the service stops', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const service = root.root.get('dingtalk')!
    await until(() => service.health().counters.inbox.listener === 'ready')
    // 假 dws 曾在就绪约 30ms 后无条件退出，导致监听被标记为失败
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(service.health().counters.inbox.listener).toBe('ready')
    expect(service.health().status).toBe('ok')
  })
})
