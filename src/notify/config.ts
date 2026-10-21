import z from '@deepseek-ai/schemastery'
import { CHANNEL_NAMES, type ChannelName } from '../common/channel.js'
import type { ConfigInput } from '../common/errors.js'

export type NotifyChannel = ChannelName
export const NOTIFY_CHANNELS = CHANNEL_NAMES

export interface NotifyConfig {
  /** 默认渠道：`send()` 未指定 `targets` 时发往这里。 */
  channel: NotifyChannel
}

export const NotifyConfig: z<ConfigInput<NotifyConfig>, NotifyConfig> = z.object({
  channel: z.union(NOTIFY_CHANNELS.map((c) => z.const(c))).default('dingtalk').description('默认渠道：send() 未指定 targets 时发往这里'),
}) as z<ConfigInput<NotifyConfig>, NotifyConfig>
