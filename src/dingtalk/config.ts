import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'
import type { DingtalkIdentity, DingtalkTarget } from './args.js'

export interface DingtalkConfig {
  identity: DingtalkIdentity
  defaultTarget?: DingtalkTarget
  robotCode?: string
  webhookTokenEnv?: string
  dwsPath?: string
  timeoutMs: number
  killGraceMs: number
  retry: { maxAttempts: number }
  preflightIntervalMs: number
  dryRun: boolean
}

const int = () => z.natural().step(1)

const Target = z.union([
  z.object({ chatId: z.string().required() }),
  z.object({ userId: z.string().required() }),
  z.object({ openDingtalkId: z.string().required() }),
  z.object({ chatIds: z.array(z.string()).required() }),
])

export const DingtalkConfig: z<ConfigInput<DingtalkConfig, 'identity'>, DingtalkConfig> = z.object({
  identity: z.union(['user', 'bot', 'webhook'] as const).required().description('发送身份；服务器环境推荐 bot'),
  defaultTarget: Target.description('省略 target 时使用'),
  robotCode: z.string().description('bot 身份必填'),
  webhookTokenEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).description('webhook 身份必填：保存 token 的环境变量名'),
  dwsPath: z.string().description('dws 可执行文件的绝对路径；默认从 PATH 解析'),
  timeoutMs: int().min(1000).max(120_000).default(15_000),
  killGraceMs: int().default(5000),
  retry: z.object({ maxAttempts: int().max(5).default(2) }).default({ maxAttempts: 2 }),
  preflightIntervalMs: int().default(3_600_000).description('检查 dws 登录态的间隔，0 表示只在启动时检查'),
  dryRun: z.boolean().default(false),
}) as z<ConfigInput<DingtalkConfig, 'identity'>, DingtalkConfig>
