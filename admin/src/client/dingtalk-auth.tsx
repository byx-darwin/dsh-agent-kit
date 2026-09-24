import { useCallback, useEffect, useRef, useState } from 'react'
import type { T } from './forms.js'
import type { AdminApi, DingtalkAuthStatus } from './remote.js'

const POLL_MS = 3000
/** 登录（refresh token）剩余不足这么久时提醒重新登录。 */
const EXPIRING_MS = 3 * 24 * 3600_000

function shortTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 钉钉卡片里的登录区：显示 dws 当前登录的账号与凭证有效期；未登录时可登录（设备码），已登录时可退出。
 * 登录进行中每 3 秒刷新一次，授权完成后自动变为已登录。
 */
export function DingtalkAuthPanel({ api, t, writable, onChanged }: { api: AdminApi; t: T; writable: boolean; onChanged(): void }) {
  const [auth, setAuth] = useState<DingtalkAuthStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // 登录从等待变为成功时刷新整页状态（钉钉卡片的健康状态随之更新）
  const lastLogin = useRef<string>()
  const load = useCallback(async () => {
    try {
      const next = await api.dingtalkAuth()
      if (lastLogin.current === 'waiting' && next.login?.state === 'succeeded') onChanged()
      lastLogin.current = next.login?.state
      setAuth(next)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [api, onChanged])
  useEffect(() => void load(), [load])

  const waiting = auth?.login?.state === 'waiting'
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [waiting, load])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      await load()
    }
  }
  const login = () => run(() => api.dingtalkLogin())
  const cancel = () => run(() => api.dingtalkLoginCancel())
  const logout = () => {
    if (!window.confirm(t('dingtalk.auth.logoutConfirm', { user: auth?.user ?? '' }))) return
    void run(async () => {
      await api.dingtalkLogout()
      onChanged()
    })
  }

  const disabled = !writable || busy
  // access token 只有 2 小时、由 dws 自动续期；真正决定何时需要重新登录的是 refresh token 的到期时间
  const loginUntil = auth?.refreshExpiresAt ?? auth?.expiresAt
  const expiring = !!auth?.authenticated && !!loginUntil && new Date(loginUntil).getTime() - Date.now() < EXPIRING_MS
  const tone = !auth ? 'neutral' : expiring ? 'warn' : auth.authenticated ? 'ok' : waiting ? 'warn' : 'error'
  const tag = !auth
    ? t('loading')
    : !auth.installed
      ? t('dingtalk.auth.notInstalled')
      : expiring
        ? t('dingtalk.auth.expiring')
        : auth.authenticated
        ? t('dingtalk.auth.signedIn')
        : waiting
          ? t('dingtalk.auth.pending')
          : t('dingtalk.auth.signedOut')
  const login_ = auth?.login

  return (
    <section className="agent-kit-secrets agent-kit-auth" aria-label={t('dingtalk.auth.section')}>
      <div className="agent-kit-secret-head">
        <span className="agent-kit-auth-title">{t('dingtalk.auth.section')}</span>
        <span className="agent-kit-tag" data-tone={tone}>{tag}</span>
      </div>
      {auth?.authenticated && (
        <p className="agent-kit-hint">
          {[auth.user, auth.corp].filter(Boolean).join(' @ ')}
          {loginUntil && ` · ${t(auth.refreshExpiresAt ? 'dingtalk.auth.until' : 'dingtalk.auth.tokenUntil', { time: shortTime(loginUntil) })}`}
        </p>
      )}
      {auth && !auth.installed && <p className="agent-kit-hint">{t('dingtalk.auth.installHint')}</p>}
      {waiting && login_?.code ? (
        <div className="agent-kit-login">
          <div className="agent-kit-login-code" aria-label={t('dingtalk.auth.code')}>{login_.code}</div>
          <p className="agent-kit-hint">{t('dingtalk.auth.waiting', { time: shortTime(login_.expiresAt) })}</p>
          <div className="agent-kit-secret-row agent-kit-actions">
            {login_.url && (
              <a className="agent-kit-btn" data-variant="primary" href={login_.url} target="_blank" rel="noreferrer">
                {t('dingtalk.auth.open')}
              </a>
            )}
            <button type="button" className="agent-kit-btn" disabled={disabled} onClick={cancel}>{t('dingtalk.auth.cancel')}</button>
          </div>
        </div>
      ) : (
        auth?.installed && (
          <div className="agent-kit-secret-row agent-kit-actions">
            {auth.authenticated && expiring && (
              <button type="button" className="agent-kit-btn" data-variant="primary" disabled={disabled} onClick={login}>
                {busy ? t('dingtalk.auth.starting') : t('dingtalk.auth.login')}
              </button>
            )}
            {auth.authenticated ? (
              <button type="button" className="agent-kit-btn" disabled={disabled} onClick={logout}>{t('dingtalk.auth.logout')}</button>
            ) : (
              <button type="button" className="agent-kit-btn" data-variant="primary" disabled={disabled} onClick={login}>
                {busy ? t('dingtalk.auth.starting') : t('dingtalk.auth.login')}
              </button>
            )}
          </div>
        )
      )}
      {login_?.state === 'failed' && <p role="alert">{t('dingtalk.auth.failed', { message: login_.message ?? '' })}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
