/**
 * @mc/dsh-agent-kit-admin：@mc/dsh-agent-kit 的可选运维工具。根入口是常驻插件 `agent-kit-admin`
 * （AgentKitAdmin 远程服务 + dsh Web「设置 → Agent Kit」页）；业务包登记设置入口的类型与
 * `defineEntry` 也从这里（或更轻量的 `@mc/dsh-agent-kit-admin/entry`）导入。
 */
export { name, inject, apply } from './admin/plugin.js'
export type { AgentKitAdmin, AdminStatus, AdminServiceStatus } from './admin/service.js'
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
