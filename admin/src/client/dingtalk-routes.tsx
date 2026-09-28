import { useState } from 'react'
import type { T } from './forms.js'
import type { AdminApi, AdminStatus, DingtalkUnmatchedMessage } from './remote.js'

interface GroupRoute { conversationId: string; pluginId: string }

function routesOf(config: Record<string, unknown>): GroupRoute[] {
  if (!Array.isArray(config.groupRoutes)) return []
  return config.groupRoutes.filter((item): item is GroupRoute =>
    !!item && typeof item === 'object' && typeof item.conversationId === 'string' && typeof item.pluginId === 'string')
}

export function DingtalkRoutesPanel({ config, onChange, status, api, disabled, t }: {
  config: Record<string, unknown>
  onChange(config: Record<string, unknown>): void
  status: AdminStatus
  api: AdminApi
  disabled: boolean
  t: T
}) {
  const routes = routesOf(config)
  const [conversationId, setConversationId] = useState('')
  const [pluginId, setPluginId] = useState('')
  const [suggestions, setSuggestions] = useState<DingtalkUnmatchedMessage[]>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const registered = status.services.filter((service) => service.registered)
  const names = new Map(registered.map((service) => [service.id, service.title]))
  const add = () => {
    const cid = conversationId.trim()
    const plugin = pluginId.trim()
    if (!cid || !plugin) return
    if (routes.some((route) => route.conversationId === cid)) {
      setError(t('dingtalk.routes.duplicate'))
      return
    }
    onChange({ ...config, groupRoutes: [...routes, { conversationId: cid, pluginId: plugin }] })
    setConversationId('')
    setPluginId('')
    setError(undefined)
  }
  const loadSuggestions = async () => {
    setLoading(true)
    setError(undefined)
    try {
      const items = await api.dingtalkUnmatched()
      setSuggestions([...new Map(items.map((item) => [item.conversationId, item])).values()])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <section className="agent-kit-secrets agent-kit-routes" aria-label={t('dingtalk.routes.title')}>
      <div className="agent-kit-secret-head">
        <span className="agent-kit-auth-title">{t('dingtalk.routes.title')}</span>
        <button type="button" className="agent-kit-btn" disabled={disabled || loading} onClick={() => void loadSuggestions()}>{t('dingtalk.routes.discover')}</button>
      </div>
      <p className="agent-kit-hint">{t('dingtalk.routes.hint')}</p>
      {routes.length ? (
        <ul className="agent-kit-route-list">
          {routes.map((route) => (
            <li key={route.conversationId}>
              <div><strong>{suggestions?.find((item) => item.conversationId === route.conversationId)?.groupName ?? route.conversationId}</strong><small>{route.conversationId}</small></div>
              <span>→ {names.get(route.pluginId) ?? route.pluginId} <code>{route.pluginId}</code></span>
              <button type="button" className="agent-kit-btn" disabled={disabled} aria-label={t('dingtalk.routes.remove', { id: route.conversationId })} onClick={() => onChange({ ...config, groupRoutes: routes.filter((item) => item !== route) })}>{t('dingtalk.routes.removeShort')}</button>
            </li>
          ))}
        </ul>
      ) : <p className="agent-kit-hint">{t('dingtalk.routes.empty')}</p>}
      <div className="agent-kit-route-add">
        <label>{t('dingtalk.routes.groupId')}<input value={conversationId} disabled={disabled} placeholder="cid…" onChange={(e) => setConversationId(e.target.value)} /></label>
        <label>{t('dingtalk.routes.plugin')}<input list="agent-kit-business-plugins" value={pluginId} disabled={disabled} placeholder={t('dingtalk.routes.pluginPlaceholder')} onChange={(e) => setPluginId(e.target.value)} /></label>
        <datalist id="agent-kit-business-plugins">{registered.map((service) => <option key={service.id} value={service.id}>{service.title}</option>)}</datalist>
        <button type="button" className="agent-kit-btn" disabled={disabled || !conversationId.trim() || !pluginId.trim()} onClick={add}>{t('dingtalk.routes.add')}</button>
      </div>
      {suggestions && suggestions.some((item) => !routes.some((route) => route.conversationId === item.conversationId)) && (
        <div className="agent-kit-route-suggestions">
          <span className="agent-kit-hint">{t('dingtalk.routes.suggestions')}</span>
          {suggestions.filter((item) => !routes.some((route) => route.conversationId === item.conversationId)).map((item) => <button type="button" className="agent-kit-btn" key={item.conversationId} disabled={disabled} onClick={() => setConversationId(item.conversationId)}>{item.groupName ?? item.conversationId} · {item.conversationId}</button>)}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
