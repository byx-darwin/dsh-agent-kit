import { useCallback, useEffect, useRef, useState } from 'react'
import type { T } from './forms.js'
import type { AdminApi, AdminStatus, KeyTarget } from './remote.js'
import { ServiceCard } from './service-card.js'

function KeyPanel({ status, api, t, onChanged }: { status: AdminStatus; api: AdminApi; t: T; onChanged(): void }) {
  const [value, setValue] = useState('')
  const [target, setTarget] = useState<KeyTarget>(status.keyTargets[0] ?? 'credentials')
  const [error, setError] = useState<string>()
  const disabled = !status.writable
  const save = async () => {
    setError(undefined)
    try {
      await api.setSecret(target, value)
      setValue('')
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="agent-kit-key" aria-label={t('jev.keySection')}>
      <p>{status.typesafeKey.configured ? t('jev.keyConfigured', { source: status.typesafeKey.source ?? '' }) : t('jev.keyMissing')}</p>
      <label htmlFor="agent-kit-key">{t('jev.key')}</label>
      <input id="agent-kit-key" type="password" autoComplete="off" disabled={disabled} value={value} onChange={(e) => setValue(e.target.value)} />
      <label htmlFor="agent-kit-key-target">{t('jev.target')}</label>
      <select id="agent-kit-key-target" disabled={disabled} value={target} onChange={(e) => setTarget(e.target.value as KeyTarget)}>
        {status.keyTargets.map((k) => (
          <option key={k} value={k}>{t(`target.${k}`)}</option>
        ))}
      </select>
      <button type="button" disabled={disabled || !value} onClick={save}>{t('jev.saveKey')}</button>
      {status.typesafeKey.configured && (
        <button type="button" disabled={disabled} onClick={async () => (await api.clearSecret(target), onChanged())}>{t('jev.clearKey')}</button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

export function SettingsPage({ api, t }: { api: AdminApi; t: T }) {
  const [status, setStatus] = useState<AdminStatus>()
  const [error, setError] = useState<string>()
  const [generation, setGeneration] = useState(0)
  const load = useCallback(async () => {
    try {
      setStatus(await api.status())
      setGeneration((g) => g + 1)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [api])
  useEffect(() => void load(), [load])
  // 保存后 dsh 重新加载 Service 需要时间，短暂轮询刷新状态；用 ref 记录定时器 id，
  // 便于在下一次保存前、以及组件卸载时清理，避免残留定时器在卸载后仍触发 setState。
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const clearTimers = useCallback(() => {
    for (const id of timers.current) clearTimeout(id)
    timers.current = []
  }, [])
  useEffect(() => clearTimers, [clearTimers])
  const refreshSoon = useCallback(
    (version: string) => {
      // 立刻用保存返回的版本号更新本地状态，避免下一次保存（在轮询落地前）用到过期的 expectedVersion。
      setStatus((prev) => (prev ? { ...prev, version } : prev))
      clearTimers()
      timers.current = [500, 1500, 3000].map((ms) => setTimeout(() => void api.status().then(setStatus).catch(() => {}), ms))
    },
    [api, clearTimers],
  )

  if (error) return <p role="alert">{t('loadFailed', { message: error })}</p>
  if (!status) return <p>{t('loading')}</p>
  return (
    <div className="agent-kit-settings">
      <h2>{t('title')}</h2>
      <p>{t('profile', { name: status.profile })}</p>
      {status.patchReload === 'startup' && <p>{t('reloadStartup')}</p>}
      {!status.writable && <p role="note">{t('readOnly', { reason: status.readOnlyReason ?? '' })}</p>}
      {status.services.map((s) => (
        <div key={`${s.id}-${generation}`}>
          <ServiceCard service={s} checks={status.checks.filter((c) => c.scope === s.id)} status={status} api={api} t={t} onSaved={refreshSoon} onConflict={load} />
          {s.id === 'agent-kit-jev' && <KeyPanel status={status} api={api} t={t} onChanged={load} />}
        </div>
      ))}
    </div>
  )
}
