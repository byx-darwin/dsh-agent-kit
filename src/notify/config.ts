import z from '@deepseek-ai/schemastery'
import { CHANNEL_NAMES, type ChannelName } from '../common/channel.js'
import type { ConfigInput } from '../common/errors.js'

export type NotifyChannel = ChannelName
export const NOTIFY_CHANNELS = CHANNEL_NAMES

export interface NotifyConfig {
  /** 通知发往的渠道。同一时间只用一个；运行中可用 `ctx.notify.use()` 临时切换。 */
  channel: NotifyChannel
}

export const NotifyConfig: z<ConfigInput<NotifyConfig, 'channel'>, NotifyConfig> = z.object({
  channel: z.union(NOTIFY_CHANNELS as NotifyChannel[]).required().description('通知发往的渠道：dingtalk 或 feishu'),
}) as z<ConfigInput<NotifyConfig, 'channel'>, NotifyConfig>
