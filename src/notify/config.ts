import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'

export type NotifyChannel = 'dingtalk' | 'feishu'
export const NOTIFY_CHANNELS: readonly NotifyChannel[] = ['dingtalk', 'feishu']

export interface NotifyConfig {
  /** 发往哪些渠道；按顺序，failover 时即尝试顺序。 */
  channels: NotifyChannel[]
  /** `all`：每个渠道都发；`failover`：按顺序发，第一个成功即停止。 */
  strategy: 'all' | 'failover'
}

export const NotifyConfig: z<ConfigInput<NotifyConfig, 'channels'>, NotifyConfig> = z.object({
  channels: z
    .array(z.union(NOTIFY_CHANNELS as NotifyChannel[]))
    .required()
    .description('发往哪些渠道（dingtalk / feishu），可随时在设置页或 setup 中修改'),
  strategy: z.union(['all', 'failover'] as const).default('all').description('all：每个渠道都发；failover：按顺序发，第一个成功即停止'),
}) as z<ConfigInput<NotifyConfig, 'channels'>, NotifyConfig>

/** schema 之外的约束：至少一个渠道，且不重复。 */
export function assertNotifyConfig(config: NotifyConfig): void {
  const fail = (message: string) => {
    throw Object.assign(new Error(message), { details: { field: 'channels' } })
  }
  if (config.channels.length === 0) fail('至少选择一个通知渠道')
  if (new Set(config.channels).size !== config.channels.length) fail('通知渠道不能重复')
}
