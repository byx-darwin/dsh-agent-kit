import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'
import type { FeishuIdentity, FeishuTarget } from './args.js'

export interface FeishuConfig {
  identity: FeishuIdentity
  defaultTarget?: FeishuTarget
  /** lark-cli 的命名配置（`lark-cli --profile`）；缺省用 lark-cli 的当前配置。 */
  profile?: string
  /**
   * lark-cli 可执行文件的绝对路径；默认从 PATH 解析。必须指向可直接执行的二进制或脚本（例如
   * `lark-cli`、`lark-cli.exe`、`run.js`）——不支持 Windows 的 `.cmd`/`.bat` 包装脚本。
   */
  larkPath?: string
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
  z.object({ chatIds: z.array(z.string()).required() }),
])

export const FeishuConfig: z<ConfigInput<FeishuConfig, 'identity'>, FeishuConfig> = z.object({
  identity: z.union(['bot', 'user'] as const).required().description('发送身份；服务器环境推荐 bot（只需应用凭据，无需用户登录）'),
  defaultTarget: Target.description('省略 target 时使用：群 chat_id（oc_…）、用户 open_id（ou_…）或多个群'),
  profile: z.string().pattern(/^[A-Za-z0-9._-]{1,64}$/).description('lark-cli 的命名配置（--profile）'),
  larkPath: z.string().description('lark-cli 可执行文件的绝对路径；默认从 PATH 解析。需指向可执行文件、.exe 或 .js（不支持 Windows 的 .cmd/.bat）'),
  timeoutMs: int().min(1000).max(120_000).default(20_000),
  killGraceMs: int().default(5000),
  retry: z.object({ maxAttempts: int().max(5).default(2) }).default({ maxAttempts: 2 }),
  preflightIntervalMs: int().default(3_600_000).description('检查 lark-cli 身份状态的间隔，0 表示只在启动时检查'),
  dryRun: z.boolean().default(false),
}) as z<ConfigInput<FeishuConfig, 'identity'>, FeishuConfig>
