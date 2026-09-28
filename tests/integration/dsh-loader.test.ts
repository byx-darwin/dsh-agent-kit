import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { FakeSubagentProvider } from '../../src/testing/fake-subagent.js'
import { createJevMock } from '../../src/testing/jev-mock.js'
import { startTestWsServer, type TestWsServer } from '../../src/testing/ws-server.js'
import { until } from '../helpers.js'

// 在真实 dsh loader 中加载本包 bundle 的 patch.yml（通过 node_modules/@baoyx/dsh-agent-kit 软链指向已构建的 lib/）。
const ROOT = resolve(import.meta.dirname, '../..')
const BUNDLE_PATCHES = loadOverlayPatches('agent-kit-test', join(ROOT, 'patch.yml'))

type Patch = Record<string, unknown>

let tmp: string
let ctx: Context | undefined
let server: TestWsServer
let dws: ReturnType<typeof createFakeDws>
const savedEnv = { ...process.env }

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-kit-int-'))
  writeFileSync(join(tmp, 'cordis.yml'), '[]\n')
  server = await startTestWsServer()
  dws = createFakeDws()
  process.env.DWS_CONFIG_DIR = dws.dir
  process.env.TYPESAFE_API_KEY = 'ts-integration-key'
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await server.close()
  dws.cleanup()
  rmSync(tmp, { recursive: true, force: true })
  process.env = { ...savedEnv }
})

async function start(profilePatches: Patch[]) {
  // cordis.yml 所在目录作为 bare 模块名的解析基准，这里用仓库根目录，使 @baoyx/dsh-agent-kit 通过软链解析
  const configPath = join(ROOT, '.tmp', `cordis-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`)
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  writeFileSync(configPath, '[]\n')
  try {
    ctx = await boot('agent-kit-test', configPath, [...BUNDLE_PATCHES, ...(profilePatches as never[])])
  } finally {
    rmSync(configPath, { force: true })
  }
  return ctx
}

const enable = (id: string, config: Record<string, unknown>, extra: Patch = {}): Patch => ({ id: `agent-kit-${id}`, disabled: false, config, ...extra })

describe('bundle patch.yml in a real dsh loader', () => {
  it('registers every service disabled by default', async () => {
    const c = await start([])
    for (const name of ['agentWs', 'dingtalk', 'notify', 'agentTasks', 'jev']) expect(c.get(name)).toBeUndefined()
    const ids = BUNDLE_PATCHES.flatMap((p: any) => p.insert ?? []).map((e: any) => [e.id, e.name, e.disabled])
    expect(ids).toEqual([
      ['agent-kit-ws', '@baoyx/dsh-agent-kit/ws', true],
      ['agent-kit-dingtalk', '@baoyx/dsh-agent-kit/dingtalk', true],
      ['agent-kit-notify', '@baoyx/dsh-agent-kit/notify', true],
      ['agent-kit-agent-tasks', '@baoyx/dsh-agent-kit/agent-tasks', true],
      ['agent-kit-jev', '@baoyx/dsh-agent-kit/jev', true],
    ])
  })

  it('enabling one service does not require config for the others', async () => {
    delete process.env.TYPESAFE_API_KEY
    const c = await start([enable('ws', {})])
    expect(c.get('agentWs')).toBeDefined()
    expect(c.get('dingtalk')).toBeUndefined()
    expect(c.get('jev')).toBeUndefined()
  })

  it('fails to boot when an enabled service has invalid config', async () => {
    await expect(start([enable('dingtalk', { identity: 'bot' })])).rejects.toThrow(/expected|failed to load|did not activate/)
    ctx = undefined
    delete process.env.TYPESAFE_API_KEY
    await expect(start([enable('jev', {})])).rejects.toThrow(/TYPESAFE_API_KEY|failed to load|did not activate/)
    ctx = undefined
  })

  it('notify sends through the DingTalk user service for a plugin that injects only notify', async () => {
    const c = await start([
      enable('dingtalk', { identity: 'user', dwsPath: dws.path, defaultTarget: { chatId: 'cidA' } }),
      enable('notify', { channel: 'dingtalk' }),
    ])
    let sent: any
    let status: any
    await c.plugin({
      name: 'business',
      inject: ['notify'],
      async apply(bctx: Context) {
        sent = await bctx.notify.send({ title: 'T', markdown: 'alert', idempotencyKey: 'evt_1' })
        status = await bctx.notify.status()
      },
    })
    expect(sent).toMatchObject({ channel: 'dingtalk', results: [{ ok: true }] })
    expect(status).toMatchObject({ channel: 'dingtalk', channels: { dingtalk: { online: true } } })
  })

  it('routes group @ messages to the matching business plugins through one dws listener', async () => {
    dws.setScenario({ eventDelayMs: 100, events: [
      { type: 'user_im_message_receive_at', event_id: 'evt-A', message_id: 'msg-A', conversation_id: 'cidA', sender_open_dingtalk_id: 'sender', content: 'A' },
      { type: 'user_im_message_receive_at', event_id: 'evt-B', message_id: 'msg-B', conversation_id: 'cidB', sender_open_dingtalk_id: 'sender', content: 'B' },
    ] })
    const c = await start([enable('dingtalk', { dwsPath: dws.path, killGraceMs: 50 })])
    const received: string[] = []
    const a = await c.plugin({
      name: 'business-a', inject: ['dingtalk'], async apply(bctx: Context) {
        await bctx.dingtalk.onMessage({ conversationId: 'cidA' }, (message) => { received.push(`a:${message.eventId}`) }).ready
      },
    })
    const b = await c.plugin({
      name: 'business-b', inject: ['dingtalk'], async apply(bctx: Context) {
        await bctx.dingtalk.onMessage({ conversationId: 'cidB' }, (message) => { received.push(`b:${message.eventId}`) }).ready
      },
    })
    await until(() => received.length === 2)
    expect(received).toEqual(['a:evt-A', 'b:evt-B'])
    expect(dws.calls().filter((call) => call.args[0] === 'event')).toHaveLength(1)
    await a.dispose()
    await b.dispose()
    expect(c.dingtalk.health().counters.inbox).toMatchObject({ listener: 'ready', routes: 0 })
  })

  it('all four services can be injected, work together, and release resources on unload', async () => {
    const workspaceDir = join(tmp, 'tasks')
    const c = await start([
      { insert: [{ id: 'subagents', name: '@deepseek-ai/dsh-subagent' }] },
      enable('ws', { pingIntervalMs: 1000, readTimeoutMs: 2000 }),
      enable('dingtalk', { identity: 'user', dwsPath: dws.path, defaultTarget: { chatId: 'cidA' }, timeoutMs: 5000, killGraceMs: 100 }),
      enable('agent-tasks', { workspaceDir, maxConcurrency: 1 }),
      enable('jev', {}),
    ])
    for (const name of ['agentWs', 'dingtalk', 'agentTasks', 'jev', 'subagents']) expect(c.get(name), name).toBeDefined()

    const provider = new FakeSubagentProvider({ name: 'fake', capabilities: { toolFilter: true } })
    provider.handler = () => '```json\n{"ok":true}\n```'
    const mock = createJevMock()
    const client = await mock.factory({ apiKey: 'x', model: 'jev-latest', timeoutMs: 1000 })
    ;(c.get('jev') as unknown as { client: unknown }).client = client

    const received: unknown[] = []
    let finished = false
    const results: Record<string, unknown> = {}
    const plugin = await c.plugin({
      name: 'business',
      inject: ['agentWs', 'dingtalk', 'agentTasks', 'jev', 'subagents'],
      apply(bctx: Context) {
        ;(bctx as any).subagents.registerProvider(provider)
        const conn = bctx.agentWs.connect<{ id: string }>({
          url: server.url,
          onMessage: async (frame, { signal }) => {
            received.push(frame)
            results.send = await bctx.dingtalk.send({ markdown: 'alert', traceId: frame.id })
            results.task = await bctx.agentTasks.run<{ ok: boolean }>({
              provider: 'fake',
              title: `task ${frame.id}`,
              prompt: 'p',
              outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
              signal,
            })
            const { noul } = await import('../../src/jev/types.js')
            results.judge = await bctx.jev.judge({ state: 's', questions: { q: noul('x') }, signal })
            await conn.send({ id: frame.id, done: true })
            finished = true
          },
        })
      },
    })
    const ws = await server.waitForConnection()
    ws.send(JSON.stringify({ id: 'evt_1' }))
    await until(() => finished, 10_000)
    expect(received).toEqual([{ id: 'evt_1' }])
    expect((results.send as any).results[0]).toMatchObject({ ok: true, target: { chatId: 'cidA' } })
    expect((results.task as any).output).toEqual({ ok: true })
    expect((results.judge as any).answers.q.type).toBe('noul')
    await until(() => server.received.length === 1)

    // 在途的 dws 子进程与 WebSocket 连接在卸载时被回收
    dws.setScenario({ send: [{ mode: 'hang' }] })
    const hanging = (c.get('dingtalk') as any).send({ text: 'x' }).catch((e: unknown) => e)
    await until(() => dws.hangPids() !== undefined)
    const closeCode = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    await plugin.dispose()
    expect(await closeCode).toBe(1001)
    await c.fiber.dispose()
    ctx = undefined
    expect(await hanging).toMatchObject({ code: 'aborted' })
    const pids = dws.hangPids()!
    await until(() => {
      try {
        process.kill(pids.grandchild, 0)
        return false
      } catch {
        return true
      }
    }, 5000, 'dws children survived unload')
  })
})
