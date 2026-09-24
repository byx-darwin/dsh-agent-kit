import type { ClientContext, RemoteResult } from './host-types.js'

export type KitId = 'agent-kit-ws' | 'agent-kit-dingtalk' | 'agent-kit-agent-tasks' | 'agent-kit-jev'
export type KeyTarget = 'keychain' | 'credentials'
export interface CheckResult {
  id: string
  scope: string
  title: string
  status: 'pass' | 'warn' | 'fail' | 'skip'
  detail: string
  fix?: string
}
export interface AdminStatus {
  profile: string
  patchReload: 'live' | 'startup'
  version: string
  writable: boolean
  readOnlyReason?: string
  services: Array<{
    id: KitId
    title: string
    enabled: boolean
    phase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
    health: { status: 'ok' | 'degraded' | 'failed'; detail: string } | null
    config: Record<string, unknown> | undefined
  }>
  checks: CheckResult[]
  typesafeKey: { configured: boolean; source?: string }
  keyTargets: KeyTarget[]
}
export interface AdminApi {
  status(): Promise<AdminStatus>
  saveService(id: KitId, enabled: boolean, config: Record<string, unknown> | null, expectedVersion: string): Promise<{ version: string }>
  setSecret(target: KeyTarget, value: string): Promise<{ configured: boolean; source?: string }>
  clearSecret(target: KeyTarget): Promise<{ configured: boolean; source?: string }>
}
export class AdminError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message)
  }
}

const PKG = '@mc/dsh-agent-kit'
const json = { mode: 'strict', typeSymbol: `${PKG}#json`, schema: { parse: (v: unknown) => v } }
const method = (name: string, params: string[]) => ({
  id: `${PKG}#agentKitAdmin/${name}`,
  service: 'agentKitAdmin',
  namespace: 'agentKitAdmin',
  method: name,
  invocation: { kind: 'direct' },
  parameters: params.map((p) => ({ name: p, wire: p, source: 'json', codec: { ...json, typeSymbol: `${PKG}#agentKitAdmin/${name}:${p}` } })),
  result: { mode: 'src-json' },
})

/** 手写的远程接口描述（对应服务端 SRC 模式的 AgentKitAdmin）。 */
export const AGENT_KIT_REMOTE = {
  package: PKG,
  descriptors: [
    method('status', []),
    method('saveService', ['id', 'enabled', 'config', 'expectedVersion']),
    method('setSecret', ['target', 'value']),
    method('clearSecret', ['target']),
  ],
}

async function unwrap<T>(p: Promise<RemoteResult<T>>): Promise<T> {
  const r = await p
  if (r.ok) return r.value as T
  let payload: { code?: string; message?: string; errors?: { path: string; message: string }[] } = {}
  try {
    payload = JSON.parse(r.error?.message ?? '')
  } catch {
    payload = { code: r.error?.code, message: r.error?.message }
  }
  throw new AdminError(payload.code ?? 'unknown', payload.message ?? 'request failed', payload.errors)
}

/**
 * `remote.$mount(AGENT_KIT_REMOTE)` 挂载的命名空间会被 cordis 注册成挂在**根 ctx** 上、名字里带点的
 * 服务 `remote.agentKitAdmin`（`RemoteNamespaceService` 构造时 `super(ctx, \`remote.${namespace}\`)`
 * 传给根 ctx，不是 `remote` 这个 Service 对象的嵌套属性）。
 *
 * 取用时不能用属性访问（`ctx.remote.agentKitAdmin` 或 `ctx['remote.agentKitAdmin']`）——cordis 的 Context
 * 代理会对属性读取做网关检查：只有在插件的静态 `inject` 数组里声明过的服务名才允许属性访问，否则会抛
 * `cannot get property "remote.agentKitAdmin" without inject`（在真实 dsh Web 走查中复现过）。而
 * `agentKitAdmin` 这个服务本来就要等我们自己调用的 `$mount()` resolve 之后才存在，不能预先声明进
 * `inject`（那样 `apply()` 会因为等不到它而永远不执行，`$mount()` 也就永远不会被调用——是个死锁，
 * 同样在走查中复现过）。`dsh-api-gateway` 自身在同样场景下用的是 cordis 提供的、不抛异常的
 * `ctx.get(name)`（如 `this.ownerCtx.get(serviceKey)` / `ctx.get('connection')`），未挂载时只返回
 * `undefined`。所以这里必须用 `ctx.get('remote.agentKitAdmin')`，且必须在每次方法调用时才读取
 * （而不是在 `createAdminApi` 执行的当下、mount 还没完成时）——否则闭包会一直捕获尚未挂载时读到的
 * `undefined`，之后无论等多久调用都会抛出 `Cannot read properties of undefined (reading 'status')`
 * （同样在走查中复现过）。
 */
export function createAdminApi(ctx: ClientContext): AdminApi {
  const svc = () => ctx.get('remote.agentKitAdmin') as Record<string, (...args: unknown[]) => Promise<RemoteResult<never>>>
  return {
    status: () => unwrap(svc().status!()),
    saveService: (id, enabled, config, expectedVersion) => unwrap(svc().saveService!(id, enabled, config, expectedVersion)),
    setSecret: (target, value) => unwrap(svc().setSecret!(target, value)),
    clearSecret: (target) => unwrap(svc().clearSecret!(target)),
  }
}
