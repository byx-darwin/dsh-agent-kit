import { DingtalkSendError } from './errors.js'

export type DingtalkIdentity = 'user'

export type DingtalkTarget =
  | { chatId: string }
  | { userId: string }
  | { openDingtalkId: string }

export interface DingtalkAt {
  /** openDingTalkId（群聊）。 */
  openDingtalkIds?: string[]
  all?: boolean
}

export interface BuildArgsInput {
  identity: DingtalkIdentity
  target?: DingtalkTarget
  title?: string
  markdown?: string
  text?: string
  at?: DingtalkAt
  idempotencyKey?: string
  dryRun: boolean
}

const ID_PATTERNS = {
  chatId: /^[A-Za-z0-9+/=_-]{1,128}$/,
  userId: /^[A-Za-z0-9_-]{1,64}$/,
  openDingtalkId: /^[A-Za-z0-9$:+/=_-]{1,128}$/,
  idempotencyKey: /^[A-Za-z0-9._:@-]{1,128}$/,
} as const

function check(kind: keyof typeof ID_PATTERNS, value: unknown): string {
  // 以 - 开头的值即便使用 --key=value 形式也拒绝，作为纵深防御
  if (typeof value !== 'string' || value.startsWith('-') || !ID_PATTERNS[kind].test(value)) {
    throw new DingtalkSendError('invalid_target', `invalid ${kind}`, { details: { kind } })
  }
  return value
}

function checkList(kind: keyof typeof ID_PATTERNS, values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new DingtalkSendError('invalid_target', `${kind} list must be a non-empty array`)
  }
  return [...new Set(values.map((v) => check(kind, v)))]
}

/** 描述一次发送的目标，用于逐目标结果。 */
export type ResolvedTarget = { chatId: string } | { userId: string } | { openDingtalkId: string }

export interface BuiltArgs {
  args: string[]
  targets: ResolvedTarget[]
}

/** 拼装 `dws chat +messages-send` 参数，统一使用 `--key=value` 形式。 */
export function buildSendArgs(input: BuildArgsInput): BuiltArgs {
  const args = ['chat', '+messages-send', `--as=${input.identity}`]
  const targets: ResolvedTarget[] = []
  const target = input.target

  if (input.markdown !== undefined && input.text !== undefined) {
    throw new DingtalkSendError('invalid_target', 'markdown and text are mutually exclusive')
  }
  if (input.markdown === undefined && input.text === undefined) {
    throw new DingtalkSendError('invalid_target', 'either markdown or text is required')
  }

  if (!target) throw new DingtalkSendError('invalid_target', 'target is required')
  if ('chatId' in target) {
    args.push(`--chat-id=${check('chatId', target.chatId)}`)
    targets.push({ chatId: target.chatId })
  } else if ('userId' in target) {
    args.push(`--user=${check('userId', target.userId)}`)
    targets.push({ userId: target.userId })
  } else {
    args.push(`--open-dingtalk-id=${check('openDingtalkId', target.openDingtalkId)}`)
    targets.push({ openDingtalkId: target.openDingtalkId })
  }

  if (input.title !== undefined) args.push(`--title=${input.title}`)
  if (input.markdown !== undefined) args.push(`--markdown=${input.markdown}`)
  if (input.text !== undefined) args.push(`--text=${input.text}`)

  const at = input.at
  if (at) {
    if (at.all) args.push('--at-all')
    if (at.openDingtalkIds?.length) {
      args.push(`--at-open-dingtalk-ids=${checkList('openDingtalkId', at.openDingtalkIds).join(',')}`)
    }
  }

  if (input.idempotencyKey !== undefined) {
    args.push(`--idempotency-key=${check('idempotencyKey', input.idempotencyKey)}`)
  }
  if (input.dryRun) args.push('--dry-run')
  args.push('--yes', '--format=json')
  return { args, targets }
}
