/** 通知渠道：钉钉（dws）与飞书（lark-cli）。 */
export type ChannelName = 'dingtalk' | 'feishu'
export const CHANNEL_NAMES: readonly ChannelName[] = ['dingtalk', 'feishu']

/** 渠道的登录状态（实时检查 CLI 得到，不是缓存）。 */
export interface ChannelStatus {
  channel: ChannelName
  /** 配置的发送身份。 */
  identity: string
  /** 该身份当前能否发送：已登录（user）或应用 / 机器人可用（bot）。 */
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

/** CLI 未给出有效期时使用的默认值：钉钉与飞书的设备码都是 15 分钟。 */
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
