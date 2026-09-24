/**
 * `@mc/dsh-agent-kit/entry`：业务包静态清单模块（`dsh.agentKit.entries`）使用的轻量入口，
 * 只含条目的类型与 `defineEntry`，不加载任何 Service。
 */
export {
  defineEntry,
  type AgentKitEntry,
  type EntryCheckContext,
  type EntryCheckResult,
  type EntryField,
  type EntryFieldKind,
  type EntrySecret,
} from './admin/entry.js'
export type { CheckResult, CheckStatus } from './checks/types.js'
export type { FieldError, KitId } from './profile/kit-entries.js'
