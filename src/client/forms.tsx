import { useState, type ReactNode } from 'react'
import type { KitId } from './remote.js'

export type T = (key: string, vars?: Record<string, string | number>) => string
type Config = Record<string, unknown>
export interface FormProps {
  config: Config
  onChange(next: Config): void
  disabled: boolean
  t: T
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const [id] = useState(() => `akf-${Math.random().toString(36).slice(2)}`)
  return (
    <div className="agent-kit-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  )
}

const text = (props: FormProps, key: string, label: string, type: 'text' | 'number' = 'text') => (
  <Field label={label}>
    {(id) => (
      <input
        id={id}
        type={type}
        disabled={props.disabled}
        value={(props.config[key] as string | number | undefined) ?? ''}
        onChange={(e) => props.onChange({ ...props.config, [key]: type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value || undefined })}
      />
    )}
  </Field>
)

function DingtalkForm(p: FormProps) {
  const target = (p.config.defaultTarget as { chatId?: string } | undefined)?.chatId ?? ''
  return (
    <>
      <Field label={p.t('dingtalk.identity')}>
        {(id) => (
          <select id={id} disabled={p.disabled} value={(p.config.identity as string) ?? ''} onChange={(e) => p.onChange({ ...p.config, identity: e.target.value })}>
            <option value="" disabled>—</option>
            <option value="bot">bot</option>
            <option value="user">user</option>
            <option value="webhook">webhook</option>
          </select>
        )}
      </Field>
      {p.config.identity === 'bot' && text(p, 'robotCode', p.t('dingtalk.robotCode'))}
      {p.config.identity === 'webhook' && text(p, 'webhookTokenEnv', p.t('dingtalk.webhookTokenEnv'))}
      {p.config.identity !== 'webhook' && (
        <Field label={p.t('dingtalk.targetChatId')}>
          {(id) => (
            <input id={id} disabled={p.disabled} value={target} onChange={(e) => p.onChange({ ...p.config, defaultTarget: e.target.value ? { chatId: e.target.value } : undefined })} />
          )}
        </Field>
      )}
      <Field label={p.t('dingtalk.dryRun')}>
        {(id) => <input id={id} type="checkbox" disabled={p.disabled} checked={p.config.dryRun === true} onChange={(e) => p.onChange({ ...p.config, dryRun: e.target.checked })} />}
      </Field>
    </>
  )
}

function AgentTasksForm(p: FormProps) {
  const declared = (p.config.declaredPermissions as Record<string, string> | undefined) ?? {}
  return (
    <>
      {text(p, 'workspaceDir', p.t('agentTasks.workspaceDir'))}
      {['claude-code', 'codex'].map((provider) => (
        <Field key={provider} label={p.t('agentTasks.permission', { provider })}>
          {(id) => (
            <select
              id={id}
              disabled={p.disabled}
              value={declared[provider] ?? ''}
              onChange={(e) => {
                const next = { ...declared }
                if (e.target.value) next[provider] = e.target.value
                else delete next[provider]
                p.onChange({ ...p.config, declaredPermissions: next })
              }}
            >
              <option value="">{p.t('agentTasks.permissionNone')}</option>
              <option value="read-only">read-only</option>
              <option value="workspace-write">workspace-write</option>
            </select>
          )}
        </Field>
      ))}
    </>
  )
}

function WsForm(p: FormProps) {
  return (
    <>
      {text(p, 'pingIntervalMs', p.t('ws.pingIntervalMs'), 'number')}
      {text(p, 'readTimeoutMs', p.t('ws.readTimeoutMs'), 'number')}
    </>
  )
}

function JevForm(p: FormProps) {
  return <>{text(p, 'model', p.t('jev.model'))}</>
}

export const FORMS: Record<KitId, (p: FormProps) => ReactNode> = {
  'agent-kit-ws': WsForm,
  'agent-kit-dingtalk': DingtalkForm,
  'agent-kit-agent-tasks': AgentTasksForm,
  'agent-kit-jev': JevForm,
}
