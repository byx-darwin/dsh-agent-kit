import type { ClientContext } from './host-types.js'
import { en, zh } from './locale.js'
import { AGENT_KIT_REMOTE, createAdminApi } from './remote.js'
import { SettingsPage } from './settings-page.js'
import { CSS, STYLE_ID } from './styles.js'

export const inject = ['slots', 'locale', 'remote']
const NS = 'settings.agentKit'

/** 注入一次页面样式，返回移除函数；同一文档里已有（例如热重载前的旧实例）时先替换。 */
function injectStyles(): () => void {
  document.getElementById(STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}

export function apply(ctx: ClientContext): void {
  ctx.effect(injectStyles, 'agent-kit: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-kit: dictionaries')
  const t = ctx.locale.bind(NS)
  let disposeRemote: (() => void) | undefined
  const ready = ctx.remote.$mount(AGENT_KIT_REMOTE).then((d) => (disposeRemote = d))
  ctx.effect(() => () => disposeRemote?.(), 'agent-kit: remote')
  const api = createAdminApi(ctx)
  const lazyApi = {
    status: async () => (await ready, api.status()),
    saveService: async (...a: Parameters<typeof api.saveService>) => (await ready, api.saveService(...a)),
    setSecret: async (...a: Parameters<typeof api.setSecret>) => (await ready, api.setSecret(...a)),
    clearSecret: async (...a: Parameters<typeof api.clearSecret>) => (await ready, api.clearSecret(...a)),
    dingtalkAuth: async () => (await ready, api.dingtalkAuth()),
    dingtalkLogin: async () => (await ready, api.dingtalkLogin()),
    dingtalkLoginCancel: async () => (await ready, api.dingtalkLoginCancel()),
    dingtalkLogout: async () => (await ready, api.dingtalkLogout()),
  }
  const Page = () => <SettingsPage api={lazyApi} t={t} />
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'agent-kit', order: 40, label: () => t('nav'), locale: NS }, Page),
  )
}
