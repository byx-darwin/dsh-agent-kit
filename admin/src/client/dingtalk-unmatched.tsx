import { useState } from 'react'
import type { T } from './forms.js'
import type { AdminApi, DingtalkUnmatchedMessage } from './remote.js'

export function DingtalkUnmatchedPanel({ api, t }: { api: AdminApi; t: T }) {
  const [items, setItems] = useState<DingtalkUnmatchedMessage[]>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const refresh = async () => {
    setLoading(true)
    setError(undefined)
    try {
      setItems(await api.dingtalkUnmatched())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <section className="agent-kit-secrets agent-kit-unmatched" aria-label={t('dingtalk.unmatched.title')}>
      <div className="agent-kit-secret-head">
        <span className="agent-kit-auth-title">{t('dingtalk.unmatched.title')}</span>
        <button type="button" className="agent-kit-btn" disabled={loading} onClick={() => void refresh()}>{t('dingtalk.unmatched.refresh')}</button>
      </div>
      <p className="agent-kit-hint">{t('dingtalk.unmatched.hint')}</p>
      {error && <p role="alert">{error}</p>}
      {items?.length === 0 && <p className="agent-kit-hint">{t('dingtalk.unmatched.empty')}</p>}
      {items && items.length > 0 && (
        <ul className="agent-kit-unmatched-list">
          {items.map((item) => (
            <li key={item.eventId}>
              <div><strong>{item.groupName ?? t('dingtalk.unmatched.unknownGroup')}</strong> <code>{item.conversationId}</code></div>
              <small>{new Date(item.receivedAt).toLocaleString()} · {item.eventId}</small>
              <p>{item.preview}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
