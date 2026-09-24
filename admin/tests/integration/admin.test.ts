import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentKitAdmin } from '../../src/admin/service.js'
import { SHARED_KEYCHAIN_SERVICE, type Keychain } from '@mc/dsh-agent-kit/secrets'

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

  it('rejects an unsupported key target as bad_request', async () => {
    const admin = await setup('127.0.0.1')
    await expect(admin.setSecret('keychain' as never, 'v')).rejects.toThrow(/bad_request/)
    await expect(admin.clearSecret('keychain' as never)).rejects.toThrow(/bad_request/)
  })

  it('rejects an empty or non-string secret value as bad_request', async () => {
    const admin = await setup('127.0.0.1')
    await expect(admin.setSecret('credentials', '')).rejects.toThrow(/bad_request/)
    await expect(admin.setSecret('credentials', '   ')).rejects.toThrow(/bad_request/)
    await expect(admin.setSecret('credentials', 123 as never)).rejects.toThrow(/bad_request/)
  })

  /**
   * I1 回归测试：Web 端 `JevForm` 从不设置 `keychainService`，之前 `setSecret`/`status()`/`jev` 检查
   * 只在 jev 配置显式给出 `keychainService` 时才查钥匙串，导致把 TypeSafe Key 存到钥匙串后页面和
   * `doctor` 都看不到。这里用 `keyStore: { platform: 'darwin', keychain: fake }`（未设置 jev 的
   * `keychainService`）模拟：写入钥匙串后 `status()` 报告已配置、来源为 `keychain:ai.typesafe.api-key`，
   * `jev` 检查同样通过。
   */
  it('makes a keychain-saved TypeSafe key visible in status() and the jev check on macOS (I1)', async () => {
    const memory = new Map<string, string>()
    const fakeKeychain: Keychain = {
      read: async (s, a) => memory.get(`${s}/${a}`),
      write: async (s, a, v) => void memory.set(`${s}/${a}`, v),
      remove: async (s, a) => void memory.delete(`${s}/${a}`),
    }
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: agent-kit-ws\n  disabled: false\n- id: agent-kit-jev\n  disabled: false\n  config: {}\n')
    root.provide('loader', { entries: () => [{ id: 'agent-kit-ws', disabled: false, fiber: { state: 2 } }] } as never)
    root.provide('webServer', { host: '127.0.0.1' } as never)
    await root.plugin(AgentKitAdmin, {
      profileDir,
      keyStore: { env: {}, platform: 'darwin', keychainAccount: 'alice', keychain: fakeKeychain, credentialsFile: join(home, '.credentials.yaml') },
    } as never)
    const admin = root.get('agentKitAdmin') as unknown as AgentKitAdmin

    expect(await admin.setSecret('keychain', 'ts-mac-secret')).toEqual({ configured: true, source: `keychain:${SHARED_KEYCHAIN_SERVICE}` })
    expect(memory.get(`${SHARED_KEYCHAIN_SERVICE}/alice`)).toBe('ts-mac-secret')

    const status = await admin.status()
    expect(status.typesafeKey).toEqual({ configured: true, source: `keychain:${SHARED_KEYCHAIN_SERVICE}` })
    expect(JSON.stringify(status)).not.toContain('ts-mac-secret')
    const jevKeyCheck = status.checks.find((c) => c.id === 'agent-kit-jev.key')
    expect(jevKeyCheck).toMatchObject({ status: 'pass' })
  })

  /**
   * 回归测试：真实 dsh 里的 `credentials` 服务（`@deepseek-ai/dsh-credentials-local`）用 chokidar 监听
   * `$DSH_HOME/.credentials.yaml`、默认 100ms 防抖才把刚写入的内容并入内存快照；`setSecret`/`clearSecret`
   * 自己直接对这份文件加锁写入后，若立刻用这个（可能还没跟上防抖窗口的）实时服务去 `describe`，读到的
   * 还是旧快照——在真实 dsh Web 走查中复现过：点「保存 Key」后网络响应就是 `{ configured: false }`，页面
   * 停留在「未配置」，且不会再自动重试。这里模拟一个「resolve() 前几次仍返回旧值、之后才追上」的
   * `credentials` 服务，确认 `setSecret`/`clearSecret` 会重试到状态追上写入动作为止，而不是把这个防抖期
   * 内的旧快照直接返回给调用方。
   */
  it('retries describing the key through a credentials service that lags behind its own file write', async () => {
    // 模拟 resolve()：`liveValue` 是实时服务内存快照里“看得见”的值，`current` 是我们刚写完文件之后
    // 的真实值；防抖窗口内（staleCallsLeft > 0）resolve() 还只报告旧的 `liveValue`，过了窗口才追上
    // `current`——这与 chokidar 的 `awaitWriteFinish` 防抖行为一致。
    let resolveCalls = 0
    let staleCallsLeft = 0
    let liveValue: string | undefined
    let current: string | undefined
    root.provide('credentials', {
      resolve: async (ref: string) => {
        resolveCalls++
        if (ref !== 'TYPESAFE_API_KEY') return undefined
        if (staleCallsLeft > 0) {
          staleCallsLeft--
        } else {
          liveValue = current
        }
        return liveValue === undefined ? undefined : { value: liveValue }
      },
    } as never)
    root.provide('loader', { entries: () => [{ id: 'agent-kit-ws', disabled: false, fiber: { state: 2 } }] } as never)
    root.provide('webServer', { host: '127.0.0.1' } as never)
    await root.plugin(AgentKitAdmin, { profileDir, keyStore: { env: {}, platform: 'linux', credentialsFile: join(home, '.credentials.yaml') } } as never)
    const admin = root.get('agentKitAdmin') as unknown as AgentKitAdmin

    staleCallsLeft = 2
    current = 'ts-lagging-key'
    expect(await admin.setSecret('credentials', 'ts-lagging-key')).toEqual({ configured: true, source: 'credentials' })
    expect(resolveCalls).toBe(3) // 前 2 次撞见防抖窗口内的旧快照（未配置），第 3 次才追上

    const callsBeforeClear = resolveCalls
    staleCallsLeft = 2
    current = undefined
    expect(await admin.clearSecret('credentials')).toEqual({ configured: false })
    expect(resolveCalls).toBe(callsBeforeClear + 3) // 前 2 次仍看到清除前的旧值，第 3 次才追上
  })

  /**
   * 回归测试：真实 dsh Web 走查中发现，`loader.entries()` 返回的 `id` 并不是 `KIT_ENTRIES` 里的裸 id，
   * 而是带着宿主 `insert:` 树前缀、用 `:` 拼接的完整路径（例如 `include:agent-kit-dingtalk`）。旧代码
   * 直接用裸 id 去 `Map.get()`，在真实宿主里永远查不到对应 entry，导致 `phase` 恒为 `null`（页面显示
   * 「未运行」），即便 fiber 其实已经是 active——这里模拟同样的前缀，确认状态上报按最后一段匹配、不受
   * 前缀影响。
   */
  it('matches loader entries whose id carries a host insert-tree prefix', async () => {
    root.provide('loader', { entries: () => [{ id: 'include:agent-kit-ws', disabled: false, fiber: { state: 2 } }] } as never)
    root.provide('webServer', { host: '127.0.0.1' } as never)
    await root.plugin(AgentKitAdmin, { profileDir, keyStore: { env: {}, platform: 'linux', credentialsFile: join(home, '.credentials.yaml') } } as never)
    const admin = root.get('agentKitAdmin') as unknown as AgentKitAdmin
    const s = await admin.status()
    expect(s.services.find((x) => x.id === 'agent-kit-ws')).toMatchObject({ enabled: true, phase: 'active' })
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
