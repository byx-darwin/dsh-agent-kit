import type { FeishuResolvedTarget } from './args.js'
import { FeishuSendError } from './errors.js'

export interface FeishuTargetResult {
  target: FeishuResolvedTarget
  ok: boolean
  messageId?: string
  error?: FeishuSendError
}

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析 `lark-cli ... --format=json` 成功退出时的 stdout。成功信封为 `{ ok: true, data: {...} }`，
 * dry-run 为 `{ ok: true, dry_run: true, data: { api: [...] } }`。判断成功只看 `ok`，不看 `code`
 * （lark-cli 的输出契约：`code` 只出现在错误信封里）。
 */
export function parseFeishuOutput(stdout: string): { ok: boolean; messageId?: string; data?: Json } {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new FeishuSendError('bad_output', 'lark-cli output is not valid JSON')
  }
  if (!isObject(data)) throw new FeishuSendError('bad_output', 'lark-cli output is not a JSON object')
  if (data.ok !== true) return { ok: false }
  const payload = isObject(data.data) ? data.data : undefined
  const messageId = typeof payload?.message_id === 'string' ? payload.message_id : undefined
  return { ok: true, ...(messageId ? { messageId } : {}), ...(payload ? { data: payload } : {}) }
}

/** 错误信封写在 stderr：`{ ok: false, error: { type, subtype, code, message, hint } }`。 */
export function parseFeishuError(stderr: string): { type?: string; subtype?: string; message: string; hint?: string } {
  try {
    const data = JSON.parse(stderr) as unknown
    if (isObject(data) && isObject(data.error)) {
      const e = data.error
      return {
        ...(typeof e.type === 'string' ? { type: e.type } : {}),
        ...(typeof e.subtype === 'string' ? { subtype: e.subtype } : {}),
        message: typeof e.message === 'string' ? e.message : 'lark-cli failed',
        ...(typeof e.hint === 'string' ? { hint: e.hint } : {}),
      }
    }
  } catch {
    // 非 JSON 的 stderr
  }
  return { message: stderr.trim() || 'lark-cli failed' }
}

/** `lark-cli auth status --json` 中指定身份是否可用。 */
export function identityAvailable(stdout: string, identity: 'bot' | 'user'): { ok: boolean; detail: string; userName?: string; openId?: string } {
  try {
    const data = JSON.parse(stdout) as { identities?: Record<string, { available?: boolean; message?: string; userName?: string; openId?: string }> }
    const entry = data.identities?.[identity]
    if (entry?.available === true) {
      return { ok: true, detail: entry.message ?? `${identity} identity ready`, ...(entry.userName ? { userName: entry.userName } : {}), ...(entry.openId ? { openId: entry.openId } : {}) }
    }
    return { ok: false, detail: entry?.message ?? `${identity} identity is not available` }
  } catch {
    return { ok: false, detail: 'lark-cli auth status output is not valid JSON' }
  }
}
