import { AgentTasksConfig } from '@mc/dsh-agent-kit/agent-tasks'
import { DingtalkConfig } from '@mc/dsh-agent-kit/dingtalk'
import { FeishuConfig } from '@mc/dsh-agent-kit/feishu'
import { NotifyConfig, assertNotifyConfig } from '@mc/dsh-agent-kit/notify'
import type { ServiceName } from '@mc/dsh-agent-kit'
import { JevConfig } from '@mc/dsh-agent-kit/jev'
import { WsConfig, assertWsConfig } from '@mc/dsh-agent-kit/ws'

export type KitId = 'agent-kit-ws' | 'agent-kit-dingtalk' | 'agent-kit-feishu' | 'agent-kit-notify' | 'agent-kit-agent-tasks' | 'agent-kit-jev'
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

/** 与 DingtalkService 构造函数一致的身份组合校验（不依赖环境变量与 dws）。 */
function validateDingtalk(config: { identity: string; robotCode?: string; webhookTokenEnv?: string; defaultTarget?: unknown }): void {
  const fail = (field: string, message: string) => {
    throw Object.assign(new Error(message), { details: { field } })
  }
  if (config.identity === 'bot' && !config.robotCode) fail('robotCode', 'bot 身份必须填写 robotCode')
  if (config.identity === 'webhook' && !config.webhookTokenEnv) fail('webhookTokenEnv', 'webhook 身份必须填写 webhookTokenEnv')
  if (config.identity === 'webhook' && config.defaultTarget) fail('defaultTarget', 'webhook 身份不能设置 defaultTarget')
}

export const KIT_ENTRIES: readonly KitEntryMeta[] = [
  { id: 'agent-kit-ws', service: 'agentWs', module: '@mc/dsh-agent-kit/ws', title: 'WebSocket', validate: validator(WsConfig as unknown as Schema, assertWsConfig) },
  { id: 'agent-kit-dingtalk', service: 'dingtalk', module: '@mc/dsh-agent-kit/dingtalk', title: '钉钉', validate: validator(DingtalkConfig as unknown as Schema, validateDingtalk) },
  { id: 'agent-kit-feishu', service: 'feishu', module: '@mc/dsh-agent-kit/feishu', title: '飞书', validate: validator(FeishuConfig as unknown as Schema) },
  { id: 'agent-kit-notify', service: 'notify', module: '@mc/dsh-agent-kit/notify', title: '通知渠道', validate: validator(NotifyConfig as unknown as Schema, assertNotifyConfig) },
  { id: 'agent-kit-agent-tasks', service: 'agentTasks', module: '@mc/dsh-agent-kit/agent-tasks', title: 'Agent 任务', validate: validator(AgentTasksConfig as unknown as Schema) },
  { id: 'agent-kit-jev', service: 'jev', module: '@mc/dsh-agent-kit/jev', title: 'Jev 判断', validate: validator(JevConfig as unknown as Schema) },
]

export function kitEntry(id: KitId): KitEntryMeta {
  return KIT_ENTRIES.find((e) => e.id === id)!
}
