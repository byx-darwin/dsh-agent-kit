import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentKitEntry } from '../../src/admin/entry.js'
import { AgentKitAdmin } from '../../src/admin/service.js'
import { readCredential } from '../../src/secrets/index.js'

let home: string
let profileDir: string
let patchFile: string
let credentialsFile: string
let root: Context
let loaderEntries: Array<{ id: string; disabled: boolean; fiber: { state: number } }>

const BUSINESS_ROW = `- id: biz-row   # 业务行
  disabled: false
  config:
    url: 'wss://a.example/ws'
    batchSize: 5
    maxInFlight: 10
`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  profileDir = join(home, 'profiles', 'kit')
  mkdirSync(profileDir, { recursive: true })
  patchFile = join(profileDir, 'cordis.patch.yml')
  credentialsFile = join(home, '.credentials.yaml')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@mc/dsh-agent-kit'], patchReload: 'live' } } }))
  writeFileSync(patchFile, `- id: agent-kit-dingtalk\n  disabled: false\n  config: { identity: bot,  robotCode: ding1 }\n${BUSINESS_ROW}`)
  loaderEntries = [
    { id: 'agent-kit-dingtalk', disabled: false, fiber: { state: 2 } },
    { id: 'biz-row', disabled: false, fiber: { state: 2 } },
  ]
  root = new Context()
})
afterEach(async () => {
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

async function setup() {
  root.provide('loader', { entries: () => loaderEntries } as never)
  root.provide('webServer', { host: '127.0.0.1' } as never)
  await root.plugin(AgentKitAdmin, { profileDir, keyStore: { env: {}, platform: 'linux', credentialsFile } } as never)
  return root.get('agentKitAdmin') as unknown as AgentKitAdmin
}

const bizEntry = (over: Partial<AgentKitEntry> = {}): AgentKitEntry => ({
  id: 'biz-row',
  label: '业务',
  schema: (value) => {
    const v = value as { url?: unknown }
    if (typeof v.url !== 'string') throw new Error('$.url expected string')
    return { tokenEnv: 'BIZ_TOKEN', ...(value as object) }
  },
  validate: (c: { url: string; batchSize?: number; maxInFlight?: number }) => [
    ...(c.url.startsWith('wss://') ? [] : [{ path: 'url', message: '必须是 wss://' }]),
    ...((c.batchSize ?? 0) > (c.maxInFlight ?? Infinity) ? [{ path: 'batchSize', message: 'batchSize <= maxInFlight' }] : []),
  ],
  fields: [{ path: 'url', label: 'URL' }, { path: 'batchSize', label: 'Batch', kind: 'number' }],
  secrets: [{ label: '上游 Token', refFrom: 'tokenEnv', ref: 'BIZ_TOKEN' }],
  health: () => ({ status: 'ok', detail: 'connected' }),
  checks: () => [{ id: 'upstream', title: '上游', status: 'warn', detail: 'slow', fix: 'check network' }],
  dependsOn: ['agent-kit-dingtalk'],
  ...over,
})

/** 一个业务插件：inject agentKitAdmin，在 apply 里登记自己的行。 */
function businessPlugin(entry: AgentKitEntry) {
  return {
    name: 'biz-plugin',
    inject: ['agentKitAdmin'],
    apply(ctx: Context) {
      ctx.agentKitAdmin.registerEntry(entry)
    },
  }
}

describe('AgentKitAdmin registered entries (issue #1)', () => {
  it('shows a registered row in status() with config, health, checks and secrets; status is unchanged without it', async () => {
    const admin = await setup()
    const before = await admin.status()
    expect(before.services.map((s) => s.id)).toEqual(['agent-kit-ws', 'agent-kit-dingtalk', 'agent-kit-feishu', 'agent-kit-notify', 'agent-kit-agent-tasks', 'agent-kit-jev'])
    expect(before.checks.some((c) => c.scope === 'biz-row')).toBe(false)

    const fiber = root.plugin(businessPlugin(bizEntry()) as never, {} as never)
    await fiber
    const s = await admin.status()
    expect(s.services.find((x) => x.id === 'biz-row')).toEqual({
      id: 'biz-row',
      title: '业务',
      enabled: true,
      phase: 'active',
      health: { status: 'ok', detail: 'connected' },
      config: { url: 'wss://a.example/ws', batchSize: 5, maxInFlight: 10 },
      registered: true,
      fields: [{ path: 'url', label: 'URL' }, { path: 'batchSize', label: 'Batch', kind: 'number' }],
      secrets: [{ label: '上游 Token', ref: 'BIZ_TOKEN', configured: false }],
    })
    expect(s.services.find((x) => x.id === 'agent-kit-dingtalk')?.dependents).toEqual([{ id: 'biz-row', title: '业务' }])
    expect(s.checks.filter((c) => c.scope === 'biz-row').map((c) => [c.id, c.status])).toEqual([
      ['biz-row.config', 'pass'],
      ['biz-row.upstream', 'warn'],
    ])

    // 插件卸载：卡片与检查随之消失，status 回到登记前
    await fiber.dispose()
    expect(await admin.status()).toEqual(before)
  })

  it('also unregisters through the returned disposer and refuses duplicate ids', async () => {
    const admin = await setup()
    const dispose = admin.registerEntry(bizEntry())
    expect(() => admin.registerEntry(bizEntry())).toThrow(/already registered/)
    expect(() => admin.registerEntry({ id: 'agent-kit-ws', label: 'x' })).toThrow(/reserved/)
    dispose()
    expect((await admin.status()).services.some((s) => s.id === 'biz-row')).toBe(false)
  })

  it('still shows the card and checks while the business row is disabled or failed (runtime registration from a manifest)', async () => {
    const pkg = join(profileDir, 'node_modules', '@acme', 'biz')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@acme/biz', dsh: { agentKit: { entries: ['./entry.mjs'] } } }))
    writeFileSync(join(pkg, 'entry.mjs'), "export default { id: 'biz-row', label: '业务', fields: [{ path: 'url', label: 'URL' }], validate: (c) => (String(c.url).startsWith('wss://') ? [] : [{ path: 'url', message: 'wss only' }]) }")
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@mc/dsh-agent-kit', '@acme/biz'], patchReload: 'live' } } }))
    writeFileSync(patchFile, "- id: biz-row\n  disabled: true\n  config:\n    url: 'http://x'\n")
    loaderEntries = [{ id: 'biz-row', disabled: true, fiber: { state: 3 } }]
    const admin = await setup()
    const s = await admin.status()
    expect(s.services.find((x) => x.id === 'biz-row')).toMatchObject({ enabled: false, phase: 'failed', health: null, registered: true, fields: [{ path: 'url', label: 'URL' }] })
    expect(s.checks.find((c) => c.id === 'biz-row.config')).toMatchObject({ status: 'warn', detail: 'url: wss only' })
  })

  it('saves a registered row with schema + validate, per-field errors and conflict detection', async () => {
    const admin = await setup()
    admin.registerEntry(bizEntry())
    const { version } = await admin.status()

    const err = await admin.saveService('biz-row', true, { url: 'http://x', batchSize: 20, maxInFlight: 10 }, version).catch((e) => e)
    expect(err.code).toBe('gateway/bad-request')
    expect(JSON.parse(err.message)).toMatchObject({
      code: 'invalid_config',
      errors: [
        { path: 'biz-row.url', message: '必须是 wss://' },
        { path: 'biz-row.batchSize', message: 'batchSize <= maxInFlight' },
      ],
    })
    await expect(admin.saveService('biz-row', true, { batchSize: 1 }, version)).rejects.toThrow(/invalid_config.*url/)

    const saved = await admin.saveService('biz-row', true, { url: 'wss://b.example/ws' }, version)
    expect(saved.version).not.toBe(version)
    expect(readFileSync(patchFile, 'utf8')).toContain('url: wss://b.example/ws')
    await expect(admin.saveService('biz-row', false, null, version)).rejects.toThrow(/conflict/)
    await expect(admin.saveService('not-registered', true, {}, saved.version)).rejects.toThrow(/bad_request/)
  })

  it('saving a kit row keeps the registered row byte-for-byte, and vice versa', async () => {
    const admin = await setup()
    admin.registerEntry(bizEntry())
    const s1 = await admin.status()
    const { version } = await admin.saveService('agent-kit-dingtalk', true, { identity: 'bot', robotCode: 'ding2' }, s1.version)
    expect(readFileSync(patchFile, 'utf8').endsWith(BUSINESS_ROW)).toBe(true)

    const kitText = readFileSync(patchFile, 'utf8').slice(0, -BUSINESS_ROW.length)
    await admin.saveService('biz-row', false, null, version)
    const text = readFileSync(patchFile, 'utf8')
    expect(text.startsWith(kitText)).toBe(true)
    // 被保存的行本身会按 yaml 的格式规范化（例如注释前的空格），内容不变
    expect(text.slice(kitText.length)).toMatch(/^- id: biz-row +# 业务行\n  disabled: true\n  config:\n    url: 'wss:\/\/a\.example\/ws'\n/)
  })

  it('stores and clears only a registered secret ref, leaving the TypeSafe key untouched', async () => {
    const admin = await setup()
    admin.registerEntry(bizEntry())
    await admin.setSecret('credentials', 'ts-key', null)
    expect(await admin.setSecret('credentials', 'biz-secret-value', 'BIZ_TOKEN')).toEqual({ configured: true, source: 'credentials' })
    expect(await readCredential('BIZ_TOKEN', credentialsFile)).toBe('biz-secret-value')
    const s = await admin.status()
    expect(s.services.find((x) => x.id === 'biz-row')?.secrets).toEqual([{ label: '上游 Token', ref: 'BIZ_TOKEN', configured: true, source: 'credentials' }])
    expect(JSON.stringify(s)).not.toContain('biz-secret-value')

    expect(await admin.clearSecret('credentials', 'BIZ_TOKEN')).toEqual({ configured: false })
    expect(await readCredential('BIZ_TOKEN', credentialsFile)).toBeUndefined()
    expect(await readCredential('TYPESAFE_API_KEY', credentialsFile)).toBe('ts-key')
    expect((await admin.status()).typesafeKey).toEqual({ configured: true, source: 'credentials' })
  })

  it('rejects unknown refs and keychain targets for registered secrets', async () => {
    const admin = await setup()
    admin.registerEntry(bizEntry())
    await expect(admin.setSecret('credentials', 'v', 'SOMETHING_ELSE')).rejects.toThrow(/bad_request.*unknown secret ref/)
    await expect(admin.clearSecret('credentials', 'SOMETHING_ELSE')).rejects.toThrow(/bad_request/)
    await expect(admin.setSecret('keychain' as never, 'v', 'BIZ_TOKEN')).rejects.toThrow(/bad_request/)
    expect(await readCredential('SOMETHING_ELSE', credentialsFile)).toBeUndefined()
  })

  it('follows a secret ref taken from config after the config is saved', async () => {
    const admin = await setup()
    admin.registerEntry(bizEntry())
    const { version } = await admin.status()
    await admin.saveService('biz-row', true, { url: 'wss://a.example/ws', tokenEnv: 'IPROOST_AGENT_TOKEN' }, version)
    const s = await admin.status()
    expect(s.services.find((x) => x.id === 'biz-row')?.secrets).toEqual([{ label: '上游 Token', ref: 'IPROOST_AGENT_TOKEN', configured: false }])
    await expect(admin.setSecret('credentials', 'v', 'BIZ_TOKEN')).rejects.toThrow(/unknown secret ref/)
    expect(await admin.setSecret('credentials', 'new-token', 'IPROOST_AGENT_TOKEN')).toEqual({ configured: true, source: 'credentials' })
  })

  it('reports a throwing health() as failed instead of breaking status()', async () => {
    const admin = await setup()
    admin.registerEntry(bizEntry({ health: () => { throw new Error('boom') } }))
    expect((await admin.status()).services.find((x) => x.id === 'biz-row')?.health).toEqual({ status: 'failed', detail: 'health() 执行失败：boom' })
  })

  it('reads health from a named cordis service when no health() is given', async () => {
    root.provide('bizService', { health: () => ({ status: 'degraded', detail: 'reconnecting' }) } as never)
    const admin = await setup()
    admin.registerEntry(bizEntry({ health: undefined, service: 'bizService' }))
    expect((await admin.status()).services.find((x) => x.id === 'biz-row')?.health).toEqual({ status: 'degraded', detail: 'reconnecting' })
  })
})
