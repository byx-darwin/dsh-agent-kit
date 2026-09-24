import type { Check } from './types.js'

const TITLES: Record<string, string> = { dingtalk: '钉钉', feishu: '飞书' }

/** 通知渠道指向的渠道行应已启用，否则发送时报 channel_unavailable。 */
export const notifyChecks: Check = (ctx) => {
  const scope = 'agent-kit-notify' as const
  const channel = ((ctx.snapshot.entries[scope].config ?? {}) as { channel?: string }).channel
  if (!channel) return []
  const id = `agent-kit-${channel}` as 'agent-kit-dingtalk' | 'agent-kit-feishu'
  const enabled = ctx.snapshot.entries[id]?.enabled === true
  const title = TITLES[channel] ?? channel
  return [
    {
      id: `${scope}.channel`,
      scope,
      title: `通知渠道：${title}`,
      status: enabled ? 'pass' : 'fail',
      detail: enabled ? `${id} 已启用` : `${id} 未启用，通知会失败`,
      ...(enabled ? {} : { fix: `启用 ${title}（设置页或 setup），或把通知渠道切换到已启用的渠道` }),
    },
  ]
}
