import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentKitAdmin } from '../../src/admin/service.js'

let home: string
let profileDir: string
let root: Context

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  profileDir = join(home, 'profiles', 'kit')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@mc/dsh-agent-kit'], patchReload: 'live' } } }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: agent-kit-ws\n  disabled: false\n')
  root = new Context()
})
afterEach(async () => {
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

async function setup(host: '127.0.0.1' | '0.0.0.0' | undefined) {
  root.provide('loader', { entries: () => [{ id: 'agent-kit-ws', disabled: false, fiber: { state: 2 } }] } as never)
  if (host) root.provide('webServer', { host } as never)
  await root.plugin(AgentKitAdmin, { profileDir, keyStore: { env: {}, platform: 'linux', credentialsFile: join(home, '.credentials.yaml') } } as never)
  return root.get('agentKitAdmin') as unknown as AgentKitAdmin
}

describe('AgentKitAdmin', () => {
  it('reports status with health, checks and key description', async () => {
    const admin = await setup('127.0.0.1')
    const s = await admin.status()
    expect(s).toMatchObject({ profile: 'kit', patchReload: 'live', writable: true, typesafeKey: { configured: false }, keyTargets: ['credentials'] })
    expect(s.services.find((x) => x.id === 'agent-kit-ws')).toMatchObject({ enabled: true, phase: 'active' })
    expect(s.checks.some((c) => c.id === 'node')).toBe(true)
  })

  it('saves service config with optimistic concurrency', async () => {
    const admin = await setup('127.0.0.1')
    const { version } = await admin.status()
    const r = await admin.saveService('agent-kit-jev', true, { model: 'jev-latest' }, version)
    expect(r.version).not.toBe(version)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('agent-kit-jev')
    await expect(admin.saveService('agent-kit-jev', false, null, version)).rejects.toThrow(/conflict/)
    await expect(admin.saveService('agent-kit-ws', true, { pingIntervalMs: 30000, readTimeoutMs: 10 }, r.version)).rejects.toThrow(/invalid_config/)
  })

  it('stores secrets write-only', async () => {
    const admin = await setup('127.0.0.1')
    expect(await admin.setSecret('credentials', 'ts-key-123')).toEqual({ configured: true, source: 'credentials' })
    expect(JSON.stringify(await admin.status())).not.toContain('ts-key-123')
    expect(await admin.clearSecret('credentials')).toEqual({ configured: false })
  })

  it('is read-only when the web server is exposed beyond loopback', async () => {
    const admin = await setup('0.0.0.0')
    const s = await admin.status()
    expect(s.writable).toBe(false)
    expect(s.readOnlyReason).toMatch(/127\.0\.0\.1/)
    await expect(admin.saveService('agent-kit-ws', false, null, s.version)).rejects.toThrow(/read_only/)
    await expect(admin.setSecret('credentials', 'x')).rejects.toThrow(/read_only/)
  })

  it('is read-only when webServer is not loaded at all (fail closed)', async () => {
    const admin = await setup(undefined)
    const s = await admin.status()
    expect(s.writable).toBe(false)
    expect(s.readOnlyReason).toMatch(/127\.0\.0\.1/)
    await expect(admin.saveService('agent-kit-ws', false, null, s.version)).rejects.toThrow(/read_only/)
    await expect(admin.setSecret('credentials', 'x')).rejects.toThrow(/read_only/)
  })

  it('reports a degraded read-only status when the profile cannot be located', async () => {
    root.provide('loader', { entries: () => [{ id: 'agent-kit-ws', disabled: false, fiber: { state: 2 } }] } as never)
    root.provide('webServer', { host: '127.0.0.1' } as never)
    await root.plugin(AgentKitAdmin, {
      profileDir: join(home, 'profiles', 'missing'),
      keyStore: { env: {}, platform: 'linux', credentialsFile: join(home, '.credentials.yaml') },
    } as never)
    const admin = root.get('agentKitAdmin') as unknown as AgentKitAdmin
    const s = await admin.status()
    expect(s).toMatchObject({
      profile: '',
      patchReload: 'startup',
      version: '',
      writable: false,
      readOnlyReason: '无法定位 Profile 目录',
      checks: [],
    })
    expect(s.services).toHaveLength(s.services.length)
    for (const svc of s.services) {
      expect(svc.enabled).toBe(false)
      expect(svc.health).toBeNull()
      expect(svc.config).toBeUndefined()
    }
    expect(s.services.find((x) => x.id === 'agent-kit-ws')).toMatchObject({ phase: 'active' })
    expect(s.typesafeKey).toEqual({ configured: false })
    expect(s.keyTargets).toEqual(['credentials'])
  })
})
