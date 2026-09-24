import { createHash } from 'node:crypto'
import { FeishuSendError } from './errors.js'

export type FeishuIdentity = 'bot' | 'user'

export type FeishuTarget =
  /** 群 chat_id（`oc_…`）。 */
  | { chatId: string }
  /** 用户 open_id（`ou_…`），发单聊。 */
  | { userId: string }
  /** 多个群；lark-cli 一次只发一个目标，本包逐个发送。 */
  | { chatIds: string[] }

export interface FeishuAt {
  /** 被 @ 的用户 open_id（`ou_…`）。 */
  userIds?: string[]
  all?: boolean
}

/** 单个发送目标。 */
export type FeishuResolvedTarget = { chatId: string } | { userId: string }

const PATTERNS = {
  chatId: /^oc_[A-Za-z0-9_-]{1,120}$/,
  userId: /^ou_[A-Za-z0-9_-]{1,120}$/,
  idempotencyKey: /^[A-Za-z0-9._:@-]{1,128}$/,
} as const

export const MAX_FEISHU_TARGETS = 100
/** lark-cli 的 `--idempotency-key` 最长 50 个字符。 */
const MAX_LARK_KEY = 50

function check(kind: keyof typeof PATTERNS, value: unknown): string {
  // 以 - 开头的值即便使用 --key=value 形式也拒绝，作为纵深防御
  if (typeof value !== 'string' || value.startsWith('-') || !PATTERNS[kind].test(value)) {
    throw new FeishuSendError('invalid_target', `invalid ${kind}`, { details: { kind } })
  }
  return value
}

/** 展开目标为逐个发送的列表（去重）。 */
export function resolveTargets(target: FeishuTarget | undefined): FeishuResolvedTarget[] {
  if (!target) throw new FeishuSendError('invalid_target', 'target is required (or configure defaultTarget)')
  if ('chatId' in target) return [{ chatId: check('chatId', target.chatId) }]
  if ('userId' in target) return [{ userId: check('userId', target.userId) }]
  if (!Array.isArray(target.chatIds) || target.chatIds.length === 0) throw new FeishuSendError('invalid_target', 'chatIds must be a non-empty array')
  const ids = [...new Set(target.chatIds.map((id) => check('chatId', id)))]
  if (ids.length > MAX_FEISHU_TARGETS) throw new FeishuSendError('invalid_target', `at most ${MAX_FEISHU_TARGETS} chats per call`)
  return ids.map((chatId) => ({ chatId }))
}

export function targetId(t: FeishuResolvedTarget): string {
  return 'chatId' in t ? t.chatId : t.userId
}

/**
 * 逐目标的幂等键：lark-cli 限 50 个字符，且同一个键在 1 小时内只发送一次——多个目标必须各用一个键，
 * 否则只有第一个目标能收到。单目标且不超长时原样使用，便于在飞书侧对账。
 */
export function targetIdempotencyKey(key: string, target: FeishuResolvedTarget, targetCount: number): string {
  check('idempotencyKey', key)
  if (targetCount === 1 && key.length <= MAX_LARK_KEY) return key
  return createHash('sha256').update(`${key}\n${targetId(target)}`).digest('hex').slice(0, 40)
}

function mentions(at: FeishuAt | undefined): string {
  if (!at) return ''
  const tags = (at.userIds ?? []).map((id) => `<at user_id="${check('userId', id)}"></at>`)
  if (at.all) tags.push('<at user_id="all"></at>')
  return tags.length ? ` ${tags.join(' ')}` : ''
}

export interface BuildFeishuArgsInput {
  identity: FeishuIdentity
  profile?: string
  target: FeishuResolvedTarget
  title?: string
  markdown?: string
  text?: string
  at?: FeishuAt
  idempotencyKey?: string
  dryRun: boolean
}

/**
 * 拼装 `lark-cli im +messages-send` 参数，统一使用 `--key=value` 形式。飞书的 markdown 消息没有
 * 独立标题：给了 `title` 时作为首行加粗（markdown）或首行文本（text）。
 */
export function buildFeishuArgs(input: BuildFeishuArgsInput): string[] {
  if (input.markdown !== undefined && input.text !== undefined) throw new FeishuSendError('invalid_target', 'markdown and text are mutually exclusive')
  if (input.markdown === undefined && input.text === undefined) throw new FeishuSendError('invalid_target', 'either markdown or text is required')
  const args = [...(input.profile ? [`--profile=${input.profile}`] : []), 'im', '+messages-send', `--as=${input.identity}`]
  const t = input.target
  args.push('chatId' in t ? `--chat-id=${check('chatId', t.chatId)}` : `--user-id=${check('userId', t.userId)}`)
  const at = mentions(input.at)
  if (input.markdown !== undefined) args.push(`--markdown=${input.title ? `**${input.title}**\n\n` : ''}${input.markdown}${at}`)
  else args.push(`--text=${input.title ? `${input.title}\n` : ''}${input.text}${at}`)
  if (input.idempotencyKey !== undefined) args.push(`--idempotency-key=${input.idempotencyKey}`)
  if (input.dryRun) args.push('--dry-run')
  args.push('--format=json')
  return args
}
