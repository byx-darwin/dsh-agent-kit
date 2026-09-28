// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../../src/client/settings-page.js'
import { AGENT_KIT_REMOTE, createAdminApi, type AdminApi, type AdminStatus } from '../../src/client/remote.js'
import { en, zh } from '../../src/client/locale.js'
import { WsConfig } from '../../../src/ws/config.js'

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

function fakeApi(
  s: AdminStatus,
): AdminApi & { status: ReturnType<typeof vi.fn>; saveService: ReturnType<typeof vi.fn>; setSecret: ReturnType<typeof vi.fn>; clearSecret: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => s),
    saveService: vi.fn(async () => ({ version: 'v2' })),
    setSecret: vi.fn(async () => ({ configured: true, source: 'credentials' })),
    clearSecret: vi.fn(async () => ({ configured: false })),
    dingtalkAuth: vi.fn(async () => ({ installed: true, authenticated: false })),
    dingtalkUnmatched: vi.fn(async () => []),
    dingtalkSearchRecipients: vi.fn(async () => ({ candidates: [], complete: true })),
    dingtalkLogin: vi.fn(async () => ({ state: 'waiting' as const })),
    dingtalkLoginCancel: vi.fn(async () => ({ cancelled: true as const })),
    dingtalkLogout: vi.fn(async () => ({ installed: true, authenticated: false })),
  }
}

describe('SettingsPage', () => {
  it('shows WebSocket defaults as editable values when the config omits them', async () => {
    const api = fakeApi(status())
    const defaults = WsConfig({})
    render(<SettingsPage api={api} t={t} />)
    const ping = await screen.findByRole('spinbutton', { name: zh['ws.pingIntervalMs']! }) as HTMLInputElement
    const timeout = screen.getByRole('spinbutton', { name: zh['ws.readTimeoutMs']! }) as HTMLInputElement
    expect(ping.value).toBe(String(defaults.pingIntervalMs))
    expect(timeout.value).toBe(String(defaults.readTimeoutMs))

    fireEvent.change(ping, { target: { value: '' } })
    expect(ping.value).toBe('')
    fireEvent.change(ping, { target: { value: '35000' } })
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} WebSocket` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-ws', true, {
      pingIntervalMs: 35_000,
      readTimeoutMs: defaults.readTimeoutMs,
    }, 'v1'))
  })

  it('does not hard-code provider permissions in the shared Agent tasks form', async () => {
    const s = status()
    s.services[2] = { ...s.services[2]!, enabled: true, phase: 'active', config: {
      workspaceDir: '/tmp/agent-tasks', declaredPermissions: { 'claude-code': 'read-only', codex: 'read-only' },
    } }
    const api = fakeApi(s)
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByRole('textbox', { name: zh['agentTasks.workspaceDir']! })).toBeTruthy()
    expect(screen.queryByText(/claude-code 权限上限/)).toBeNull()
    expect(screen.queryByText(/codex 权限上限/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} Agent 任务` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-agent-tasks', true, {
      workspaceDir: '/tmp/agent-tasks', declaredPermissions: { 'claude-code': 'read-only', codex: 'read-only' },
    }, 'v1'))
  })

  it('renders one card per service with health and failing checks', async () => {
    render(<SettingsPage api={fakeApi(status())} t={t} />)
    expect(await screen.findByText('WebSocket')).toBeTruthy()
    expect(screen.getByText('1 connection(s) open')).toBeTruthy()
    expect(screen.getByText(/没有找到/)).toBeTruthy()
    expect(screen.getByText(/设置 Key/)).toBeTruthy()
  })

  it('hides the notification service card without changing its backend status', async () => {
    const s = status()
    s.services.push({ id: 'agent-kit-notify', title: '通知渠道', enabled: true, phase: 'active', health: null, config: { channel: 'dingtalk' } })
    const api = fakeApi(s)
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByText('WebSocket')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '通知渠道' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存 通知渠道' })).toBeNull()
    expect((await api.status()).services.some((service) => service.id === 'agent-kit-notify')).toBe(true)
  })

  it('shows unmatched group names alongside stable IDs in the DingTalk card', async () => {
    const s = status()
    s.services[1] = { ...s.services[1]!, enabled: true, phase: 'active' }
    const api = fakeApi(s)
    api.dingtalkUnmatched = vi.fn(async () => [{ eventId: 'e1', conversationId: 'cidA', groupName: '研发群', preview: '待接入插件', receivedAt: 123 }])
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['dingtalk.unmatched.refresh']! }))
    expect(await screen.findByText('研发群')).toBeTruthy()
    expect(screen.getByText('cidA')).toBeTruthy()
    expect(screen.getByText('待接入插件')).toBeTruthy()
  })

  it('saves a group-to-business-plugin route selected from unmatched messages', async () => {
    const s = status()
    s.services[1] = { ...s.services[1]!, enabled: true, phase: 'active', config: { identity: 'user' } }
    s.services.push({ id: 'business-orders', title: '工单插件', enabled: true, phase: 'active', health: null, config: {}, registered: true })
    const api = fakeApi(s)
    api.dingtalkUnmatched = vi.fn(async () => [{ eventId: 'e1', conversationId: 'cidOrders', groupName: '工单群', preview: '待处理', receivedAt: 123 }])
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['dingtalk.routes.discover']! }))
    fireEvent.click(await screen.findByRole('button', { name: '工单群 · cidOrders' }))
    fireEvent.change(screen.getByRole('combobox', { name: zh['dingtalk.routes.plugin']! }), { target: { value: 'business-orders' } })
    fireEvent.click(screen.getByRole('button', { name: zh['dingtalk.routes.add']! }))
    expect(screen.getByText('工单群')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 钉钉` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-dingtalk', true, {
      identity: 'user', groupRoutes: [{ conversationId: 'cidOrders', pluginId: 'business-orders' }],
    }, 'v1'))
  })

  it('lets an arbitrary business card select a group or person as its forwarding target', async () => {
    const s = status()
    s.services.push({ id: 'business-orders', title: '工单插件', enabled: true, phase: 'active', health: null, config: {}, registered: true,
      fields: [{ path: 'forwardTo', label: '工单转发对象', kind: 'dingtalk-target' }] })
    const api = fakeApi(s)
    api.dingtalkSearchRecipients = vi.fn(async (kind) => kind === 'group'
      ? { candidates: [{ name: '工单群', target: { chatId: 'cidOrders' } }], complete: true }
      : { candidates: [{ name: '张三', target: { userId: 'userZ' } }], complete: false })
    render(<SettingsPage api={api} t={t} />)
    fireEvent.change(await screen.findByRole('textbox', { name: '工单转发对象' }), { target: { value: '工单' } })
    fireEvent.click(screen.getByRole('button', { name: zh['recipient.search']! }))
    fireEvent.click(await screen.findByRole('button', { name: '工单群 · cidOrders' }))
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 工单插件` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('business-orders', true, { forwardTo: { chatId: 'cidOrders' } }, 'v1'))
    fireEvent.change(screen.getByRole('combobox', { name: zh['recipient.kind']! }), { target: { value: 'user' } })
    fireEvent.change(screen.getByRole('textbox', { name: '工单转发对象' }), { target: { value: '张三' } })
    fireEvent.click(screen.getByRole('button', { name: zh['recipient.search']! }))
    fireEvent.click(await screen.findByRole('button', { name: '张三 · userZ' }))
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 工单插件` }))
    await waitFor(() => expect(api.saveService).toHaveBeenLastCalledWith('business-orders', true, { forwardTo: { userId: 'userZ' } }, 'v2'))
  })

  it('enables a service and saves with the current version', async () => {
    const api = fakeApi(status())
    render(<SettingsPage api={api} t={t} />)
    const toggle = await screen.findByRole('switch', { name: /钉钉/ })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 钉钉` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-dingtalk', true, expect.objectContaining({ identity: 'user' }), 'v1'))
  })

  it('hides fixed DingTalk fields without clearing existing config on save', async () => {
    const s = status()
    s.services[1] = { ...s.services[1]!, enabled: true, phase: 'active', config: { identity: 'user', defaultTarget: { chatId: 'cidLegacy' }, dryRun: true } }
    const api = fakeApi(s)
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByRole('button', { name: `${zh.save} 钉钉` })).toBeTruthy()
    expect(screen.queryByText(/发送身份/)).toBeNull()
    expect(screen.queryByText(/默认群 ID/)).toBeNull()
    expect(screen.queryByText(/只演练不真实发送/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 钉钉` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-dingtalk', true, {
      identity: 'user', defaultTarget: { chatId: 'cidLegacy' }, dryRun: true,
    }, 'v1'))
  })

  it('shows a conflict message and reloads', async () => {
    const api = fakeApi(status())
    api.saveService.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'conflict' }))
    api.status.mockResolvedValueOnce(status()).mockResolvedValueOnce(status({ version: 'v2' }))
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${zh.save} WebSocket` }))
    expect(await screen.findByText(zh.conflict!)).toBeTruthy()
    // 回归测试：冲突后的自动刷新只应更新 status，不应把卡片整体卸载重建（否则 ServiceCard 自己
    // 存的 message 本地 state 会被清空、提示一闪而过——真实 dsh Web 走查中复现过，点击保存后等待
    // 一段时间再读取文案时提示已经消失）。这里显式等到 refreshAfterConflict 的 api.status() 落地
    // （用新的 version 断言），确认提示依然在场。
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2))
    expect(screen.getByText(zh.conflict!)).toBeTruthy()
    // 且下一次保存应带上刷新后拿到的最新 version（而不是发生冲突时那个过期的 version）。
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} WebSocket` }))
    await waitFor(() => expect(api.saveService).toHaveBeenLastCalledWith('agent-kit-ws', true, { pingIntervalMs: 30_000, readTimeoutMs: 75_000 }, 'v2'))
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

  it('switches jev to Laya: shows baseURL / key ref fields and hides the TypeSafe key panel', async () => {
    const api = fakeApi(status())
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByLabelText(zh['jev.key']!)).toBeTruthy()
    expect(screen.queryByLabelText(zh['jev.baseURL']!)).toBeNull()
    fireEvent.change(screen.getByLabelText(zh['jev.provider']!), { target: { value: 'laya' } })
    fireEvent.change(screen.getByLabelText(zh['jev.baseURL']!), { target: { value: 'http://127.0.0.1:18765' } })
    fireEvent.change(screen.getByLabelText(zh['jev.apiKeyRef']!), { target: { value: 'MY_LAYA' } })
    fireEvent.change(screen.getByLabelText(zh['jev.contextTokens']!), { target: { value: '512' } })
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} Jev 判断` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-jev', true, { model: 'jev-latest', provider: 'laya', baseURL: 'http://127.0.0.1:18765', apiKeyRef: 'MY_LAYA', contextTokens: 512 }, 'v1'))
  })

  it('shows the Laya key as a row secret instead of the TypeSafe key panel when saved as laya', async () => {
    const s = status()
    s.services[3] = { ...s.services[3]!, config: { provider: 'laya', baseURL: 'http://127.0.0.1:18765' }, secrets: [{ label: 'Laya API Key', ref: 'LAYA_API_KEY', configured: false }] }
    const api = fakeApi(s)
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByLabelText(zh['jev.baseURL']!)).toBeTruthy()
    expect(screen.queryByLabelText(zh['jev.key']!)).toBeNull()
    expect(screen.getByText(/Laya API Key/)).toBeTruthy()
  })

  it('disables editing when read-only', async () => {
    render(<SettingsPage api={fakeApi(status({ writable: false, readOnlyReason: 'dsh Web 未绑定 127.0.0.1' }))} t={t} />)
    expect(await screen.findByText(/未绑定 127\.0\.0\.1/)).toBeTruthy()
    expect((screen.getByRole('switch', { name: /WebSocket/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('uses the version returned by a completed save for the next save on the same card', async () => {
    const api = fakeApi(status())
    api.saveService.mockResolvedValueOnce({ version: 'v2' }).mockResolvedValueOnce({ version: 'v3' })
    render(<SettingsPage api={api} t={t} />)
    const saveButton = await screen.findByRole('button', { name: `${zh.save} WebSocket` })
    fireEvent.click(saveButton)
    await waitFor(() => expect(api.saveService).toHaveBeenNthCalledWith(1, 'agent-kit-ws', true, { pingIntervalMs: 30_000, readTimeoutMs: 75_000 }, 'v1'))
    await waitFor(() => expect((saveButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(saveButton)
    await waitFor(() => expect(api.saveService).toHaveBeenNthCalledWith(2, 'agent-kit-ws', true, { pingIntervalMs: 30_000, readTimeoutMs: 75_000 }, 'v2'))
  })

  it('does not poll for status after unmount', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApi(status())
      const view = render(<SettingsPage api={api} t={t} />)
      await act(async () => {})
      expect(api.status).toHaveBeenCalledTimes(1)
      const saveButton = screen.getByRole('button', { name: `${zh.save} WebSocket` })
      await act(async () => {
        fireEvent.click(saveButton)
      })
      expect(api.saveService).toHaveBeenCalledTimes(1)
      view.unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      // 卸载前已清理三个刷新定时器，unmount 之后走完全部延时也不应再调用 api.status
      expect(api.status).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // M1 回归测试：清除按钮曾经始终清下拉框里选中的 target，而不是当前 Key 实际所在的来源，
  // 导致例如 Key 实际存在钥匙串里、下拉框还停留在 credentials 时，点击“清除”会去清一个本来就是空的
  // 凭据文件，钥匙串里的 Key 纹丝不动却显示“已清除”。这里验证清除按钮改为按实际来源选择目标。
  it('clears the target matching the actual current source, not the dropdown selection', async () => {
    const api = fakeApi(status({ typesafeKey: { configured: true, source: 'credentials' }, keyTargets: ['keychain', 'credentials'] }))
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['jev.clearKey']! }))
    await waitFor(() => expect(api.clearSecret).toHaveBeenCalledWith('credentials'))
  })

  it('shows a shared-keychain warning before clearing a key stored in the shared keychain service', async () => {
    const api = fakeApi(status({ typesafeKey: { configured: true, source: 'keychain:ai.typesafe.api-key' }, keyTargets: ['keychain', 'credentials'] }))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['jev.clearKey']! }))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('ai.typesafe.api-key'))
    await waitFor(() => expect(api.clearSecret).toHaveBeenCalledWith('keychain'))
    confirmSpy.mockRestore()
  })

  it('does not clear when the shared-keychain warning is declined', async () => {
    const api = fakeApi(status({ typesafeKey: { configured: true, source: 'keychain:ai.typesafe.api-key' }, keyTargets: ['keychain', 'credentials'] }))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['jev.clearKey']! }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(api.clearSecret).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('shows a localized source label instead of the raw keychain:service value', async () => {
    render(<SettingsPage api={fakeApi(status({ typesafeKey: { configured: true, source: 'keychain:ai.typesafe.api-key' } }))} t={t} />)
    expect(await screen.findByText(/来源：钥匙串（ai\.typesafe\.api-key）/)).toBeTruthy()
  })

  it('shows an error like save does when clearing fails', async () => {
    const api = fakeApi(status({ typesafeKey: { configured: true, source: 'credentials' } }))
    api.clearSecret.mockRejectedValueOnce(new Error('boom'))
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['jev.clearKey']! }))
    expect(await screen.findByText(/boom/)).toBeTruthy()
  })
})

describe('createAdminApi', () => {
  it('unwraps remote results and parses server error payloads', async () => {
    const services: Record<string, unknown> = {
      'remote.agentKitAdmin': {
        status: async () => ({ ok: true, value: status() }),
        saveService: async () => ({ ok: false, error: { code: 'gateway/bad-request', message: JSON.stringify({ code: 'conflict', message: '已被修改' }) } }),
      },
    }
    const ctx = { get: (name: string) => services[name] }
    const api = createAdminApi(ctx as never)
    expect((await api.status()).profile).toBe('kit')
    await expect(api.saveService('agent-kit-ws', true, null, 'v1')).rejects.toMatchObject({ code: 'conflict', message: '已被修改' })
  })
})

describe('registered entries (issue #1)', () => {
  const biz = {
    id: 'biz-row',
    title: '业务',
    enabled: true,
    phase: 'failed' as const,
    health: null,
    config: { url: 'wss://a', extra: 1, alertTarget: { chatId: 'cid1' } },
    registered: true as const,
    fields: [
      { path: 'url', label: '上游 URL' },
      { path: 'alertTarget.chatId', label: '告警群' },
      { path: 'batchSize', label: '批大小', kind: 'number' as const },
      { path: 'mode', label: '模式', kind: 'select' as const, options: ['a', 'b'] },
      { path: 'chatIds', label: '群列表', kind: 'list' as const },
      { path: 'dryRun', label: '演练', kind: 'boolean' as const },
    ],
    secrets: [{ label: '上游 Token', ref: 'BIZ_TOKEN', configured: false }],
  }
  const withBiz = (over: Partial<AdminStatus> = {}) => {
    const s = status(over)
    s.services[1] = { ...s.services[1]!, enabled: true, dependents: [{ id: 'biz-row', title: '业务' }] }
    s.services.push(biz)
    s.checks.push({ id: 'biz-row.config', scope: 'biz-row', title: '业务 配置', status: 'fail', detail: 'url: 必须是 wss://' })
    return s
  }

  it('renders a registered row with its fields and checks, and saves nested paths while keeping unlisted keys', async () => {
    const api = fakeApi(withBiz())
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByText(/url: 必须是 wss:\/\//)).toBeTruthy()
    expect(screen.getByText(zh.reloadRegistered!.replace('{title}', '业务'))).toBeTruthy()
    fireEvent.change(screen.getByLabelText('告警群'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('批大小'), { target: { value: '8' } })
    fireEvent.change(screen.getByLabelText('模式'), { target: { value: 'b' } })
    fireEvent.change(screen.getByLabelText('群列表'), { target: { value: 'c1, c2\nc3' } })
    fireEvent.click(screen.getByLabelText('演练'))
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 业务` }))
    await waitFor(() =>
      expect(api.saveService).toHaveBeenCalledWith('biz-row', true, { url: 'wss://a', extra: 1, batchSize: 8, mode: 'b', chatIds: ['c1', 'c2', 'c3'], dryRun: true }, 'v1'),
    )
  })

  it('stores a registered secret by ref without displaying it', async () => {
    const api = fakeApi(withBiz())
    render(<SettingsPage api={api} t={t} />)
    fireEvent.change(await screen.findByLabelText('上游 Token（BIZ_TOKEN）'), { target: { value: 'biz-secret' } })
    fireEvent.click(screen.getByRole('button', { name: `${zh['secrets.save']} 上游 Token` }))
    await waitFor(() => expect(api.setSecret).toHaveBeenCalledWith('credentials', 'biz-secret', 'BIZ_TOKEN'))
    expect(document.body.textContent).not.toContain('biz-secret')
  })

  it('clears a configured registered secret', async () => {
    const s = withBiz()
    ;(s.services.at(-1)!.secrets as { configured: boolean; source?: string }[])[0] = { ...biz.secrets[0]!, configured: true, source: 'credentials' }
    const api = fakeApi(s)
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${zh['secrets.clear']} 上游 Token` }))
    await waitFor(() => expect(api.clearSecret).toHaveBeenCalledWith('credentials', 'BIZ_TOKEN'))
  })

  it('warns before disabling a kit row that registered rows depend on', async () => {
    const api = fakeApi(withBiz())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByText(zh.reloadDependents!.replace('{names}', '业务'))).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: /钉钉/ }))
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 钉钉` }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('业务'))
    expect(api.saveService).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 钉钉` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-dingtalk', false, null, 'v1'))
    confirm.mockRestore()
  })

  it('passes the secret ref through the remote api', async () => {
    const calls: unknown[][] = []
    const ctx = { get: () => ({ setSecret: async (...a: unknown[]) => (calls.push(a), { ok: true, value: { configured: true } }), clearSecret: async (...a: unknown[]) => (calls.push(a), { ok: true, value: { configured: false } }) }) }
    const api = createAdminApi(ctx as never)
    await api.setSecret('credentials', 'v', 'BIZ_TOKEN')
    await api.setSecret('credentials', 'v')
    await api.clearSecret('credentials', 'BIZ_TOKEN')
    expect(calls).toEqual([['credentials', 'v', 'BIZ_TOKEN'], ['credentials', 'v', undefined], ['credentials', 'BIZ_TOKEN']])
  })
})

describe('AGENT_KIT_REMOTE descriptors (issue #3)', () => {
  it('satisfy both the dsh 0.1.5 gateway client and the 0.1.7 typert registry', () => {
    for (const d of AGENT_KIT_REMOTE.descriptors) {
      // 0.1.7 的 typert 注册表：结果 codec 为 src-json 或带 create() 的 strict codec
      expect(d.result.mode).toBe('src-json')
      for (const p of d.parameters) {
        const codec = p.codec as { mode: string; typeSymbol: string; schema: { parse(v: unknown): unknown }; create(): { parse(v: unknown): unknown } }
        expect(codec.mode).toBe('strict')
        expect(codec.typeSymbol).toBe(`@baoyx/dsh-agent-kit-admin#agentKitAdmin/${d.method}:${p.name}`)
        // 0.1.5：codec.schema.parse；0.1.7：codec.create().parse
        expect(codec.schema.parse({ a: 1 })).toEqual({ a: 1 })
        expect(codec.create().parse('x')).toBe('x')
      }
    }
    expect(AGENT_KIT_REMOTE.descriptors.map((d) => [d.method, d.parameters.map((p) => p.wire)])).toEqual([
      ['status', []],
      ['saveService', ['id', 'enabled', 'config', 'expectedVersion']],
      ['setSecret', ['target', 'value', 'ref']],
      ['clearSecret', ['target', 'ref']], ['dingtalkAuth', []], ['dingtalkUnmatched', []], ['dingtalkSearchRecipients', ['kind', 'query']], ['dingtalkLogin', []], ['dingtalkLoginCancel', []], ['dingtalkLogout', []],
    ])
  })
})

describe('English UI (issue #4)', () => {
  const tEn = (k: string, vars?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => String(vars?.[n] ?? ''))

  it('renders kit card titles and labels in English, keeping registered labels as given', async () => {
    const s = status()
    s.services[1] = { ...s.services[1]!, enabled: true, dependents: [{ id: 'biz-row', title: 'Biz' }, { id: 'other', title: 'Other' }] }
    s.services.push({ id: 'biz-row', title: 'Biz', enabled: false, phase: null, health: null, config: undefined, registered: true, fields: [], secrets: [] })
    render(<SettingsPage api={fakeApi(s)} t={tEn} />)
    expect(await screen.findByRole('heading', { name: 'Agent Kit settings' })).toBeTruthy()
    for (const title of ['WebSocket', 'DingTalk', 'Agent tasks', 'Jev judge', 'Biz']) expect(screen.getByRole('region', { name: title })).toBeTruthy()
    expect(screen.getByText(en.reloadDependents!.replace('{names}', 'Biz, Other'))).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save DingTalk' })).toBeTruthy()
    expect(screen.queryByText(/Sender identity|Default group ID|Dry run/)).toBeNull()
    // 除了服务端生成的检查文案（issue #4 已注明），页面上没有中文
    expect(screen.getByText(/^TypeSafe Key: 没有找到/)).toBeTruthy()
    const text = document.body.textContent!.replace(/没有找到|设置 Key/g, '')
    expect(text).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/)
  })
})

describe('DingTalk sign-in panel', () => {
  const withDingtalk = () =>
    status({
      services: [{ id: 'agent-kit-dingtalk', title: '钉钉', enabled: true, phase: 'active', health: { status: 'ok', detail: 'ok' }, config: { identity: 'user' } }],
      checks: [],
    })

  it('shows the signed-in account and signs out after confirmation', async () => {
    const api = fakeApi(withDingtalk())
    api.dingtalkAuth = vi.fn(async () => ({ installed: true, authenticated: true, user: '张三', corp: '示例公司', expiresAt: '2026-09-24T21:30:00+08:00', refreshExpiresAt: '2026-10-24T19:30:00+08:00' }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByText(/张三 @ 示例公司 · 登录有效至 10-24 \d\d:30（访问凭证每 2 小时自动续期）/)).toBeTruthy()
    expect(screen.getByText(zh['dingtalk.auth.signedIn']!)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['dingtalk.auth.relogin']! })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['dingtalk.auth.logout']! }))
    await waitFor(() => expect(api.dingtalkLogout).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('starts a device login, shows the code and link, and polls until signed in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = fakeApi(withDingtalk())
    let signedIn = false
    let started = false
    api.dingtalkLogin = vi.fn(async () => (started = true, { state: 'waiting' as const, code: 'ABCD-EFGH', url: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=ABCD-EFGH' }))
    api.dingtalkAuth = vi.fn(async () =>
      signedIn
        ? { installed: true, authenticated: true, user: '张三', login: { state: 'succeeded' as const } }
        : started
          ? { installed: true, authenticated: false, login: { state: 'waiting' as const, code: 'ABCD-EFGH', url: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=ABCD-EFGH' } }
          : { installed: true, authenticated: false })
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['dingtalk.auth.login']! }))
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    expect((screen.getByRole('link', { name: zh['dingtalk.auth.open']! }) as HTMLAnchorElement).href).toContain('user_code=ABCD-EFGH')
    const qr = await screen.findByRole('img', { name: zh['dingtalk.auth.qr']! }) as HTMLImageElement
    expect(qr.src).toMatch(/^data:image\/svg\+xml,/)
    signedIn = true
    await act(async () => { await vi.advanceTimersByTimeAsync(3500) })
    expect(await screen.findByText(zh['dingtalk.auth.signedIn']!)).toBeTruthy()
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
    vi.useRealTimers()
  })

  it('warns and offers sign-in when the login expires within 3 days', async () => {
    const api = fakeApi(withDingtalk())
    const soon = new Date(Date.now() + 2 * 24 * 3600_000).toISOString()
    api.dingtalkAuth = vi.fn(async () => ({ installed: true, authenticated: true, user: '张三', expiresAt: new Date().toISOString(), refreshExpiresAt: soon }))
    render(<SettingsPage api={api} t={t} />)
    expect(await screen.findByText(zh['dingtalk.auth.expiring']!)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['dingtalk.auth.relogin']! })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh['dingtalk.auth.logout']! })).toBeTruthy()
  })

})
