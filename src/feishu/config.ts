import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'

export const FEISHU_APP_SECRET_REF = 'FEISHU_APP_SECRET'

export type FeishuTarget = { chatId: string } | { openId: string }

export interface FeishuConfig {
  appId: string
  /** App Secret 的密钥引用：先读同名环境变量，再读 dsh 凭据文件。 */
  appSecretRef: string
  domain: 'feishu' | 'lark'
  defaultTarget?: FeishuTarget
  /** 会话 ID（群或单聊）到业务插件 ID 的一对一路由。 */
  groupRoutes: Array<{ conversationId: string; pluginId: string }>
  timeoutMs: number
  retry: { maxAttempts: number }
  dryRun: boolean
}

const int = () => z.natural().step(1)

const Target = z.union([
  z.object({ chatId: z.string().required() }),
  z.object({ openId: z.string().required() }),
])

export const FeishuConfig: z<ConfigInput<FeishuConfig>, FeishuConfig> = z.object({
  appId: z.string().required().description('飞书自建应用的 App ID'),
  appSecretRef: z.string().default(FEISHU_APP_SECRET_REF).description('App Secret 的密钥引用：先读同名环境变量，再读 dsh 凭据文件'),
  domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu').description('feishu 为飞书，lark 为国际版 Lark'),
  defaultTarget: Target.description('省略 target 时使用'),
  groupRoutes: z.array(z.object({ conversationId: z.string().required(), pluginId: z.string().required() })).default([]).description('会话 ID（群或单聊）到业务插件 ID 的一对一路由；可在 Agent Kit 设置页配置'),
  timeoutMs: int().min(1000).max(120_000).default(15_000).description('单次发送超时（毫秒）'),
  retry: z.object({ maxAttempts: int().max(5).default(2) }).default({ maxAttempts: 2 }).description('传入 idempotencyKey 时的重试次数'),
  dryRun: z.boolean().default(false).description('只记日志，不调用飞书接口'),
}) as z<ConfigInput<FeishuConfig>, FeishuConfig>
