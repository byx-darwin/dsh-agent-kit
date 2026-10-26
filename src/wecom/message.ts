import type { WecomTarget } from './config.js'
import { WecomSendError } from './errors.js'

export interface WecomAt {
  /** 要 @ 的成员 userid。 */
  userIds?: string[]
  all?: boolean
}

/** `markdown.content` 上限（UTF-8 字节，官方文档）。 */
export const MAX_CONTENT_BYTES = 20480

const ID = /^[\x21-\x7e]{1,128}$/

export function assertWecomId(kind: string, value: unknown): string {
  if (typeof value !== 'string' || value.startsWith('-') || !ID.test(value)) {
    throw new WecomSendError('invalid_target', `invalid ${kind}`, { details: { kind } })
  }
  return value
}

/** 群为 chatid；单聊的 chatid 是对方 userid。 */
export function resolveTarget(target: WecomTarget | undefined): { chatid: string; conversationId: string; chatType: 'group' | 'single' } {
  if (!target) throw new WecomSendError('invalid_target', 'target is required')
  if ('chatId' in target) {
    const id = assertWecomId('chatId', target.chatId)
    return { chatid: id, conversationId: id, chatType: 'group' }
  }
  const id = assertWecomId('userId', target.userId)
  return { chatid: id, conversationId: id, chatType: 'single' }
}

/** 主动发送与回复都只发 Markdown；`text` 原样作为 Markdown 内容，`title` 为加粗首行。 */
export function buildContent(input: { title?: string; markdown?: string; text?: string; at?: WecomAt }): string {
  if (input.markdown !== undefined && input.text !== undefined) throw new WecomSendError('invalid_target', 'markdown and text are mutually exclusive')
  if (input.markdown === undefined && input.text === undefined) throw new WecomSendError('invalid_target', 'either markdown or text is required')
  const body = (input.markdown ?? input.text)!
  const mentions = [...(input.at?.userIds ?? []).map((id) => assertWecomId('userId', id)), ...(input.at?.all ? ['all'] : [])].map((id) => `<@${id}>`).join(' ')
  const head = input.title ? `**${input.title}**\n\n` : ''
  const content = `${head}${body}${mentions ? ` ${mentions}` : ''}`
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) throw new WecomSendError('invalid_target', `content exceeds ${MAX_CONTENT_BYTES} bytes`)
  return content
}
