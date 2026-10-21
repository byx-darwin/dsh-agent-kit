import { UnmatchedStore, type ChannelUnmatchedMessage } from '../common/unmatched.js'
import type { DingtalkAtMessage } from './inbox.js'

/** 钉钉的未命中记录：在公共字段之外保留旧字段名 `groupName`、`senderOpenDingtalkId`。 */
export interface DingtalkUnmatchedMessage extends ChannelUnmatchedMessage {
  groupName?: string
  senderOpenDingtalkId?: string
}

function fromLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const { groupName, senderOpenDingtalkId, ...rest } = raw
  return {
    ...rest,
    ...(rest.conversationName === undefined && typeof groupName === 'string' ? { conversationName: groupName } : {}),
    ...(rest.senderId === undefined && typeof senderOpenDingtalkId === 'string' ? { senderId: senderOpenDingtalkId } : {}),
  }
}

function withLegacyNames(record: ChannelUnmatchedMessage): DingtalkUnmatchedMessage {
  return {
    ...record,
    ...(record.conversationName !== undefined ? { groupName: record.conversationName } : {}),
    ...(record.senderId !== undefined ? { senderOpenDingtalkId: record.senderId } : {}),
  }
}

export class DingtalkUnmatchedStore {
  private readonly store: UnmatchedStore

  constructor(
    file: string | undefined,
    resolveName: (conversationId: string) => Promise<string | undefined>,
    onError: (error: unknown) => void,
  ) {
    this.store = new UnmatchedStore(file, resolveName, onError, fromLegacy)
  }

  async list(): Promise<DingtalkUnmatchedMessage[]> {
    return (await this.store.list()).map(withLegacyNames)
  }

  add(message: DingtalkAtMessage): Promise<void> {
    return this.store.add(message)
  }
}
