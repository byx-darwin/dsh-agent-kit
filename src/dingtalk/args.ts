import { DingtalkSendError } from './errors.js'

export type DingtalkIdentity = 'user' | 'bot' | 'webhook'

export type DingtalkTarget =
  | { chatId: string }
  | { userId: string }
  | { openDingtalkId: string }
  /** 仅 bot 身份：多群发送，最多 100 个。 */
  | { chatIds: string[] }

export interface DingtalkAt {
  /** 钉钉 userId（bot / webhook 身份）。 */
  userIds?: string[]
  /** openDingTalkId（user / bot 群聊）。 */
  openDingtalkIds?: string[]
  /** 手机号（仅 webhook）。 */
  mobiles?: string[]
  all?: boolean
}

export interface BuildArgsInput {
  identity: DingtalkIdentity
  robotCode?: string
  webhookToken?: string
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
  robotCode: /^[A-Za-z0-9_-]{1,128}$/,
  mobile: /^\+?[0-9-]{5,20}$/,
  idempotencyKey: /^[A-Za-z0-9._:@-]{1,128}$/,
} as const

export const MAX_BOT_GROUPS = 100

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
export type ResolvedTarget = { chatId: string } | { userId: string } | { openDingtalkId: string } | { webhook: true }

export interface BuiltArgs {
  args: string[]
  targets: ResolvedTarget[]
  /** 返回逐目标 ledger（bot）。 */
  batch: boolean
}

/** 拼装 `dws chat +messages-send` 参数，统一使用 `--key=value` 形式。 */
export function buildSendArgs(input: BuildArgsInput): BuiltArgs {
  const args = ['chat', '+messages-send', `--as=${input.identity}`]
  const targets: ResolvedTarget[] = []
  let batch = false
  const target = input.target

  if (input.markdown !== undefined && input.text !== undefined) {
    throw new DingtalkSendError('invalid_target', 'markdown and text are mutually exclusive')
  }
  if (input.markdown === undefined && input.text === undefined) {
    throw new DingtalkSendError('invalid_target', 'either markdown or text is required')
  }

  switch (input.identity) {
    case 'user': {
      if (!target) throw new DingtalkSendError('invalid_target', 'target is required for user identity')
      if ('chatId' in target) {
        args.push(`--chat-id=${check('chatId', target.chatId)}`)
        targets.push({ chatId: target.chatId })
      } else if ('userId' in target) {
        args.push(`--user=${check('userId', target.userId)}`)
        targets.push({ userId: target.userId })
      } else if ('openDingtalkId' in target) {
        args.push(`--open-dingtalk-id=${check('openDingtalkId', target.openDingtalkId)}`)
        targets.push({ openDingtalkId: target.openDingtalkId })
      } else {
        throw new DingtalkSendError('invalid_target', 'chatIds is only supported for bot identity')
      }
      break
    }
    case 'bot': {
      if (!target) throw new DingtalkSendError('invalid_target', 'target is required for bot identity')
      args.push(`--robot-code=${check('robotCode', input.robotCode)}`)
      batch = true
      if ('chatId' in target || 'chatIds' in target) {
        const ids = 'chatId' in target ? [check('chatId', target.chatId)] : checkList('chatId', target.chatIds)
        if (ids.length > MAX_BOT_GROUPS) {
          throw new DingtalkSendError('invalid_target', `at most ${MAX_BOT_GROUPS} groups per call`)
        }
        args.push(`--groups=${ids.join(',')}`)
        targets.push(...ids.map((chatId) => ({ chatId })))
      } else if ('userId' in target) {
        args.push(`--users=${check('userId', target.userId)}`)
        targets.push({ userId: target.userId })
      } else {
        args.push(`--open-dingtalk-ids=${check('openDingtalkId', target.openDingtalkId)}`)
        targets.push({ openDingtalkId: target.openDingtalkId })
      }
      break
    }
    case 'webhook': {
      if (target) throw new DingtalkSendError('invalid_target', 'webhook identity sends to the group bound to its token; target must be omitted')
      if (!input.webhookToken) throw new DingtalkSendError('invalid_target', 'webhook token is not configured')
      args.push(`--webhook-token=${input.webhookToken}`)
      targets.push({ webhook: true })
      break
    }
  }

  if (input.title !== undefined) args.push(`--title=${input.title}`)
  if (input.markdown !== undefined) args.push(`--markdown=${input.markdown}`)
  if (input.text !== undefined) args.push(`--text=${input.text}`)

  const at = input.at
  if (at) {
    if (at.all) args.push('--at-all')
    if (at.userIds?.length) {
      if (input.identity === 'user') throw new DingtalkSendError('invalid_target', 'at.userIds is not supported for user identity; use at.openDingtalkIds')
      args.push(`--at-user-ids=${checkList('userId', at.userIds).join(',')}`)
    }
    if (at.openDingtalkIds?.length) {
      if (input.identity === 'webhook') throw new DingtalkSendError('invalid_target', 'at.openDingtalkIds is not supported for webhook identity')
      args.push(`--at-open-dingtalk-ids=${checkList('openDingtalkId', at.openDingtalkIds).join(',')}`)
    }
    if (at.mobiles?.length) {
      if (input.identity !== 'webhook') throw new DingtalkSendError('invalid_target', 'at.mobiles is only supported for webhook identity')
      args.push(`--at-mobiles=${checkList('mobile', at.mobiles).join(',')}`)
    }
  }

  if (input.idempotencyKey !== undefined && input.identity === 'user') {
    args.push(`--idempotency-key=${check('idempotencyKey', input.idempotencyKey)}`)
  }
  if (input.dryRun) args.push('--dry-run')
  args.push('--yes', '--format=json')
  return { args, targets, batch }
}
