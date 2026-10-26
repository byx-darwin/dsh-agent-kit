import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'

export const WECOM_SECRET_REF = 'WECOM_BOT_SECRET'

export type WecomTarget = { chatId: string } | { userId: string }

export interface WecomConfig {
  botId: string
  /** Secret 的密钥引用：先读同名环境变量，再读 dsh 凭据文件。 */
  secretRef: string
  defaultTarget?: WecomTarget
  /** 会话 ID（群 chatid 或单聊 userid）到业务插件 ID 的一对一路由。 */
  groupRoutes: Array<{ conversationId: string; pluginId: string }>
  timeoutMs: number
  wsUrl?: string
  dryRun: boolean
}

const int = () => z.natural().step(1)

const Target = z.union([
  z.object({ chatId: z.string().required() }),
  z.object({ userId: z.string().required() }),
])

export const WecomConfig: z<ConfigInput<WecomConfig>, WecomConfig> = z.object({
  botId: z.string().required().description('企业微信智能机器人的 BotID'),
  secretRef: z.string().default(WECOM_SECRET_REF).description('Secret 的密钥引用：先读同名环境变量，再读 dsh 凭据文件'),
  defaultTarget: Target.description('省略 target 时使用；群为 chatId，单聊为 userId'),
  groupRoutes: z.array(z.object({ conversationId: z.string().required(), pluginId: z.string().required() })).default([]).description('会话 ID（群 chatid 或单聊 userid）到业务插件 ID 的一对一路由；可在 Agent Kit 设置页配置'),
  timeoutMs: int().min(1000).max(120_000).default(15_000).description('单次请求超时（毫秒）；SDK 的消息回执超时固定为 5 秒，单次发送实际最多约等 5 秒'),
  wsUrl: z.string().description('私有部署企业的长连接地址；默认使用企业微信官方地址'),
  dryRun: z.boolean().default(false).description('只记日志，不调用企业微信；仍需安装 SDK 且 Secret 能解析'),
}) as z<ConfigInput<WecomConfig>, WecomConfig>
