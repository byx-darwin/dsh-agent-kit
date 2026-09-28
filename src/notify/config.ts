import z from '@deepseek-ai/schemastery'
import { CHANNEL_NAMES, type ChannelName } from '../common/channel.js'
import type { ConfigInput } from '../common/errors.js'

export type NotifyChannel = ChannelName
export const NOTIFY_CHANNELS = CHANNEL_NAMES

export interface NotifyConfig {
  /** 通知发往钉钉。 */
  channel: NotifyChannel
}

export const NotifyConfig: z<ConfigInput<NotifyConfig>, NotifyConfig> = z.object({
  channel: z.const('dingtalk').default('dingtalk').description('通知固定发往钉钉'),
}) as z<ConfigInput<NotifyConfig>, NotifyConfig>
