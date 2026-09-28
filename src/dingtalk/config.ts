import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'
import type { DingtalkIdentity, DingtalkTarget } from './args.js'

export interface DingtalkConfig {
  identity: DingtalkIdentity
  defaultTarget?: DingtalkTarget
  /** 设置页维护的群 ID → 业务插件 ID；群名只作展示，不参与匹配。 */
  groupRoutes: Array<{ conversationId: string; pluginId: string }>
  /**
   * dws 可执行文件的绝对路径；默认从 PATH 解析。必须指向可直接执行的二进制或脚本（例如
   * `dws`、`dws.exe`、`dws.js`）——不支持 Windows 的 `.cmd`/`.bat` 包装脚本，因为本包用
   * `spawn(..., { shell: false })` 不经过 shell 启动子进程，无法解释 `.cmd` 内的批处理语法。
   */
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
])

export const DingtalkConfig: z<ConfigInput<DingtalkConfig>, DingtalkConfig> = z.object({
  identity: z.const('user').default('user').description('仅支持已登录的 user 身份'),
  defaultTarget: Target.description('省略 target 时使用'),
  groupRoutes: z.array(z.object({ conversationId: z.string().required(), pluginId: z.string().required() })).default([]).description('群 ID 到业务插件 ID 的一对一路由；可在 Agent Kit 设置页配置'),
  dwsPath: z.string().description('dws 可执行文件的绝对路径；默认从 PATH 解析。需指向可执行文件、.exe 或 .js（不支持 Windows 的 .cmd/.bat，因为不经过 shell 启动子进程）'),
  timeoutMs: int().min(1000).max(120_000).default(15_000),
  killGraceMs: int().default(5000),
  retry: z.object({ maxAttempts: int().max(5).default(2) }).default({ maxAttempts: 2 }),
  preflightIntervalMs: int().default(3_600_000).description('检查 dws 登录态的间隔，0 表示只在启动时检查'),
  dryRun: z.boolean().default(false),
}) as z<ConfigInput<DingtalkConfig>, DingtalkConfig>
