import type { Check } from './types.js'

const TITLES: Record<string, string> = { dingtalk: '钉钉' }

/** 默认通知渠道对应的渠道行应已启用，否则未指定 targets 的通知会报 channel_unavailable。 */
export const notifyChecks: Check = (ctx) => {
  const scope = 'agent-kit-notify' as const
  const channel = ((ctx.snapshot.entries[scope].config ?? {}) as { channel?: string }).channel
  if (!channel) return []
  const id = `agent-kit-${channel}` as 'agent-kit-dingtalk'
  const enabled = ctx.snapshot.entries[id]?.enabled === true
  const title = TITLES[channel] ?? channel
  return [
    {
      id: `${scope}.channel`,
      scope,
      title: `默认通知渠道：${title}`,
      status: enabled ? 'pass' : 'fail',
      detail: enabled ? `${id} 已启用` : `${id} 未启用，发往默认渠道的通知会失败`,
      ...(enabled ? {} : { fix: `启用 ${title}（设置页或 setup），或把默认通知渠道改为已启用的渠道` }),
    },
  ]
}
