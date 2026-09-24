// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../../src/client/settings-page.js'
import { createAdminApi, type AdminApi, type AdminStatus } from '../../src/client/remote.js'
import { zh } from '../../src/client/locale.js'

// vitest.config.ts 未开启 `test.globals`，@testing-library/react 的自动清理依赖全局 afterEach，
// 因此这里显式注册，避免上一个用例渲染的 DOM 残留导致下一个用例里出现重复元素。
afterEach(cleanup)

const t = (k: string, vars?: Record<string, string | number>) => (zh[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => String(vars?.[n] ?? ''))

function status(over: Partial<AdminStatus> = {}): AdminStatus {
  return {
    profile: 'kit',
    patchReload: 'live',
    version: 'v1',
    writable: true,
    services: [
      { id: 'agent-kit-ws', title: 'WebSocket', enabled: true, phase: 'active', health: { status: 'ok', detail: '1 connection(s) open' }, config: {} },
      { id: 'agent-kit-dingtalk', title: '钉钉', enabled: false, phase: null, health: null, config: undefined },
      { id: 'agent-kit-agent-tasks', title: 'Agent 任务', enabled: false, phase: null, health: null, config: undefined },
      { id: 'agent-kit-jev', title: 'Jev 判断', enabled: true, phase: 'failed', health: null, config: { model: 'jev-latest' } },
    ],
    checks: [{ id: 'agent-kit-jev.key', scope: 'agent-kit-jev', title: 'TypeSafe Key', status: 'fail', detail: '没有找到', fix: '设置 Key' }],
    typesafeKey: { configured: false },
    keyTargets: ['credentials'],
    ...over,
  }
}

function fakeApi(s: AdminStatus): AdminApi & { saveService: ReturnType<typeof vi.fn>; setSecret: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => s),
    saveService: vi.fn(async () => ({ version: 'v2' })),
    setSecret: vi.fn(async () => ({ configured: true, source: 'credentials' })),
    clearSecret: vi.fn(async () => ({ configured: false })),
  }
}

describe('SettingsPage', () => {
  it('renders one card per service with health and failing checks', async () => {
    render(<SettingsPage api={fakeApi(status())} t={t} />)
    expect(await screen.findByText('WebSocket')).toBeTruthy()
    expect(screen.getByText('1 connection(s) open')).toBeTruthy()
    expect(screen.getByText(/没有找到/)).toBeTruthy()
    expect(screen.getByText(/设置 Key/)).toBeTruthy()
  })

  it('enables a service and saves with the current version', async () => {
    const api = fakeApi(status())
    render(<SettingsPage api={api} t={t} />)
    const toggle = await screen.findByRole('switch', { name: /钉钉/ })
    fireEvent.click(toggle)
    fireEvent.change(screen.getByLabelText(zh['dingtalk.identity']!), { target: { value: 'bot' } })
    fireEvent.change(screen.getByLabelText(zh['dingtalk.robotCode']!), { target: { value: 'ding1' } })
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 钉钉` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-dingtalk', true, expect.objectContaining({ identity: 'bot', robotCode: 'ding1' }), 'v1'))
  })

  it('shows a conflict message and reloads', async () => {
    const api = fakeApi(status())
    api.saveService.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'conflict' }))
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${zh.save} WebSocket` }))
    expect(await screen.findByText(zh.conflict!)).toBeTruthy()
  })

  it('shows field errors from the server', async () => {
    const api = fakeApi(status())
    api.saveService.mockRejectedValueOnce(Object.assign(new Error('invalid'), { code: 'invalid_config', errors: [{ path: 'agent-kit-ws.readTimeoutMs', message: 'too small' }] }))
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${zh.save} WebSocket` }))
    expect(await screen.findByText(/readTimeoutMs: too small/)).toBeTruthy()
  })

  it('sets the TypeSafe key without ever displaying it', async () => {
    const api = fakeApi(status())
    render(<SettingsPage api={api} t={t} />)
    fireEvent.change(await screen.findByLabelText(zh['jev.key']!), { target: { value: 'ts-secret' } })
    fireEvent.click(screen.getByRole('button', { name: zh['jev.saveKey']! }))
    await waitFor(() => expect(api.setSecret).toHaveBeenCalledWith('credentials', 'ts-secret'))
    expect(document.body.textContent).not.toContain('ts-secret')
  })

  it('disables editing when read-only', async () => {
    render(<SettingsPage api={fakeApi(status({ writable: false, readOnlyReason: 'dsh Web 未绑定 127.0.0.1' }))} t={t} />)
    expect(await screen.findByText(/未绑定 127\.0\.0\.1/)).toBeTruthy()
    expect((screen.getByRole('switch', { name: /WebSocket/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('createAdminApi', () => {
  it('unwraps remote results and parses server error payloads', async () => {
    const remote = {
      agentKitAdmin: {
        status: async () => ({ ok: true, value: status() }),
        saveService: async () => ({ ok: false, error: { code: 'gateway/bad-request', message: JSON.stringify({ code: 'conflict', message: '已被修改' }) } }),
      },
    }
    const api = createAdminApi(remote as never)
    expect((await api.status()).profile).toBe('kit')
    await expect(api.saveService('agent-kit-ws', true, null, 'v1')).rejects.toMatchObject({ code: 'conflict', message: '已被修改' })
  })
})
