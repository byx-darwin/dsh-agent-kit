import { useState } from 'react'
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
        if (!s.ref) return <p key={i}>{t('secrets.invalidRef', { label: s.label })}</p>
        const ref = s.ref
        return (
          <div key={ref} className="agent-kit-field">
            <label htmlFor={id}>{t('secrets.label', { label: s.label, ref })}</label>
            <p>{s.configured ? t('secrets.configured', { source: t(`source.${s.source ?? 'credentials'}`) }) : t('secrets.missing')}</p>
            <input id={id} type="password" autoComplete="off" disabled={disabled} value={values[ref] ?? ''} onChange={(e) => setValues({ ...values, [ref]: e.target.value })} />
            <button
              type="button"
              aria-label={`${t('secrets.save')} ${s.label}`}
              disabled={disabled || !values[ref]}
              onClick={() => run(async () => (await api.setSecret('credentials', values[ref]!, ref), setValues({ ...values, [ref]: '' })), 'secrets.saveFailed')}
            >
              {t('secrets.save')}
            </button>
            {s.configured && s.source === 'credentials' && (
              <button type="button" aria-label={`${t('secrets.clear')} ${s.label}`} disabled={disabled} onClick={() => run(() => api.clearSecret('credentials', ref), 'secrets.clearFailed')}>
                {t('secrets.clear')}
              </button>
            )}
          </div>
        )
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

export function ServiceCard(props: { service: Service; checks: CheckResult[]; status: AdminStatus; api: AdminApi; t: T; onSaved(version: string): void; onConflict(): void; onSecretChanged?(): void }) {
  const { service, t } = props
  const [enabled, setEnabled] = useState(service.enabled)
  const [config, setConfig] = useState<Record<string, unknown>>(service.config ?? {})
  const [message, setMessage] = useState<string>()
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
      setMessage(t('saved'))
      props.onSaved(version)
    } catch (e) {
      const err = e as AdminError
      if (err.code === 'conflict') {
        setMessage(t('conflict'))
        props.onConflict()
      } else if (err.errors?.length) setMessage(err.errors.map((x) => `${x.path.replace(`${service.id}.`, '')}: ${x.message}`).join('\n'))
      else setMessage(err.message)
    } finally {
      setSaving(false)
    }
  }

  const reloadHint =
    props.status.patchReload !== 'live' ? undefined : service.registered ? t('reloadRegistered', { title: title }) : dependents ? t('reloadDependents', { names: dependents }) : undefined

  return (
    <section className="agent-kit-card" aria-label={title}>
      <header>
        <h3>{title}</h3>
        <button type="button" role="switch" aria-checked={enabled} aria-label={`${t('enabled')} ${title}`} disabled={disabled} onClick={() => setEnabled(!enabled)}>
          {enabled ? t('switch.on') : t('switch.off')}
        </button>
      </header>
      <p className="agent-kit-phase">
        {t(`phase.${service.phase ?? 'none'}`)}
        {service.health && (
          <>
            {' · '}
            {t(`health.${service.health.status}`)} · <span>{service.health.detail}</span>
          </>
        )}
      </p>
      <ul className="agent-kit-checks">
        {props.checks
          .filter((c) => c.status !== 'pass' && c.status !== 'skip')
          .map((c) => (
            <li key={c.id} data-status={c.status}>
              {t('check.item', { title: c.title, detail: c.detail })}
              {c.fix && <div>→ {c.fix}</div>}
            </li>
          ))}
      </ul>
      {enabled && (Form ? <Form config={config} onChange={setConfig} disabled={disabled} t={t} /> : <EntryForm fields={service.fields ?? []} config={config} onChange={setConfig} disabled={disabled} t={t} />)}
      {reloadHint && <p className="agent-kit-hint">{reloadHint}</p>}
      <button type="button" aria-label={`${t('save')} ${title}`} disabled={disabled} onClick={save}>
        {saving ? t('saving') : t('save')}
      </button>
      {message && <p role="status" style={{ whiteSpace: 'pre-line' }}>{message}</p>}
      {service.secrets?.length ? <EntrySecrets service={service} status={props.status} api={props.api} t={t} onChanged={props.onSecretChanged ?? (() => {})} /> : null}
    </section>
  )
}
