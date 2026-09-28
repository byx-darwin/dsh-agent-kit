import { useState, type ReactNode } from 'react'
import type { AdminApi, DingtalkRecipientSearchResult, EntryField, KitId } from './remote.js'

export type T = (key: string, vars?: Record<string, string | number>) => string
type Config = Record<string, unknown>
export interface FormProps {
  config: Config
  onChange(next: Config): void
  disabled: boolean
  t: T
  api?: AdminApi
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

function AgentTasksForm(p: FormProps) {
  return text(p, 'workspaceDir', p.t('agentTasks.workspaceDir'))
}

function WsForm(p: FormProps) {
  return (
    <>
      {text(p, 'pingIntervalMs', p.t('ws.pingIntervalMs'), 'number')}
      {text(p, 'readTimeoutMs', p.t('ws.readTimeoutMs'), 'number')}
    </>
  )
}

/** Jev 与本地 Laya 二选一：选 laya 时填写服务地址与 Key 的 ref，TypeSafe Key 不再使用。 */
function JevForm(p: FormProps) {
  const provider = (p.config.provider as string | undefined) ?? 'typesafe'
  return (
    <>
      <Field label={p.t('jev.provider')}>
        {(id) => (
          <select id={id} disabled={p.disabled} value={provider} onChange={(e) => p.onChange({ ...p.config, provider: e.target.value })}>
            <option value="typesafe">{p.t('jev.provider.typesafe')}</option>
            <option value="laya">{p.t('jev.provider.laya')}</option>
          </select>
        )}
      </Field>
      {provider === 'laya' && text(p, 'baseURL', p.t('jev.baseURL'))}
      {provider === 'laya' && text(p, 'apiKeyRef', p.t('jev.apiKeyRef'))}
      {provider === 'laya' && text(p, 'contextTokens', p.t('jev.contextTokens'), 'number')}
      {text(p, 'model', p.t('jev.model'))}
    </>
  )
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
    case 'dingtalk-target':
      return <DingtalkTargetInput id={id} value={value} onChange={set} disabled={p.disabled} api={p.api} t={p.t} />
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

function DingtalkTargetInput({ id, value, onChange, disabled, api, t }: {
  id: string
  value: unknown
  onChange(value: unknown): void
  disabled: boolean
  api?: AdminApi
  t: T
}) {
  const current = value && typeof value === 'object' && !Array.isArray(value) ? value as Config : {}
  const [kind, setKind] = useState<'group' | 'user'>(current.userId || current.openDingtalkId ? 'user' : 'group')
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<DingtalkRecipientSearchResult>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const selected = current.chatId ?? current.userId ?? current.openDingtalkId ?? (Array.isArray(current.chatIds) ? current.chatIds.join(', ') : undefined)
  const search = async () => {
    if (!api || query.trim().length < 2) return
    setLoading(true)
    setError(undefined)
    setResult(undefined)
    try {
      setResult(await api.dingtalkSearchRecipients(kind, query.trim()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="agent-kit-target-picker">
      <select aria-label={t('recipient.kind')} value={kind} disabled={disabled} onChange={(e) => { setKind(e.target.value as 'group' | 'user'); setQuery(''); setResult(undefined) }}>
        <option value="group">{t('recipient.group')}</option>
        <option value="user">{t('recipient.user')}</option>
      </select>
      <div className="agent-kit-target-search">
        <input id={id} value={query} disabled={disabled} placeholder={kind === 'group' ? t('recipient.groupQuery') : t('recipient.userQuery')} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="agent-kit-btn" disabled={disabled || loading || !api || query.trim().length < 2} onClick={() => void search()}>{t('recipient.search')}</button>
      </div>
      {selected && <div className="agent-kit-hint">{t('recipient.selected')}（{current.chatId || current.chatIds ? t('recipient.group') : t('recipient.user')}）: <code>{String(selected)}</code> <button type="button" className="agent-kit-btn" disabled={disabled} onClick={() => onChange(undefined)}>{t('recipient.clear')}</button></div>}
      {result && <div className="agent-kit-route-suggestions">
        {result.candidates.length === 0 && <p className="agent-kit-hint">{t('recipient.empty')}</p>}
        {result.candidates.map((candidate) => {
          const candidateId = Object.values(candidate.target)[0]!
          return <button type="button" className="agent-kit-btn" key={candidateId} disabled={disabled} onClick={() => onChange(candidate.target)}>{candidate.name} · {candidateId}</button>
        })}
        {!result.complete && <p className="agent-kit-hint">{t('recipient.incomplete')}</p>}
      </div>}
      {error && <p role="alert">{error}</p>}
    </div>
  )
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

export const FORMS: Partial<Record<KitId, (p: FormProps) => ReactNode>> = {
  'agent-kit-ws': WsForm,
  'agent-kit-agent-tasks': AgentTasksForm,
  'agent-kit-jev': JevForm,
}
