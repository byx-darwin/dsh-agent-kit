import type { Check, CheckResult } from './types.js'

const TITLES: Record<string, string> = { dingtalk: '钉钉', feishu: '飞书' }

/** 通知渠道指向的每个渠道行都应已启用，否则发送时该渠道报 channel_unavailable。 */
export const notifyChecks: Check = (ctx) => {
  const scope = 'agent-kit-notify' as const
  const channels = ((ctx.snapshot.entries[scope].config ?? {}) as { channels?: string[] }).channels ?? []
  return channels.map((channel): CheckResult => {
    const id = `agent-kit-${channel}` as 'agent-kit-dingtalk' | 'agent-kit-feishu'
    const enabled = ctx.snapshot.entries[id]?.enabled === true
    return {
      id: `${scope}.channel-${channel}`,
      scope,
      title: `通知渠道：${TITLES[channel] ?? channel}`,
      status: enabled ? 'pass' : 'fail',
      detail: enabled ? `${id} 已启用` : `${id} 未启用，发往该渠道的通知会失败`,
      ...(enabled ? {} : { fix: `启用 ${TITLES[channel] ?? channel}（设置页或 setup），或从通知渠道中移除它` }),
    }
  })
}
