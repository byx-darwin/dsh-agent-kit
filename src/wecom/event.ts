import type { ChannelAtMessage } from '../common/channel.js'
import type { WecomFrame } from './sdk.js'

/** 群内 @ 机器人或单聊机器人的消息。正文是外部输入，业务插件必须自行校验；userid 可能是加密 ID，不要假设格式。 */
export interface WecomAtMessage extends ChannelAtMessage {
  chatType: 'group' | 'single'
  messageType: string
  /** 被引用消息的文字。 */
  quote?: string
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function textOf(body: Record<string, unknown>, type: unknown): string {
  if (type === 'text') return String(obj(body.text)?.content ?? '')
  if (type === 'voice') return String(obj(body.voice)?.content ?? '')
  if (type === 'mixed') {
    const items = obj(body.mixed)?.msg_item
    return (Array.isArray(items) ? items : []).flatMap((item) => {
      const i = obj(item)
      return i?.msgtype === 'text' && typeof obj(i.text)?.content === 'string' ? [obj(i.text)!.content as string] : []
    }).join('\n')
  }
  return ''
}

function tidy(text: string): string {
  return text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').trim()
}

/** 解析消息帧；结构不合法时返回 undefined。返回原始帧供回复使用。 */
export function parseWecomFrame(input: unknown): { message: WecomAtMessage; frame: WecomFrame } | undefined {
  const frame = obj(input)
  const headers = obj(frame?.headers)
  const body = obj(frame?.body)
  if (!frame || !headers || typeof headers.req_id !== 'string' || !body) return undefined
  const msgid = str(body.msgid)
  const sender = str(obj(body.from)?.userid)
  const messageType = str(body.msgtype)
  const chatType = body.chattype === 'group' ? 'group' : body.chattype === 'single' ? 'single' : undefined
  if (!msgid || !sender || !messageType || !chatType) return undefined
  const chatid = str(body.chatid)
  if (chatType === 'group' && !chatid) return undefined
  let content = textOf(body, messageType)
  // 群消息开头是 @机器人；只去掉开头这一个
  if (chatType === 'group') content = content.replace(/^\s*@\S+\s*/, '')
  const quoteBody = obj(body.quote)
  const quote = quoteBody ? tidy(textOf(quoteBody, quoteBody.msgtype)) : ''
  const created = Number(body.create_time)
  const message: WecomAtMessage = {
    eventId: msgid,
    messageId: msgid,
    conversationId: chatType === 'group' ? chatid! : sender,
    chatType,
    senderId: sender,
    content: tidy(content),
    messageType,
    ...(quote ? { quote } : {}),
    ...(Number.isFinite(created) && created > 0 ? { timestamp: created < 1e12 ? created * 1000 : created } : {}),
  }
  return { message, frame: frame as unknown as WecomFrame }
}
