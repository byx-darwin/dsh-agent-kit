import { createHash } from 'node:crypto'
import type { FeishuTarget } from './config.js'
import { FeishuSendError } from './errors.js'
import type { FeishuCreateMessageRequest } from './sdk.js'

export interface FeishuAt {
  /** 要 @ 的用户 open_id。 */
  openIds?: string[]
  all?: boolean
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
/** 与钉钉一致：字符集 `[A-Za-z0-9._:@-]`，最长 128。 */
const KEY = /^[A-Za-z0-9._:@-]{1,128}$/
/** 飞书 `uuid` 最长 50 字符。 */
const UUID_MAX = 50

/** 幂等键 → 飞书 `uuid`：不超过 50 字符原样使用，否则取 sha256 十六进制前 32 位（确定性，重试仍能去重）。 */
export function feishuUuid(key: string): string {
  return key.length <= UUID_MAX ? key : createHash('sha256').update(key).digest('hex').slice(0, 32)
}

export function assertFeishuId(kind: string, value: unknown): string {
  if (typeof value !== 'string' || value.startsWith('-') || !ID.test(value)) {
    throw new FeishuSendError('invalid_target', `invalid ${kind}`, { details: { kind } })
  }
  return value
}

function mentions(at: FeishuAt | undefined, card: boolean): string {
  const ids = (at?.openIds ?? []).map((id) => assertFeishuId('openId', id))
  if (at?.all) ids.push('all')
  return ids.map((id) => (card ? `<at id=${id}></at>` : `<at user_id="${id}"></at>`)).join(' ')
}

const join = (body: string, extra: string) => (extra ? `${body} ${extra}` : body)

/** 文本发 `text` 消息；Markdown 发卡片（`interactive`），`title` 作卡片标题。 */
export function buildCreateMessage(input: {
  target?: FeishuTarget
  title?: string
  markdown?: string
  text?: string
  at?: FeishuAt
  idempotencyKey?: string
}): FeishuCreateMessageRequest {
  if (!input.target) throw new FeishuSendError('invalid_target', 'target is required')
  if (input.markdown !== undefined && input.text !== undefined) throw new FeishuSendError('invalid_target', 'markdown and text are mutually exclusive')
  if (input.markdown === undefined && input.text === undefined) throw new FeishuSendError('invalid_target', 'either markdown or text is required')
  const [receive_id_type, receive_id] = 'chatId' in input.target
    ? ['chat_id' as const, assertFeishuId('chatId', input.target.chatId)]
    : ['open_id' as const, assertFeishuId('openId', input.target.openId)]
  if (input.idempotencyKey !== undefined && !KEY.test(input.idempotencyKey)) {
    throw new FeishuSendError('invalid_target', 'invalid idempotencyKey', { details: { kind: 'idempotencyKey' } })
  }
  const uuid = input.idempotencyKey !== undefined ? { uuid: feishuUuid(input.idempotencyKey) } : {}
  if (input.markdown !== undefined) {
    const card = {
      schema: '2.0',
      ...(input.title ? { header: { title: { tag: 'plain_text', content: input.title } } } : {}),
      body: { elements: [{ tag: 'markdown', content: join(input.markdown, mentions(input.at, true)) }] },
    }
    return { params: { receive_id_type }, data: { receive_id, msg_type: 'interactive', content: JSON.stringify(card), ...uuid } }
  }
  const body = input.title ? `${input.title}\n${input.text}` : input.text!
  return { params: { receive_id_type }, data: { receive_id, msg_type: 'text', content: JSON.stringify({ text: join(body, mentions(input.at, false)) }), ...uuid } }
}
