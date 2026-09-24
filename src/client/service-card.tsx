import { useState } from 'react'
import { FORMS, type T } from './forms.js'
import type { AdminApi, AdminStatus, CheckResult } from './remote.js'
import { AdminError } from './remote.js'

type Service = AdminStatus['services'][number]

export function ServiceCard(props: { service: Service; checks: CheckResult[]; status: AdminStatus; api: AdminApi; t: T; onSaved(version: string): void; onConflict(): void }) {
  const { service, t } = props
  const [enabled, setEnabled] = useState(service.enabled)
  const [config, setConfig] = useState<Record<string, unknown>>(service.config ?? {})
  const [message, setMessage] = useState<string>()
  const [saving, setSaving] = useState(false)
  const disabled = !props.status.writable || saving
  const Form = FORMS[service.id]

  const save = async () => {
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

  return (
    <section className="agent-kit-card" aria-label={service.title}>
      <header>
        <h3>{service.title}</h3>
        <button type="button" role="switch" aria-checked={enabled} aria-label={`${t('enabled')} ${service.title}`} disabled={disabled} onClick={() => setEnabled(!enabled)}>
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
              {c.title}：{c.detail}
              {c.fix && <div>→ {c.fix}</div>}
            </li>
          ))}
      </ul>
      {enabled && <Form config={config} onChange={setConfig} disabled={disabled} t={t} />}
      <button type="button" aria-label={`${t('save')} ${service.title}`} disabled={disabled} onClick={save}>
        {saving ? t('saving') : t('save')}
      </button>
      {message && <p role="status" style={{ whiteSpace: 'pre-line' }}>{message}</p>}
    </section>
  )
}
