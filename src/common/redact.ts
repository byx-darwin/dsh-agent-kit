import { createHash } from 'node:crypto'

/** 日志与错误中单段文本的最大长度，超出部分截断。 */
export const MAX_TEXT_LENGTH = 2000

const secrets = new Map<string, number>()

/**
 * 登记一个已知密钥值（WebSocket 鉴权头、Jev API Key、webhook token 等）。
 * 之后所有经过 {@link redact} 的文本中出现该值都会被替换。返回注销函数。
 */
export function registerSecret(value: string | undefined | null): () => void {
  // 过短的值精确替换会误伤普通文本，且本身不构成有效凭据
  if (!value || value.length < 4) return () => {}
  secrets.set(value, (secrets.get(value) ?? 0) + 1)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const count = (secrets.get(value) ?? 1) - 1
    if (count <= 0) secrets.delete(value)
    else secrets.set(value, count)
  }
}

/** 按已知密钥值精确替换并截断长文本。所有日志与错误对象都经过这个函数。 */
export function redact(text: string, maxLength = MAX_TEXT_LENGTH): string {
  let result = text
  // 先替换较长的值，避免一个密钥是另一个的子串时残留片段
  const values = [...secrets.keys()].sort((a, b) => b.length - a.length)
  for (const value of values) {
    if (result.includes(value)) result = result.split(value).join('[REDACTED]')
  }
  if (result.length > maxLength) {
    result = `${result.slice(0, maxLength)}…[truncated ${result.length - maxLength} chars]`
  }
  return result
}

/** 消息正文、WebSocket 帧、Agent 原始输出只记录长度与哈希。 */
export function digest(data: string | Buffer | Uint8Array): { length: number; sha256: string } {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 16)
  return { length: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength, sha256: hash }
}

/** 把任意值（常见为 Error）转成已脱敏的纯数据，用于 `cause` 与日志字段。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (depth > 3) return '[depth exceeded]'
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redact(value.message) }
    const code = (value as { code?: unknown }).code
    if (code !== undefined) out.code = redactValue(code, depth + 1)
    const status = (value as { status?: unknown }).status
    if (typeof status === 'number') out.status = status
    if (value.cause !== undefined) out.cause = redactValue(value.cause, depth + 1)
    return out
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      out[k] = /authorization|token|secret|api[-_]?key|password|cookie/i.test(k) ? '[REDACTED]' : redactValue(v, depth + 1)
    }
    return out
  }
  return redact(String(value))
}

/** 仅供测试：清空已登记的密钥。 */
export function clearSecretsForTesting(): void {
  secrets.clear()
}
