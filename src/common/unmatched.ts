import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { restrictWindowsAcl } from '../secrets/credentials-file.js'
import type { ChannelAtMessage } from './channel.js'

export const UNMATCHED_MAX_RECORDS = 200
export const UNMATCHED_PREVIEW_LENGTH = 240
const NAME_TTL_MS = 10 * 60_000
const NAME_RETRY_MS = 60_000

/** 未命中任何路由的消息摘要，供设置页补充路由；正文不会完整落盘。 */
export interface ChannelUnmatchedMessage {
  eventId: string
  messageId?: string
  conversationId: string
  conversationName?: string
  senderId?: string
  preview: string
  receivedAt: number
  timestamp?: number
}

/** 不把明文账号放进文件名。 */
export function unmatchedFileKey(account: string): string {
  return createHash('sha256').update(account).digest('hex').slice(0, 24)
}

function validRecord(value: unknown): value is ChannelUnmatchedMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return typeof r.eventId === 'string' && !!r.eventId && typeof r.conversationId === 'string' && !!r.conversationId &&
    typeof r.preview === 'string' && typeof r.receivedAt === 'number' && Number.isFinite(r.receivedAt) &&
    (r.conversationName === undefined || typeof r.conversationName === 'string') &&
    (r.senderId === undefined || typeof r.senderId === 'string')
}

/**
 * 按渠道、按账号保存最近的未命中消息（最多 200 条，预览 240 字，文件 0600）。
 * `legacy` 把旧格式的记录转换为当前字段，在校验之前调用。
 */
export class UnmatchedStore {
  private items: ChannelUnmatchedMessage[] = []
  private loaded?: Promise<void>
  private writing: Promise<void> = Promise.resolve()
  private readonly names = new Map<string, { name?: string; until: number }>()

  constructor(
    private readonly file: string | undefined,
    private readonly resolveName: (conversationId: string) => Promise<string | undefined>,
    private readonly onError: (error: unknown) => void,
    private readonly legacy: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw,
  ) {}

  private load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      if (!this.file) return
      try {
        const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(parsed)) throw new Error('invalid unmatched message file')
        this.items = parsed
          .map((raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? this.legacy(raw as Record<string, unknown>) : raw))
          .filter(validRecord)
          .slice(-UNMATCHED_MAX_RECORDS)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error)
      }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve()
    const snapshot = JSON.stringify(this.items)
    const write = this.writing.catch(() => {}).then(async () => {
      await writeFileAtomic(this.file!, snapshot, { mode: 0o600, dirMode: 0o700 })
      if (process.platform === 'win32') await restrictWindowsAcl(this.file!, { onWarning: this.onError })
    })
    this.writing = write
    return write
  }

  async list(): Promise<ChannelUnmatchedMessage[]> {
    await this.load()
    await this.writing.catch(() => {})
    return this.items.slice().reverse().map((item) => ({ ...item }))
  }

  async add(message: ChannelAtMessage): Promise<void> {
    await this.load()
    if (this.items.some((item) => item.eventId === message.eventId)) return
    const cached = this.names.get(message.conversationId)
    const record: ChannelUnmatchedMessage = {
      eventId: message.eventId,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      conversationId: message.conversationId,
      ...(cached?.name ? { conversationName: cached.name } : {}),
      ...(message.senderId ? { senderId: message.senderId } : {}),
      preview: Array.from(message.content).slice(0, UNMATCHED_PREVIEW_LENGTH).join(''),
      receivedAt: Date.now(),
      ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
    }
    this.items.push(record)
    if (this.items.length > UNMATCHED_MAX_RECORDS) this.items.shift()
    await this.persist()
    if (cached && cached.until > Date.now()) return
    // 会话资料查询失败不影响消息接收或已有的未命中记录。
    this.names.set(message.conversationId, { until: Date.now() + NAME_RETRY_MS })
    void this.resolveName(message.conversationId).then(async (name) => {
      this.names.set(message.conversationId, { name, until: Date.now() + (name ? NAME_TTL_MS : NAME_RETRY_MS) })
      if (!name) return
      for (const item of this.items) if (item.conversationId === message.conversationId) item.conversationName = name
      await this.persist()
    }).catch(this.onError)
  }
}
