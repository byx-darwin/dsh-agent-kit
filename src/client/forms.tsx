import { useState, type ReactNode } from 'react'
import type { EntryField, KitId } from './remote.js'

export type T = (key: string, vars?: Record<string, string | number>) => string
type Config = Record<string, unknown>
export interface FormProps {
  config: Config
  onChange(next: Config): void
  disabled: boolean
  t: T
}

function Field({ label, help, children }: { label: string; help?: string; children: (id: string) => ReactNode }) {
  const [id] = useState(() => `akf-${Math.random().toString(36).slice(2)}`)
  return (
    <div className="agent-kit-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {help && <small>{help}</small>}
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

function FeishuForm(p: FormProps) {
  const target = p.config.defaultTarget as { chatId?: string; userId?: string } | undefined
  const kind = target?.userId !== undefined ? 'userId' : 'chatId'
  return (
    <>
      <Field label={p.t('feishu.identity')}>
        {(id) => (
          <select id={id} disabled={p.disabled} value={(p.config.identity as string) ?? ''} onChange={(e) => p.onChange({ ...p.config, identity: e.target.value })}>
            <option value="" disabled>—</option>
            <option value="bot">bot</option>
            <option value="user">user</option>
          </select>
        )}
      </Field>
      <Field label={p.t('feishu.targetKind')}>
        {(id) => (
          <select
            id={id}
            disabled={p.disabled}
            value={kind}
            onChange={(e) => {
              const value = target?.chatId ?? target?.userId
              p.onChange({ ...p.config, defaultTarget: value ? { [e.target.value]: value } : undefined })
            }}
          >
            <option value="chatId">{p.t('feishu.targetChat')}</option>
            <option value="userId">{p.t('feishu.targetUser')}</option>
          </select>
        )}
      </Field>
      <Field label={p.t(kind === 'userId' ? 'feishu.targetUserId' : 'feishu.targetChatId')}>
        {(id) => (
          <input
            id={id}
            disabled={p.disabled}
            value={target?.[kind] ?? ''}
            onChange={(e) => p.onChange({ ...p.config, defaultTarget: e.target.value ? { [kind]: e.target.value } : undefined })}
          />
        )}
      </Field>
      {text(p, 'profile', p.t('feishu.profile'))}
      <Field label={p.t('feishu.dryRun')}>
        {(id) => <input id={id} type="checkbox" disabled={p.disabled} checked={p.config.dryRun === true} onChange={(e) => p.onChange({ ...p.config, dryRun: e.target.checked })} />}
      </Field>
    </>
  )
}

const CHANNELS = ['dingtalk', 'feishu'] as const

/** 通知渠道：勾选发往哪些渠道、选择发送策略。保存后业务包的 ctx.notify 立即改发新渠道，业务插件不重新加载。 */
function NotifyForm(p: FormProps) {
  const channels = (p.config.channels as string[] | undefined) ?? []
  const toggle = (channel: string, on: boolean) => {
    const next = on ? [...channels, channel] : channels.filter((c) => c !== channel)
    p.onChange({ ...p.config, channels: next })
  }
  const move = (channel: string) => p.onChange({ ...p.config, channels: [channel, ...channels.filter((c) => c !== channel)] })
  return (
    <>
      {CHANNELS.map((channel) => (
        <Field key={channel} label={p.t(`notify.channel.${channel}`)}>
          {(id) => <input id={id} type="checkbox" disabled={p.disabled} checked={channels.includes(channel)} onChange={(e) => toggle(channel, e.target.checked)} />}
        </Field>
      ))}
      <Field label={p.t('notify.strategy')}>
        {(id) => (
          <select id={id} disabled={p.disabled} value={(p.config.strategy as string) ?? 'all'} onChange={(e) => p.onChange({ ...p.config, strategy: e.target.value })}>
            <option value="all">{p.t('notify.strategy.all')}</option>
            <option value="failover">{p.t('notify.strategy.failover')}</option>
          </select>
        )}
      </Field>
      {p.config.strategy === 'failover' && channels.length > 1 && (
        <Field label={p.t('notify.first')}>
          {(id) => (
            <select id={id} disabled={p.disabled} value={channels[0]} onChange={(e) => move(e.target.value)}>
              {channels.map((c) => (
                <option key={c} value={c}>{p.t(`notify.name.${c}`)}</option>
              ))}
            </select>
          )}
        </Field>
      )}
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

function getPath(config: Config, path: string): unknown {
  let cur: unknown = config
  for (const key of path.split('.')) cur = cur && typeof cur === 'object' ? (cur as Config)[key] : undefined
  return cur
}

/** 按点分路径写入，返回新对象；值为 undefined 时删除该键，并去掉因此变空的中间对象。 */
export function setPath(config: Config, path: string, value: unknown): Config {
  const [head, ...rest] = path.split('.') as [string, ...string[]]
  const next = { ...config }
  const child = rest.length ? setPath((config[head] as Config | undefined) ?? {}, rest.join('.'), value) : value
  if (child === undefined || (rest.length && Object.keys(child as Config).length === 0)) delete next[head]
  else next[head] = child
  return next
}

function EntryInput({ field, p, id }: { field: EntryField; p: FormProps; id: string }) {
  const value = getPath(p.config, field.path)
  const set = (v: unknown) => p.onChange(setPath(p.config, field.path, v))
  switch (field.kind ?? 'text') {
    case 'boolean':
      return <input id={id} type="checkbox" disabled={p.disabled} checked={value === true} onChange={(e) => set(e.target.checked)} />
    case 'number':
      return <input id={id} type="number" disabled={p.disabled} placeholder={field.placeholder} value={(value as number | undefined) ?? ''} onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))} />
    case 'select':
      return (
        <select id={id} disabled={p.disabled} value={(value as string | undefined) ?? ''} onChange={(e) => set(e.target.value || undefined)}>
          <option value="">—</option>
          {field.options?.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      )
    case 'list':
      return (
        <textarea
          id={id}
          disabled={p.disabled}
          placeholder={field.placeholder}
          value={Array.isArray(value) ? value.join('\n') : ''}
          onChange={(e) => {
            const items = e.target.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
            set(items.length ? items : undefined)
          }}
        />
      )
    default:
      return <input id={id} disabled={p.disabled} placeholder={field.placeholder} value={(value as string | undefined) ?? ''} onChange={(e) => set(e.target.value || undefined)} />
  }
}

/** 业务包登记的行（issue #1）：按登记的 `fields` 渲染表单，未列出的配置项原样保留。 */
export function EntryForm(p: FormProps & { fields: readonly EntryField[] }) {
  return (
    <>
      {p.fields.map((field) => (
        <Field key={field.path} label={field.label} help={field.help}>
          {(id) => <EntryInput field={field} p={p} id={id} />}
        </Field>
      ))}
    </>
  )
}

export const FORMS: Record<KitId, (p: FormProps) => ReactNode> = {
  'agent-kit-ws': WsForm,
  'agent-kit-dingtalk': DingtalkForm,
  'agent-kit-feishu': FeishuForm,
  'agent-kit-notify': NotifyForm,
  'agent-kit-agent-tasks': AgentTasksForm,
  'agent-kit-jev': JevForm,
}
