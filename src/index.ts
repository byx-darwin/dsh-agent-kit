export { KitError, ConfigError, isKitError, type ConfigInput, type KitErrorOptions, type ServiceName } from './common/errors.js'
export { redact, registerSecret, digest } from './common/redact.js'
export { BASE_ENV_WHITELIST, pickEnv, runProcess, type RunProcessOptions, type RunProcessResult } from './common/process.js'
export { resolveExecutable } from './common/executable.js'
export { resolveDshHome } from './common/dsh-home.js'
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
  FeishuService,
  FeishuConfig,
  FeishuSendError,
  type FeishuAt,
  type FeishuCounters,
  type FeishuErrorCode,
  type FeishuIdentity,
  type FeishuSendOptions,
  type FeishuSendResult,
  type FeishuTarget,
  type FeishuTargetResult,
} from './feishu/index.js'
export {
  NotifyService,
  NotifyConfig,
  NotifyError,
  NOTIFY_CHANNELS,
  type NotifyChannel,
  type NotifyChannelResult,
  type NotifyCounters,
  type NotifyErrorCode,
  type NotifySendOptions,
  type NotifySendResult,
} from './notify/index.js'
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

export { describeSecretRef, isSecretRef, readCredential, resolveSecretRef, type SecretRefSource } from './secrets/index.js'
