import { useState } from 'react'
import type { T } from './forms.js'
import type { AdminApi, AdminChannel, ChannelUnmatchedMessage } from './remote.js'

export function ChannelUnmatchedPanel({ channel, api, t }: { channel: AdminChannel; api: AdminApi; t: T }) {
  const [items, setItems] = useState<ChannelUnmatchedMessage[]>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const refresh = async () => {
    setLoading(true)
    setError(undefined)
    try {
      setItems(await api.channelUnmatched(channel))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <section className="agent-kit-secrets agent-kit-unmatched" aria-label={t('unmatched.title')}>
      <div className="agent-kit-secret-head">
        <span className="agent-kit-auth-title">{t('unmatched.title')}</span>
        <button type="button" className="agent-kit-btn" disabled={loading} onClick={() => void refresh()}>{t('unmatched.refresh')}</button>
      </div>
      <p className="agent-kit-hint">{t('unmatched.hint')}</p>
      {error && <p role="alert">{error}</p>}
      {items?.length === 0 && <p className="agent-kit-hint">{t('unmatched.empty')}</p>}
      {items && items.length > 0 && (
        <ul className="agent-kit-unmatched-list">
          {items.map((item) => (
            <li key={item.eventId}>
              <div><strong>{item.conversationName ?? t('unmatched.unknownGroup')}</strong> <code>{item.conversationId}</code></div>
              <small>{new Date(item.receivedAt).toLocaleString()} · {item.eventId}</small>
              <p>{item.preview}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
