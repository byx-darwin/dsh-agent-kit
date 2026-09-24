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

export function createAdminApi(remote: ClientContext['remote']): AdminApi {
  const svc = remote.agentKitAdmin as Record<string, (...args: unknown[]) => Promise<RemoteResult<never>>>
  return {
    status: () => unwrap(svc.status!()),
    saveService: (id, enabled, config, expectedVersion) => unwrap(svc.saveService!(id, enabled, config, expectedVersion)),
    setSecret: (target, value) => unwrap(svc.setSecret!(target, value)),
    clearSecret: (target) => unwrap(svc.clearSecret!(target)),
  }
}
