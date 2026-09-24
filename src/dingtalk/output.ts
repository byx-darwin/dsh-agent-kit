import { DingtalkSendError } from './errors.js'
import type { ResolvedTarget } from './args.js'

export interface TargetResult {
  target: ResolvedTarget
  ok: boolean
  messageId?: string
  error?: DingtalkSendError
}

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function findMessageId(v: unknown, depth = 0): string | undefined {
  if (!isObject(v) || depth > 4) return undefined
  for (const key of ['messageId', 'processQueryKey', 'openMsgId', 'msgId']) {
    const value = v[key]
    if (typeof value === 'string' && value) return value
  }
  for (const value of Object.values(v)) {
    const found = findMessageId(value, depth + 1)
    if (found) return found
  }
  return undefined
}

function targetKey(t: ResolvedTarget): string {
  if ('chatId' in t) return t.chatId
  if ('userId' in t) return t.userId
  if ('openDingtalkId' in t) return t.openDingtalkId
  return 'webhook'
}

function describeFailure(entry: unknown): string {
  if (!isObject(entry)) return 'send failed'
  const err = entry.error
  if (typeof err === 'string') return err
  if (isObject(err) && typeof err.message === 'string') return err.message
  if (typeof entry.message === 'string') return entry.message
  if (typeof entry.reason === 'string') return entry.reason
  return 'send failed'
}

/**
 * 解析 `dws chat +messages-send --format=json` 成功退出时的 stdout。
 * - 单目标：`{ ok, identity, result, sendReceipt }`；
 * - bot 多目标（im.batch-write.v1）：`{ succeeded: [{target, result}], failures: [...] }`；
 * - dry-run：`{ dry_run: true, actions: [...] }`。
 */
export function parseSendOutput(stdout: string, targets: ResolvedTarget[], batch: boolean): TargetResult[] {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new DingtalkSendError('bad_output', 'dws output is not valid JSON')
  }
  if (!isObject(data)) throw new DingtalkSendError('bad_output', 'dws output is not a JSON object')

  if (data.dry_run === true) {
    return targets.map((target) => ({ target, ok: true }))
  }

  if (batch || data.contractVersion === 'im.batch-write.v1') {
    const succeeded = data.succeeded
    const failures = data.failures
    if (!Array.isArray(succeeded) || !Array.isArray(failures)) {
      throw new DingtalkSendError('bad_output', 'dws batch output is missing succeeded/failures')
    }
    const byKey = new Map<string, TargetResult>()
    for (const entry of succeeded) {
      if (!isObject(entry) || typeof entry.target !== 'string') continue
      const messageId = findMessageId(entry.result)
      byKey.set(entry.target, { target: { chatId: entry.target }, ok: true, ...(messageId ? { messageId } : {}) })
    }
    for (const entry of failures) {
      if (!isObject(entry) || typeof entry.target !== 'string') continue
      byKey.set(entry.target, {
        target: { chatId: entry.target },
        ok: false,
        error: new DingtalkSendError('send_failed', describeFailure(entry), { details: { target: entry.target } }),
      })
    }
    return targets.map((target) => {
      const found = byKey.get(targetKey(target))
      if (found) return { ...found, target }
      return {
        target,
        ok: false,
        error: new DingtalkSendError('bad_output', 'target missing from dws batch result'),
      }
    })
  }

  const ok = data.ok === true || data.success === true || (isObject(data.result) && data.result.success === true)
  const messageId = findMessageId(data.result) ?? findMessageId(data.sendReceipt)
  return targets.map((target) =>
    ok
      ? { target, ok: true, ...(messageId ? { messageId } : {}) }
      : { target, ok: false, error: new DingtalkSendError('send_failed', describeFailure(data)) },
  )
}

/** 从失败时的 stderr（`{ error: { category, code, message } }`）中取出摘要。 */
export function parseErrorOutput(stderr: string): { category?: string; message: string } {
  try {
    const data = JSON.parse(stderr) as unknown
    if (isObject(data) && isObject(data.error)) {
      return {
        ...(typeof data.error.category === 'string' ? { category: data.error.category } : {}),
        message: typeof data.error.message === 'string' ? data.error.message : 'dws failed',
      }
    }
  } catch {
    // 非 JSON 的 stderr
  }
  return { message: stderr.trim() || 'dws failed' }
}
