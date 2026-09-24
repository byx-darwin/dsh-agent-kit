import { useId } from 'react'
import type { ClientContext } from './host-types.js'

export const inject = ['slots', 'locale', 'remote']

const NS = 'settings.agentKit'

function Placeholder() {
  const id = useId()
  return (
    <div id={id} data-testid="agent-kit-settings">
      Agent Kit
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh: { nav: 'Agent Kit' } }), 'agent-kit: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'agent-kit', order: 40, label: () => t('nav'), locale: NS }, Placeholder),
  )
}
