export type DingtalkRecipientKind = 'group' | 'user'
export type DingtalkRecipientTarget = { chatId: string } | { userId: string } | { openDingtalkId: string }

export interface DingtalkRecipientCandidate {
  name: string
  target: DingtalkRecipientTarget
}

export interface DingtalkRecipientSearchResult {
  candidates: DingtalkRecipientCandidate[]
  /** false means DWS did not prove that every candidate was returned. */
  complete: boolean
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Fail on unknown response shapes; an empty candidate list must never hide a CLI/schema error. */
export function parseRecipientSearch(kind: DingtalkRecipientKind, stdout: string): DingtalkRecipientSearchResult {
  const data = object(JSON.parse(stdout))
  if (!data || data.success === false) throw new Error('DWS recipient search failed')
  const items = kind === 'group' ? data.chats : data.result
  if (!Array.isArray(items)) throw new Error(`DWS ${kind} search returned an unexpected result shape`)
  const seen = new Set<string>()
  const candidates: DingtalkRecipientCandidate[] = []
  for (const value of items) {
    const item = object(value)
    if (!item) continue
    const id = kind === 'group'
      ? nonempty(item.openConversationId)
      : nonempty(item.userId) ?? nonempty(item.openDingTalkId)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const target: DingtalkRecipientTarget = kind === 'group'
      ? { chatId: id }
      : nonempty(item.userId) ? { userId: id } : { openDingtalkId: id }
    candidates.push({ name: nonempty(item.title) ?? nonempty(item.name) ?? id, target })
  }
  const complete = data.complete === true && (kind !== 'group' || data.hasMore === false)
  return { candidates, complete }
}
