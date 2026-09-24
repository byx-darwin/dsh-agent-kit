import type { ClientContext } from './host-types.js'
import { en, zh } from './locale.js'
import { AGENT_KIT_REMOTE, createAdminApi } from './remote.js'
import { SettingsPage } from './settings-page.js'

export const inject = ['slots', 'locale', 'remote']
const NS = 'settings.agentKit'

export function apply(ctx: ClientContext): void {
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
  }
  const Page = () => <SettingsPage api={lazyApi} t={t} />
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'agent-kit', order: 40, label: () => t('nav'), locale: NS }, Page),
  )
}
