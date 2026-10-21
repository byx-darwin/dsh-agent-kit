import type { ChannelUnmatchedMessage } from './unmatched.js'
export type { ChannelUnmatchedMessage } from './unmatched.js'
import type { KitError } from './errors.js'
import type { HealthStatus } from './service.js'

/** 渠道名称；类型为后续渠道预留，`CHANNEL_NAMES` 只列出已实现的渠道。 */
export type ChannelName = 'dingtalk' | 'feishu' | 'wecom'
export const CHANNEL_NAMES: readonly ChannelName[] = ['dingtalk']

/** 各渠道 `send()` 共有的参数；目标与 @ 由各渠道自己定义。 */
export interface ChannelSendCommon {
  title?: string
  /** Markdown 正文，与 `text` 二选一。 */
  markdown?: string
  text?: string
  idempotencyKey?: string
  traceId?: string
  signal?: AbortSignal
}

/** 逐目标的发送结果。 */
export interface ChannelSendResult {
  results: Array<{ ok: boolean; messageId?: string; error?: KitError }>
}

/**
 * 每个渠道 Service 都实现的约定，`notify` 只通过它转发。
 * `login` / `logout` 可选：只有需要登录的身份（如钉钉 user）才实现，机器人渠道不实现。
 */
export interface ChannelService<Target = unknown, At = unknown> {
  send(options: ChannelSendCommon & { target?: Target; at?: At }): Promise<ChannelSendResult>
  status(): Promise<ChannelStatus>
  health(): { status: HealthStatus; detail: string }
  login?(options?: { signal?: AbortSignal }): Promise<LoginSession>
  logout?(): Promise<ChannelStatus>
}

/** 各渠道群内 @ 消息的公共字段。正文是外部输入，业务插件必须自行校验。 */
export interface ChannelAtMessage {
  /** 去重键。 */
  eventId: string
  messageId?: string
  /** 会话 ID；不要用群名作持久路由键。 */
  conversationId: string
  senderId?: string
  content: string
  timestamp?: number
}

export interface ChannelMessageRoute<M extends ChannelAtMessage = ChannelAtMessage> {
  conversationId: string
  /** 同会话细分规则；省略表示匹配会话内所有 @ 消息。 */
  match?: (message: M) => boolean
  /** 数值大的规则优先；同优先级按注册顺序。默认 0。 */
  priority?: number
}

export type ChannelMessageHandler<M extends ChannelAtMessage = ChannelAtMessage> = (message: M, context: { signal: AbortSignal }) => void | Promise<void>

export interface ChannelMessageSubscription {
  /** 监听就绪后完成；监听启动失败时拒绝。 */
  ready: Promise<void>
  /** 手动注销；调用方插件卸载时也会自动注销。 */
  close(): Promise<void>
}

/** 渠道的登录状态（实时检查 CLI 得到，不是缓存）。 */
export interface ChannelStatus {
  channel: ChannelName
  /** 配置的发送身份。 */
  identity: string
  /** 当前 user 身份是否已登录且可发送。 */
  online: boolean
  /** 登录的账号或应用，CLI 给出时才有。 */
  account?: string
  detail: string
  checkedAt: number
}

/**
 * 一次设备流登录。拿到 `verificationUrl` 后把它交给要登录的人（展示、发消息都可以），对方在浏览器里
 * 授权后 `completed` 以最新状态 resolve；过期、失败或 `cancel()` 时同样 resolve，`online` 为 false。
 */
export interface LoginSession {
  channel: ChannelName
  verificationUrl: string
  /** 需要手工输入时的验证码。 */
  userCode?: string
  /** 授权链接的过期时间（毫秒时间戳），CLI 未给出时按 15 分钟估算。 */
  expiresAt: number
  completed: Promise<ChannelStatus>
  cancel(): void
}

/** CLI 未给出有效期时使用的默认值：钉钉设备码为 15 分钟。 */
export const DEFAULT_LOGIN_TTL_MS = 15 * 60_000

/** 从 CLI 的 JSON 输出里宽松地取字段：先看 `data`，再看顶层。 */
export function pick(obj: unknown, ...keys: string[]): unknown {
  const o = obj as Record<string, unknown> | undefined
  const data = o && typeof o.data === 'object' && o.data !== null ? (o.data as Record<string, unknown>) : undefined
  for (const key of keys) {
    if (data?.[key] !== undefined) return data[key]
    if (o?.[key] !== undefined) return o[key]
  }
  return undefined
}

export type ChannelRecipientKind = 'group' | 'user'

export interface ChannelRecipientSearchResult<T = unknown> {
  candidates: Array<{ name: string; target: T }>
  /** false 表示渠道没有证明已返回全部候选。 */
  complete: boolean
}

/** 接收群内 @ 消息的渠道都实现的约定。 */
export interface ChannelInbox<M extends ChannelAtMessage, U extends ChannelUnmatchedMessage = ChannelUnmatchedMessage, T = unknown> {
  onMessage(route: ChannelMessageRoute<M>, handler: ChannelMessageHandler<M>): ChannelMessageSubscription
  onPluginMessage(pluginId: string, handler: ChannelMessageHandler<M>): ChannelMessageSubscription
  /** 最近未命中任何路由的消息摘要，新记录在前。 */
  unmatchedMessages(): Promise<U[]>
  /** 按名称查找可作为发送目标的群或个人；只返回候选，不自动选择。 */
  searchRecipients(kind: ChannelRecipientKind, query: string): Promise<ChannelRecipientSearchResult<T>>
}
