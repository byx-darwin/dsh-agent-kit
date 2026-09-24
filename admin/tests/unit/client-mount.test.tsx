// @vitest-environment jsdom
import type { ComponentType } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/client/index.js'
import type { ClientContext } from '../../src/client/host-types.js'
import type { AdminStatus } from '../../src/client/remote.js'

afterEach(cleanup)

function statusFixture(): AdminStatus {
  return {
    profile: 'kit',
    patchReload: 'live',
    version: 'v1',
    writable: true,
    services: [
      { id: 'agent-kit-ws', title: 'WebSocket', enabled: false, phase: null, health: null, config: undefined },
      { id: 'agent-kit-dingtalk', title: '钉钉', enabled: false, phase: null, health: null, config: undefined },
      { id: 'agent-kit-agent-tasks', title: 'Agent 任务', enabled: false, phase: null, health: null, config: undefined },
      { id: 'agent-kit-jev', title: 'Jev 判断', enabled: false, phase: null, health: null, config: undefined },
    ],
    checks: [],
    typesafeKey: { configured: false },
    keyTargets: ['credentials'],
  }
}

/**
 * 回归测试：真实 dsh 宿主里，`remote.$mount(AGENT_KIT_REMOTE)` 挂载的命名空间会被 cordis 注册成挂在
 * **根 ctx** 上、名字里带点的服务 `remote.agentKitAdmin`（`RemoteNamespaceService` 构造时
 * `super(ctx, 'remote.agentKitAdmin')` 传的是根 ctx，不是 `remote` 这个 Service 对象的嵌套属性），
 * 且只有在 `$mount()` 的 promise resolve 之后才会被装上去——mount 完成前用 `ctx.get()` 读到的是
 * `undefined`。`apply()` 在 mount 尚未完成时就同步调用 `createAdminApi(ctx)`；如果 `createAdminApi`
 * 在这一刻就把 `ctx.get('remote.agentKitAdmin')` 取出来存进闭包，就会永远捕获到 `undefined`——即便
 * 后续用 `await ready` 等到了 mount 完成，实际调用的还是那个过期的 `undefined`，表现为设置页一直显示
 * 「加载失败：Cannot read properties of undefined (reading 'status')」（在真实 dsh Web 走查中复现过）。
 * 另外，误用属性访问（`ctx.remote.agentKitAdmin` 或 `ctx['remote.agentKitAdmin']`）在真实宿主里会命中
 * cordis 的属性代理网关（要求服务名先声明进插件的静态 `inject`，而 `agentKitAdmin` 本来就要等我们自己
 * `$mount()` 之后才存在，声明进 `inject` 会死锁），报 `cannot get property "remote.agentKitAdmin"
 * without inject`（同样在真实 dsh Web 走查中复现过）。必须改用 cordis 提供的、不抛异常的
 * `ctx.get(name)`。这里模拟同样的时序和挂载位置，确保 mount 完成后页面能正常加载。
 */
describe('client apply() + $mount timing', () => {
  it('loads the settings page after $mount resolves later than createAdminApi runs', async () => {
    let registeredPage: ComponentType<Record<string, never>> | undefined
    const captureComponent = <P,>(component: ComponentType<P>) => {
      registeredPage = component as unknown as ComponentType<Record<string, never>>
    }
    const services: Record<string, unknown> = {}
    const ctx: ClientContext = {
      get: (name) => services[name],
      effect: (execute) => execute(),
      locale: {
        register: () => () => {},
        bind: () => (key: string) => key,
      },
      slots: {
        inject: (_key, register) => void register(),
        register: (_options, component) => {
          captureComponent(component)
          return () => {}
        },
      },
      remote: {
        $host: { isLoopback: true },
        $mount: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              // cordis 在 mount 完成时才把命名空间服务装到根 ctx 上（带点的服务名），
              // 而不是挂到 remote 对象的属性上 —— 早于这一刻用 ctx.get() 读取只能读到 undefined。
              services['remote.agentKitAdmin'] = {
                status: async () => ({ ok: true, value: statusFixture() }),
              }
              resolve(() => {})
            }, 0)
          }),
      },
    }

    apply(ctx)
    expect(registeredPage).toBeTruthy()
    const Page = registeredPage!
    render(<Page />)

    expect(await screen.findByText('WebSocket')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(/Cannot read properties of undefined/)).toBeNull())
  })
})
