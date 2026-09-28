import { AgentTasksConfig } from '@mc/dsh-agent-kit/agent-tasks'
import { DingtalkConfig } from '@mc/dsh-agent-kit/dingtalk'
import { NotifyConfig } from '@mc/dsh-agent-kit/notify'
import type { ServiceName } from '@mc/dsh-agent-kit'
import { JevConfig } from '@mc/dsh-agent-kit/jev'
import { WsConfig, assertWsConfig } from '@mc/dsh-agent-kit/ws'

export type KitId = 'agent-kit-ws' | 'agent-kit-dingtalk' | 'agent-kit-notify' | 'agent-kit-agent-tasks' | 'agent-kit-jev'
export interface FieldError {
  path: string
  message: string
}
export type ValidateResult = { ok: true; value: unknown } | { ok: false; errors: FieldError[] }

export interface KitEntryMeta {
  id: KitId
  service: ServiceName
  module: string
  title: string
  validate(config: unknown): ValidateResult
}

type Schema = (value: unknown) => unknown

function validator(schema: Schema, extra?: (value: never) => void): (config: unknown) => ValidateResult {
  return (config) => {
    let value: unknown
    try {
      value = schema(config ?? {})
    } catch (e) {
      // schemastery 的错误信息形如 "$.a.b expected ..."
      const message = (e as Error).message
      const path = /\$\.([\w.[\]-]+)/.exec(message)?.[1] ?? ''
      return { ok: false, errors: [{ path, message }] }
    }
    try {
      extra?.(value as never)
    } catch (e) {
      const field = (e as { details?: { field?: string } }).details?.field ?? ''
      return { ok: false, errors: [{ path: field, message: (e as Error).message }] }
    }
    return { ok: true, value }
  }
}

export const KIT_ENTRIES: readonly KitEntryMeta[] = [
  { id: 'agent-kit-ws', service: 'agentWs', module: '@mc/dsh-agent-kit/ws', title: 'WebSocket', validate: validator(WsConfig as unknown as Schema, assertWsConfig) },
  { id: 'agent-kit-dingtalk', service: 'dingtalk', module: '@mc/dsh-agent-kit/dingtalk', title: '钉钉', validate: validator(DingtalkConfig as unknown as Schema) },
  { id: 'agent-kit-notify', service: 'notify', module: '@mc/dsh-agent-kit/notify', title: '通知渠道', validate: validator(NotifyConfig as unknown as Schema) },
  { id: 'agent-kit-agent-tasks', service: 'agentTasks', module: '@mc/dsh-agent-kit/agent-tasks', title: 'Agent 任务', validate: validator(AgentTasksConfig as unknown as Schema) },
  { id: 'agent-kit-jev', service: 'jev', module: '@mc/dsh-agent-kit/jev', title: 'Jev 判断', validate: validator(JevConfig as unknown as Schema) },
]

export function kitEntry(id: KitId): KitEntryMeta {
  return KIT_ENTRIES.find((e) => e.id === id)!
}
