import type { ChannelAtMessage } from '../common/channel.js'

/** 群内 @ 机器人或私聊机器人的消息。正文是外部输入，业务插件必须自行校验。 */
export interface FeishuAtMessage extends ChannelAtMessage {
  chatType: 'p2p' | 'group'
  /** 飞书原始消息类型，如 `text`、`post`、`image`。 */
  messageType: string
  mentions: Array<{ openId: string; name: string }>
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function postText(content: Record<string, unknown>): string {
  const localized = obj(content.zh_cn) ?? obj(content.en_us) ?? content
  const lines: string[] = []
  if (str(localized.title)) lines.push(localized.title as string)
  for (const paragraph of Array.isArray(localized.content) ? localized.content : []) {
    const parts = (Array.isArray(paragraph) ? paragraph : []).map((node) => {
      const n = obj(node)
      return n && (n.tag === 'text' || n.tag === 'a') && typeof n.text === 'string' ? n.text : ''
    }).join('')
    if (parts) lines.push(parts)
  }
  return lines.join('\n')
}

/** 解析 `im.message.receive_v1`；结构不合法时返回 undefined。 */
export function parseFeishuEvent(data: unknown, botOpenId?: string): FeishuAtMessage | undefined {
  const root = obj(data)
  const event = obj(root?.event) ?? root
  const message = obj(event?.message)
  if (!message) return undefined
  const messageId = str(message.message_id)
  const chatId = str(message.chat_id)
  const messageType = str(message.message_type)
  if (!messageId || !chatId || !messageType || typeof message.content !== 'string') return undefined
  let content: Record<string, unknown> | undefined
  try {
    content = obj(JSON.parse(message.content))
  } catch {
    return undefined
  }
  if (!content) return undefined
  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).flatMap((m) => {
    const mention = obj(m)
    const openId = str(obj(mention?.id)?.open_id)
    const key = str(mention?.key)
    return openId && key ? [{ key, openId, name: str(mention?.name) ?? '' }] : []
  })
  let text = ''
  if (messageType === 'text' && typeof content.text === 'string') {
    text = content.text
    for (const m of mentions) text = text.split(m.key).join(m.openId === botOpenId ? '' : `@${m.name}`)
    text = text.replace(/\s+/g, ' ').trim()
  } else if (messageType === 'post') {
    text = postText(content)
  }
  const sender = str(obj(obj(event?.sender)?.sender_id)?.open_id)
  const created = Number(message.create_time)
  return {
    eventId: messageId,
    messageId,
    conversationId: chatId,
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    ...(sender ? { senderId: sender } : {}),
    content: text,
    messageType,
    mentions: mentions.map(({ openId, name }) => ({ openId, name })),
    ...(Number.isFinite(created) && created > 0 ? { timestamp: created } : {}),
  }
}
