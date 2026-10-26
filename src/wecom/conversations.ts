import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { restrictWindowsAcl } from '../secrets/credentials-file.js'

/** 与机器人说过话的会话：只有这些会话能被主动发送。 */
export interface WecomConversation {
  conversationId: string
  chatType: 'group' | 'single'
  lastSenderId?: string
  lastMessageAt: number
}

export const MAX_CONVERSATIONS = 500

function valid(v: unknown): v is WecomConversation {
  const r = v as Record<string, unknown> | null
  return !!r && typeof r === 'object' && typeof r.conversationId === 'string' && !!r.conversationId &&
    (r.chatType === 'group' || r.chatType === 'single') && typeof r.lastMessageAt === 'number' && Number.isFinite(r.lastMessageAt) &&
    (r.lastSenderId === undefined || typeof r.lastSenderId === 'string')
}

/** 最多 500 条、按最后发言时间淘汰；文件 0600，写法与 UnmatchedStore 相同。 */
export class ConversationStore {
  private items = new Map<string, WecomConversation>()
  private loaded?: Promise<void>
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string | undefined,
    private readonly onError: (error: unknown) => void,
  ) {}

  private load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      if (!this.file) return
      try {
        const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(parsed)) throw new Error('invalid wecom conversation file')
        for (const item of parsed.filter(valid)) this.items.set(item.conversationId, item)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error)
      }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve()
    const snapshot = JSON.stringify([...this.items.values()])
    const write = this.writing.catch(() => {}).then(async () => {
      await writeFileAtomic(this.file!, snapshot, { mode: 0o600, dirMode: 0o700 })
      if (process.platform === 'win32') await restrictWindowsAcl(this.file!, { onWarning: this.onError })
    })
    this.writing = write
    return write
  }

  async record(entry: Omit<WecomConversation, 'lastMessageAt'> & { at?: number }): Promise<void> {
    await this.load()
    const { at, ...rest } = entry
    this.items.set(rest.conversationId, { ...this.items.get(rest.conversationId), ...rest, lastMessageAt: at ?? Date.now() })
    if (this.items.size > MAX_CONVERSATIONS) {
      const oldest = [...this.items.values()].sort((a, b) => a.lastMessageAt - b.lastMessageAt).slice(0, this.items.size - MAX_CONVERSATIONS)
      for (const item of oldest) this.items.delete(item.conversationId)
    }
    await this.persist()
  }

  async has(conversationId: string): Promise<boolean> {
    await this.load()
    return this.items.has(conversationId)
  }

  /** 最近发言的在前。 */
  async list(): Promise<WecomConversation[]> {
    await this.load()
    await this.writing.catch(() => {})
    return [...this.items.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt).map((item) => ({ ...item }))
  }
}
