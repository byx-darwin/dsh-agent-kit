import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { restrictWindowsAcl } from '../secrets/credentials-file.js'
import type { DingtalkAtMessage } from './inbox.js'

const MAX_RECORDS = 200
const PREVIEW_LENGTH = 240
const NAME_TTL_MS = 10 * 60_000

/** 仅保存用于补充路由的消息摘要；正文不会完整落盘。 */
export interface DingtalkUnmatchedMessage {
  eventId: string
  messageId?: string
  conversationId: string
  groupName?: string
  senderOpenDingtalkId?: string
  preview: string
  receivedAt: number
  timestamp?: number
}

function validRecord(value: unknown): value is DingtalkUnmatchedMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return typeof r.eventId === 'string' && !!r.eventId && typeof r.conversationId === 'string' && !!r.conversationId &&
    typeof r.preview === 'string' && typeof r.receivedAt === 'number' && Number.isFinite(r.receivedAt) &&
    (r.groupName === undefined || typeof r.groupName === 'string')
}

export class DingtalkUnmatchedStore {
  private items: DingtalkUnmatchedMessage[] = []
  private loaded?: Promise<void>
  private writing: Promise<void> = Promise.resolve()
  private readonly names = new Map<string, { name?: string; until: number }>()

  constructor(
    private readonly file: string | undefined,
    private readonly resolveName: (conversationId: string) => Promise<string | undefined>,
    private readonly onError: (error: unknown) => void,
  ) {}

  private load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      if (!this.file) return
      try {
        const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(parsed)) throw new Error('invalid unmatched message file')
        this.items = parsed.filter(validRecord).slice(-MAX_RECORDS)
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

  async list(): Promise<DingtalkUnmatchedMessage[]> {
    await this.load()
    await this.writing.catch(() => {})
    return this.items.slice().reverse().map((item) => ({ ...item }))
  }

  async add(message: DingtalkAtMessage): Promise<void> {
    await this.load()
    if (this.items.some((item) => item.eventId === message.eventId)) return
    const cached = this.names.get(message.conversationId)
    const record: DingtalkUnmatchedMessage = {
      eventId: message.eventId,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      conversationId: message.conversationId,
      ...(cached?.name ? { groupName: cached.name } : {}),
      ...(message.senderOpenDingtalkId ? { senderOpenDingtalkId: message.senderOpenDingtalkId } : {}),
      preview: Array.from(message.content).slice(0, PREVIEW_LENGTH).join(''),
      receivedAt: Date.now(),
      ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
    }
    this.items.push(record)
    if (this.items.length > MAX_RECORDS) this.items.shift()
    await this.persist()
    if (cached && cached.until > Date.now()) return
    // 群资料查询失败不影响消息接收或已有的未命中记录。
    this.names.set(message.conversationId, { until: Date.now() + 60_000 })
    void this.resolveName(message.conversationId).then(async (name) => {
      this.names.set(message.conversationId, { name, until: Date.now() + (name ? NAME_TTL_MS : 60_000) })
      if (!name) return
      for (const item of this.items) if (item.conversationId === message.conversationId) item.groupName = name
      await this.persist()
    }).catch(this.onError)
  }
}
