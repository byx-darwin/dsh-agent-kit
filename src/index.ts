export { KitError, ConfigError, isKitError, type ConfigInput, type KitErrorOptions, type ServiceName } from './common/errors.js'
export { redact, registerSecret, digest } from './common/redact.js'
export type { HealthStatus, ServiceHealth, ServiceFailedEvent } from './common/service.js'

export { AgentWsService, WsConfig, WsError, type AgentWsHandle, type AgentWsCounters, type ConnectOptions, type ConnectionState, type HeadersInit, type MessageContext } from './ws/index.js'
export {
  DingtalkService,
  DingtalkConfig,
  DingtalkSendError,
  type DingtalkAt,
  type DingtalkCounters,
  type DingtalkErrorCode,
  type DingtalkIdentity,
  type DingtalkSendOptions,
  type DingtalkSendResult,
  type DingtalkTarget,
  type TargetResult,
} from './dingtalk/index.js'
export {
  AgentTasksService,
  AgentTasksConfig,
  AgentTaskError,
  untrusted,
  isUntrusted,
  extractJson,
  type AgentTaskErrorCode,
  type AgentTaskEvent,
  type AgentTaskResult,
  type AgentTasksCounters,
  type Permissions,
  type PromptPart,
  type UntrustedBlock,
} from './agent-tasks/index.js'
export {
  JevService,
  JevConfig,
  JevError,
  choice,
  noul,
  score,
  type Answers,
  type ChoiceQuestion,
  type ChoiceResponse,
  type EntryType,
  type JevErrorCode,
  type JudgeOptions,
  type JudgeResult,
  type NoulQuestion,
  type NoulResponse,
  type Question,
  type Questions,
  type ScoreQuestion,
  type ScoreResponse,
} from './jev/index.js'

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
export { describeSecretRef, isSecretRef, readCredential, resolveSecretRef, type SecretRefSource } from './secrets/index.js'
