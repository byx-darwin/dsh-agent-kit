import { KitError, type KitErrorOptions } from '../common/errors.js'

export type FeishuErrorCode = 'invalid_target' | 'auth_failed' | 'permission_denied' | 'rate_limited' | 'timeout' | 'aborted' | 'network' | 'api_error'

const RETRYABLE: ReadonlySet<FeishuErrorCode> = new Set(['rate_limited', 'timeout', 'network'])

export class FeishuSendError extends KitError {
  declare readonly code: FeishuErrorCode

  constructor(code: FeishuErrorCode, message: string, options: KitErrorOptions = {}) {
    super('feishu', code, message, { retryable: options.retryable ?? RETRYABLE.has(code), ...options })
    this.name = 'FeishuSendError'
  }
}

/**
 * 飞书错误码 → 分类。数字来自开放平台通用错误码与「发送消息」接口错误码表：
 * https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
 * https://open.feishu.cn/document/server-docs/im-v1/message/create
 */
const API_CODES: Record<number, FeishuErrorCode> = {
  99991661: 'auth_failed', // token 缺失
  99991663: 'auth_failed', // tenant_access_token 无效或已过期
  99991664: 'auth_failed', // app_access_token 无效
  99991665: 'auth_failed', // tenant_access_token 无效
  10014: 'auth_failed', // 应用未授权或已停用
  10003: 'invalid_target', // 参数无效
  99991672: 'permission_denied', // 应用未开通所需 API 权限范围
  99991400: 'rate_limited', // 请求频率超限
  230020: 'rate_limited', // 发送消息频率超限
  230002: 'permission_denied', // 机器人不在群里
  230006: 'permission_denied', // 机器人能力未启用
  230027: 'permission_denied', // 缺少权限
  230035: 'permission_denied', // 无发送消息权限
  230053: 'permission_denied', // 用户已停止机器人向其发送消息
  230001: 'invalid_target', // 参数错误
  230013: 'invalid_target', // 接收方不在应用可用范围
  230034: 'invalid_target', // receive_id 无效
  232009: 'invalid_target', // 群已解散
  230099: 'invalid_target', // 创建卡片内容失败
}

export function classifyApiCode(code: number, msg: string): FeishuSendError {
  const kind = API_CODES[code] ?? 'api_error'
  return new FeishuSendError(kind, `feishu api error ${code}: ${msg}`, { details: { apiCode: code } })
}

/** SDK 抛出的异常（axios 风格）→ 分类。 */
export function classifyThrown(e: unknown): FeishuSendError {
  if (e instanceof FeishuSendError) return e
  const err = e as { name?: string; code?: string; message?: string; response?: { status?: number; data?: { code?: number; msg?: string } } }
  const status = err?.response?.status
  const apiCode = err?.response?.data?.code
  if (typeof apiCode === 'number' && apiCode !== 0) return classifyApiCode(apiCode, err.response?.data?.msg ?? '')
  if (status === 429) return new FeishuSendError('rate_limited', 'feishu rate limited (HTTP 429)', { cause: e })
  if (status === 401) return new FeishuSendError('auth_failed', 'feishu authentication failed (HTTP 401)', { cause: e })
  if (status === 403) return new FeishuSendError('permission_denied', 'feishu permission denied (HTTP 403)', { cause: e })
  if (typeof status === 'number') return new FeishuSendError('api_error', `feishu HTTP ${status}`, { retryable: status >= 500, cause: e })
  if (err?.name === 'AbortError') return new FeishuSendError('aborted', 'feishu send aborted', { cause: e })
  if (err?.name === 'TimeoutError' || err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
    return new FeishuSendError('timeout', 'feishu request timed out', { cause: e })
  }
  return new FeishuSendError('network', `feishu request failed: ${err?.message ?? String(e)}`, { cause: e })
}
