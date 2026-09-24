import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'

export type Permissions = 'read-only' | 'workspace-write'

export interface AgentTasksConfig {
  workspaceDir: string
  defaultTimeoutMs: number
  maxConcurrency: number
  maxQueueSize: number
  keepWorkdir: boolean
  /**
   * 不支持工具过滤的 provider（如 claude-code、codex）的权限上限，由运维按该 provider 实例的
   * 配置声明。未声明的 provider 不能运行任务（fail-closed）。
   */
  declaredPermissions: Record<string, Permissions>
  /** 支持工具过滤的 provider 使用的工具白名单。 */
  toolAllowlist: Record<Permissions, string[]>
}

const int = () => z.natural().step(1)
const PermissionsSchema = z.union(['read-only', 'workspace-write'] as const)

export const DEFAULT_TOOL_ALLOWLIST: Record<Permissions, string[]> = {
  'read-only': ['read', 'read_image', 'glob', 'grep', 'todo_write'],
  'workspace-write': ['read', 'read_image', 'glob', 'grep', 'todo_write', 'write', 'edit', 'str_replace_editor'],
}

export const AgentTasksConfig: z<ConfigInput<AgentTasksConfig, 'workspaceDir'>, AgentTasksConfig> = z.object({
  workspaceDir: z.string().required().description('任务工作目录的根，专用目录，不得是业务代码目录'),
  defaultTimeoutMs: int().min(10_000).max(3_600_000).default(600_000),
  maxConcurrency: int().min(1).max(16).default(2),
  maxQueueSize: int().default(100),
  keepWorkdir: z.boolean().default(false),
  declaredPermissions: z.dict(PermissionsSchema).default({}),
  toolAllowlist: z
    .object({
      'read-only': z.array(z.string()).default(DEFAULT_TOOL_ALLOWLIST['read-only']),
      'workspace-write': z.array(z.string()).default(DEFAULT_TOOL_ALLOWLIST['workspace-write']),
    })
    .default(DEFAULT_TOOL_ALLOWLIST),
}) as z<ConfigInput<AgentTasksConfig, 'workspaceDir'>, AgentTasksConfig>

const RANK: Record<Permissions, number> = { 'read-only': 0, 'workspace-write': 1 }

export function permissionAllows(granted: Permissions, requested: Permissions): boolean {
  return RANK[granted] <= RANK[requested]
}
