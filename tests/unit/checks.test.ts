import { describe, expect, it } from 'vitest'
import { runChecks, type CheckContext } from '../../src/checks/index.js'
import type { KitSnapshot } from '../../src/profile/index.js'

function snapshot(entries: Partial<KitSnapshot['entries']>): KitSnapshot {
  const off = { enabled: false, config: undefined }
  return {
    version: 'v',
    entries: { 'agent-kit-ws': off, 'agent-kit-dingtalk': off, 'agent-kit-agent-tasks': off, 'agent-kit-jev': off, ...entries },
  }
}

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    profile: { name: 'kit', dir: '/p', patchFile: '/p/cordis.patch.yml', bundles: ['@deepseek-ai/dsh-base', '@mc/dsh-agent-kit'], patchReload: 'live', hasKit: true },
    snapshot: snapshot({}),
    env: {},
    platform: 'darwin',
    nodeVersion: '24.1.0',
    resolveModule: () => true,
    exec: async () => ({ exitCode: 0, stdout: JSON.stringify({ authenticated: true, token_valid: true }), stderr: '' }),
    keyStore: { env: {}, platform: 'linux', credentialsFile: '/nonexistent/.credentials.yaml' },
    findExecutable: () => '/usr/bin/dws',
    ...over,
  }
}

const byId = (r: Awaited<ReturnType<typeof runChecks>>, id: string) => r.results.find((x) => x.id === id)

describe('common checks', () => {
  it('passes a healthy profile with nothing enabled', async () => {
    const r = await runChecks(ctx())
    expect(r.ok).toBe(true)
    expect(byId(r, 'node')!.status).toBe('pass')
    expect(byId(r, 'bundle')!.status).toBe('pass')
    expect(r.results.every((x) => x.scope === 'common')).toBe(true)
  })

  it('fails on old node, missing bundle, and warns on startup reload', async () => {
    const r = await runChecks(ctx({ nodeVersion: '20.10.0', profile: { ...ctx().profile, hasKit: false, patchReload: 'startup' } }))
    expect(byId(r, 'node')!.status).toBe('fail')
    expect(byId(r, 'bundle')).toMatchObject({ status: 'fail', fix: expect.stringContaining('dsh plugin --profile kit add @mc/dsh-agent-kit') })
    expect(byId(r, 'patch-reload')!.status).toBe('warn')
    expect(r.ok).toBe(false)
  })

  it('validates node version boundaries: ^22.19 || >=24', async () => {
    expect(byId(await runChecks(ctx({ nodeVersion: '22.18.0' })), 'node')!.status).toBe('fail')
    expect(byId(await runChecks(ctx({ nodeVersion: '22.19.0' })), 'node')!.status).toBe('pass')
    expect(byId(await runChecks(ctx({ nodeVersion: '23.5.0' })), 'node')!.status).toBe('fail')
    expect(byId(await runChecks(ctx({ nodeVersion: '24.0.0' })), 'node')!.status).toBe('pass')
    expect(byId(await runChecks(ctx({ nodeVersion: '26.1.0' })), 'node')!.status).toBe('pass')
  })
})

describe('service checks', () => {
  it('validates config of enabled services', async () => {
    const r = await runChecks(ctx({ snapshot: snapshot({ 'agent-kit-ws': { enabled: true, config: { pingIntervalMs: 30000, readTimeoutMs: 1000 } } }) }))
    expect(byId(r, 'agent-kit-ws.config')).toMatchObject({ status: 'fail', detail: expect.stringContaining('readTimeoutMs') })
  })

  it('checks dws install and login for dingtalk', async () => {
    const enabled = snapshot({ 'agent-kit-dingtalk': { enabled: true, config: { identity: 'user' } } })
    const missing = await runChecks(ctx({ snapshot: enabled, findExecutable: () => undefined }))
    expect(byId(missing, 'agent-kit-dingtalk.dws')!.status).toBe('fail')
    const loggedOut = await runChecks(ctx({ snapshot: enabled, exec: async () => ({ exitCode: 0, stdout: JSON.stringify({ authenticated: false }), stderr: '' }) }))
    expect(byId(loggedOut, 'agent-kit-dingtalk.login')).toMatchObject({ status: 'fail', fix: 'dws auth login' })
    const dry = await runChecks(ctx({ snapshot: snapshot({ 'agent-kit-dingtalk': { enabled: true, config: { identity: 'user', dryRun: true } } }) }))
    expect(byId(dry, 'agent-kit-dingtalk.login')!.status).toBe('skip')
  })

  it('checks provider install and declared permissions for agentTasks', async () => {
    const enabled = snapshot({ 'agent-kit-agent-tasks': { enabled: true, config: { workspaceDir: '/tmp/x' } } })
    const r = await runChecks(ctx({ snapshot: enabled, resolveModule: (m) => m !== '@deepseek-ai/dsh-subagent-codex' }))
    expect(byId(r, 'agent-kit-agent-tasks.provider')!.status).toBe('pass')
    expect(byId(r, 'agent-kit-agent-tasks.permissions')).toMatchObject({ status: 'warn', detail: expect.stringContaining('claude-code') })
    const declared = snapshot({ 'agent-kit-agent-tasks': { enabled: true, config: { workspaceDir: '/tmp/x', declaredPermissions: { 'claude-code': 'read-only' } } } })
    expect(byId(await runChecks(ctx({ snapshot: declared, resolveModule: (m) => m !== '@deepseek-ai/dsh-subagent-codex' })), 'agent-kit-agent-tasks.permissions')!.status).toBe('pass')
    const none = await runChecks(ctx({ snapshot: enabled, resolveModule: (m) => !m.startsWith('@deepseek-ai/dsh-subagent-') }))
    expect(byId(none, 'agent-kit-agent-tasks.provider')!.status).toBe('fail')
  })

  it('checks sdk and key source for jev without printing the key', async () => {
    const enabled = snapshot({ 'agent-kit-jev': { enabled: true, config: {} } })
    const noKey = await runChecks(ctx({ snapshot: enabled }))
    expect(byId(noKey, 'agent-kit-jev.key')).toMatchObject({ status: 'fail', fix: expect.stringContaining('setup') })
    const withKey = await runChecks(ctx({ snapshot: enabled, keyStore: { env: { TYPESAFE_API_KEY: 'secret-abc' } } }))
    expect(byId(withKey, 'agent-kit-jev.key')).toMatchObject({ status: 'pass', detail: expect.stringContaining('env') })
    expect(JSON.stringify(withKey)).not.toContain('secret-abc')
    const noSdk = await runChecks(ctx({ snapshot: enabled, resolveModule: (m) => m !== '@typesafe-ai/sdk' }))
    expect(byId(noSdk, 'agent-kit-jev.sdk')!.status).toBe('fail')
  })
})

describe('every fail/warn result carries a fix', () => {
  function assertFixes(r: Awaited<ReturnType<typeof runChecks>>): void {
    for (const result of r.results) {
      if (result.status === 'fail' || result.status === 'warn') {
        expect(result.fix, `${result.id} (${result.status}) is missing a fix`).toBeTruthy()
        expect(result.fix!.length).toBeGreaterThan(0)
      }
    }
  }

  it('common: patch-reload warn has a fix', async () => {
    const r = await runChecks(ctx({ profile: { ...ctx().profile, patchReload: 'startup' } }))
    expect(byId(r, 'patch-reload')).toMatchObject({ status: 'warn', fix: expect.stringContaining('patchReload') })
    assertFixes(r)
  })

  it('dingtalk: webhook-token fail (env unset) has a fix', async () => {
    const enabled = snapshot({ 'agent-kit-dingtalk': { enabled: true, config: { identity: 'webhook', webhookTokenEnv: 'DT_TOKEN' } } })
    const r = await runChecks(ctx({ snapshot: enabled, env: {} }))
    expect(byId(r, 'agent-kit-dingtalk.webhook-token')).toMatchObject({ status: 'fail', fix: expect.stringContaining('DT_TOKEN') })
    assertFixes(r)
  })

  it('dingtalk: webhook-token fail (webhookTokenEnv unset) has a fix', async () => {
    const enabled = snapshot({ 'agent-kit-dingtalk': { enabled: true, config: { identity: 'webhook' } } })
    const r = await runChecks(ctx({ snapshot: enabled }))
    expect(byId(r, 'agent-kit-dingtalk.webhook-token')).toMatchObject({ status: 'fail', fix: expect.stringContaining('webhookTokenEnv') })
    assertFixes(r)
  })

  it('run: <kit>.config fail has a fix', async () => {
    const r = await runChecks(ctx({ snapshot: snapshot({ 'agent-kit-ws': { enabled: true, config: { pingIntervalMs: 30000, readTimeoutMs: 1000 } } }) }))
    expect(byId(r, 'agent-kit-ws.config')).toMatchObject({ status: 'fail', fix: expect.stringContaining('setup') })
    assertFixes(r)
  })

  it('holds across every other scenario in this file', async () => {
    assertFixes(await runChecks(ctx({ nodeVersion: '20.10.0', profile: { ...ctx().profile, hasKit: false, patchReload: 'startup' } })))
    const enabledDingtalk = snapshot({ 'agent-kit-dingtalk': { enabled: true, config: { identity: 'user' } } })
    assertFixes(await runChecks(ctx({ snapshot: enabledDingtalk, findExecutable: () => undefined })))
    assertFixes(await runChecks(ctx({ snapshot: enabledDingtalk, exec: async () => ({ exitCode: 0, stdout: JSON.stringify({ authenticated: false }), stderr: '' }) })))
    const enabledAgentTasks = snapshot({ 'agent-kit-agent-tasks': { enabled: true, config: { workspaceDir: '/tmp/x' } } })
    assertFixes(await runChecks(ctx({ snapshot: enabledAgentTasks, resolveModule: (m) => m !== '@deepseek-ai/dsh-subagent-codex' })))
    assertFixes(await runChecks(ctx({ snapshot: enabledAgentTasks, resolveModule: (m) => !m.startsWith('@deepseek-ai/dsh-subagent-') })))
    const enabledJev = snapshot({ 'agent-kit-jev': { enabled: true, config: {} } })
    assertFixes(await runChecks(ctx({ snapshot: enabledJev })))
    assertFixes(await runChecks(ctx({ snapshot: enabledJev, resolveModule: (m) => m !== '@typesafe-ai/sdk' })))
  })
})
