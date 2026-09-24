import { useState, type ReactNode } from 'react'
import { EntryForm, FORMS, type T } from './forms.js'
import type { AdminApi, AdminStatus, CheckResult, KitId, ServiceStatus } from './remote.js'
import { AdminError } from './remote.js'

type Service = ServiceStatus

/** 本包四行的标题按界面语言翻译（issue #4）；业务行用它登记的 label，缺译时退回服务端给的标题。 */
function serviceTitle(service: Service, t: T): string {
  if (service.registered) return service.title
  const key = `service.${service.id}`
  const text = t(key)
  return text && text !== key ? text : service.title
}

/** 业务行登记的密钥（issue #1）：只写不读，存入 dsh 凭据文件。 */
function EntrySecrets({ service, status, api, t, onChanged }: { service: Service; status: AdminStatus; api: AdminApi; t: T; onChanged(): void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const disabled = !status.writable
  const run = async (action: () => Promise<unknown>, failKey: string) => {
    setError(undefined)
    try {
      await action()
      onChanged()
    } catch (e) {
      setError(t(failKey, { message: (e as Error).message }))
    }
  }
  return (
    <section className="agent-kit-secrets" aria-label={t('secrets.section', { title: service.title })}>
      {service.secrets!.map((s, i) => {
        const id = `agent-kit-secret-${service.id}-${i}`
        if (!s.ref) return <p key={i} className="agent-kit-hint">{t('secrets.invalidRef', { label: s.label })}</p>
        const ref = s.ref
        return (
          <div key={ref} className="agent-kit-secret">
            <div className="agent-kit-secret-head">
              <label htmlFor={id}>{t('secrets.label', { label: s.label, ref })}</label>
              <span className="agent-kit-tag" data-tone={s.configured ? 'ok' : 'warn'}>
                {s.configured ? t('secrets.configured', { source: t(`source.${s.source ?? 'credentials'}`) }) : t('secrets.missing')}
              </span>
            </div>
            <div className="agent-kit-secret-row">
              <input id={id} type="password" autoComplete="off" disabled={disabled} value={values[ref] ?? ''} onChange={(e) => setValues({ ...values, [ref]: e.target.value })} />
              <button
                type="button"
                className="agent-kit-btn"
                data-variant="primary"
                aria-label={`${t('secrets.save')} ${s.label}`}
                disabled={disabled || !values[ref]}
                onClick={() => run(async () => (await api.setSecret('credentials', values[ref]!, ref), setValues({ ...values, [ref]: '' })), 'secrets.saveFailed')}
              >
                {t('secrets.save')}
              </button>
              {s.configured && s.source === 'credentials' && (
                <button type="button" className="agent-kit-btn" aria-label={`${t('secrets.clear')} ${s.label}`} disabled={disabled} onClick={() => run(() => api.clearSecret('credentials', ref), 'secrets.clearFailed')}>
                  {t('secrets.clear')}
                </button>
              )}
            </div>
          </div>
        )
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

/** 运行阶段与健康状态合成卡片右上角的一枚状态标签：颜色表示是否需要关注。 */
function statusTone(service: Service): 'ok' | 'warn' | 'error' | 'neutral' {
  if (service.phase === 'failed' || service.health?.status === 'failed') return 'error'
  if (service.health?.status === 'degraded' || service.phase === 'loading' || service.phase === 'pending') return 'warn'
  if (service.phase === 'active') return 'ok'
  return 'neutral'
}

export function ServiceCard(props: { service: Service; checks: CheckResult[]; status: AdminStatus; api: AdminApi; t: T; onSaved(version: string): void; onConflict(): void; onSecretChanged?(): void; children?: ReactNode }) {
  const { service, t } = props
  const [enabled, setEnabled] = useState(service.enabled)
  const [config, setConfig] = useState<Record<string, unknown>>(service.config ?? {})
  const [message, setMessage] = useState<{ text: string; error: boolean }>()
  const [saving, setSaving] = useState(false)
  const disabled = !props.status.writable || saving
  const Form = FORMS[service.id as KitId]
  const title = serviceTitle(service, t)
  const dependents = service.dependents?.map((d) => d.title).join(t('list.separator'))

  const save = async () => {
    // patchReload: live 下停用一行会连带卸载所有 inject 它的插件，进程仍在，外部守护进程察觉不到（issue #1）
    if (service.enabled && !enabled && dependents && !window.confirm(t('confirmDisableDependents', { title: title, names: dependents }))) return
    setSaving(true)
    setMessage(undefined)
    try {
      const { version } = await props.api.saveService(service.id, enabled, enabled ? config : null, props.status.version)
      setMessage({ text: t('saved'), error: false })
      props.onSaved(version)
    } catch (e) {
      const err = e as AdminError
      if (err.code === 'conflict') {
        setMessage({ text: t('conflict'), error: true })
        props.onConflict()
      } else if (err.errors?.length) setMessage({ text: err.errors.map((x) => `${x.path.replace(`${service.id}.`, '')}: ${x.message}`).join('\n'), error: true })
      else setMessage({ text: err.message, error: true })
    } finally {
      setSaving(false)
    }
  }

  const reloadHint =
    props.status.patchReload !== 'live' ? undefined : service.registered ? t('reloadRegistered', { title: title }) : dependents ? t('reloadDependents', { names: dependents }) : undefined

  const failing = props.checks.filter((c) => c.status !== 'pass' && c.status !== 'skip')
  const phase = t(`phase.${service.phase ?? 'none'}`)
  const statusText = service.health ? `${phase} · ${t(`health.${service.health.status}`)}` : phase

  return (
    <section className="agent-kit-card" aria-label={title} data-enabled={enabled}>
      <header className="agent-kit-card-head">
        <div className="agent-kit-card-title">
          <h3>{title}</h3>
          {service.health?.detail && <p className="agent-kit-detail">{service.health.detail}</p>}
        </div>
        <span className="agent-kit-tag agent-kit-phase" data-tone={statusTone(service)}>{statusText}</span>
        <button
          type="button"
          role="switch"
          className="agent-kit-switch"
          aria-checked={enabled}
          aria-label={`${t('enabled')} ${title}`}
          disabled={disabled}
          onClick={() => setEnabled(!enabled)}
        >
          <span className="agent-kit-sr">{enabled ? t('switch.on') : t('switch.off')}</span>
        </button>
      </header>
      <div className="agent-kit-card-body">
        {failing.length > 0 && (
          <ul className="agent-kit-checks">
            {failing.map((c) => (
              <li key={c.id} data-status={c.status}>
                <div>
                  {t('check.item', { title: c.title, detail: c.detail })}
                  {c.fix && <div className="agent-kit-fix">→ {c.fix}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {enabled && (
          <div className="agent-kit-fields">
            {Form ? <Form config={config} onChange={setConfig} disabled={disabled} t={t} /> : <EntryForm fields={service.fields ?? []} config={config} onChange={setConfig} disabled={disabled} t={t} />}
          </div>
        )}
        {props.children}
        {message && reloadHint && <p className="agent-kit-hint agent-kit-reload">{reloadHint}</p>}
        {service.secrets?.length ? <EntrySecrets service={service} status={props.status} api={props.api} t={t} onChanged={props.onSecretChanged ?? (() => {})} /> : null}
        <div className="agent-kit-footer">
          {message ? (
            <p role="status" className="agent-kit-message" data-tone={message.error ? 'error' : undefined}>{message.text}</p>
          ) : (
            <span className="agent-kit-hint">{reloadHint}</span>
          )}
          <button type="button" className="agent-kit-btn" data-variant="primary" aria-label={`${t('save')} ${title}`} disabled={disabled} onClick={save}>
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </section>
  )
}
