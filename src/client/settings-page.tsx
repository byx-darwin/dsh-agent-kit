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
  /**
   * 冲突（`saveService` 返回 `conflict`）后的自动刷新专用：只更新 `status`，不 `setGeneration`。
   *
   * `ServiceCard` 用 `key={\`${s.id}-${generation}\`}`（见下方 `.map`），目的是在“首次加载”这类需要
   * 整体重置表单本地状态（`enabled`/`config`）的场合，强制卸载重建卡片。但 `ServiceCard.save()` 在捕获
   * 到 `conflict` 后，是先 `setMessage(t('conflict'))` 把冲突提示放进*自己的*本地 state，再调用
   * `props.onConflict()`——如果 `onConflict` 也走 `load()`、跟着 `setGeneration` 自增，`key` 一变
   * `ServiceCard` 就会被整体卸载重建，其本地 `message` state 随之清空，冲突提示只在两次渲染之间一闪而
   * 过。单元测试用 `findByText` 轮询、恰好能在“重新挂载”发生前的那一帧捕捉到文案，所以一直没暴露；但在
   * 真实浏览器走查里，点击保存后等待再读取文案时，重新挂载早已完成、提示已经消失（真实走查中复现过）。
   * 这里改为一个只刷新 `status`（从而让 `ServiceCard` 通过 props 拿到最新 `version` 用于下一次保存）、
   * 不触发 `generation` 自增、也就不会卸载重建卡片的轻量刷新，让冲突提示能稳定地保持展示。
   */
  const refreshAfterConflict = useCallback(async () => {
    try {
      setStatus(await api.status())
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [api])
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
          <ServiceCard service={s} checks={status.checks.filter((c) => c.scope === s.id)} status={status} api={api} t={t} onSaved={refreshSoon} onConflict={refreshAfterConflict} />
          {s.id === 'agent-kit-jev' && <KeyPanel status={status} api={api} t={t} onChanged={load} />}
        </div>
      ))}
    </div>
  )
}
