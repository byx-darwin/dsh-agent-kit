import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UnmatchedStore, unmatchedFileKey } from '../../src/common/unmatched.js'
import { DingtalkUnmatchedStore } from '../../src/dingtalk/unmatched.js'
import { until } from '../helpers.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'unmatched-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('UnmatchedStore', () => {
  it('stores bounded previews newest first, dedupes by eventId, and fills in conversation names', async () => {
    const file = join(tmp(), 'x', 'store.json')
    const store = new UnmatchedStore(file, async (id) => (id === 'c1' ? '群一' : undefined), () => {})
    await store.add({ eventId: 'e1', conversationId: 'c1', senderId: 's1', content: '字'.repeat(300), timestamp: 5 })
    await store.add({ eventId: 'e1', conversationId: 'c1', content: 'dup' })
    await store.add({ eventId: 'e2', conversationId: 'c2', content: 'b' })
    await until(async () => (await store.list()).some((r) => r.conversationName === '群一'))
    const items = await store.list()
    expect(items.map((r) => r.eventId)).toEqual(['e2', 'e1'])
    expect(items[1]).toMatchObject({ conversationId: 'c1', conversationName: '群一', senderId: 's1', preview: '字'.repeat(240), timestamp: 5 })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps at most 200 records', async () => {
    const store = new UnmatchedStore(join(tmp(), 's.json'), async () => undefined, () => {})
    for (let i = 0; i < 205; i++) await store.add({ eventId: `e${i}`, conversationId: 'c', content: '' })
    const items = await store.list()
    expect(items).toHaveLength(200)
    expect(items.at(-1)!.eventId).toBe('e5')
  })

  it('derives a stable file key without exposing the account', () => {
    expect(unmatchedFileKey('cli_abc')).toMatch(/^[0-9a-f]{24}$/)
    expect(unmatchedFileKey('cli_abc')).toBe(unmatchedFileKey('cli_abc'))
    expect(unmatchedFileKey('cli_abc')).not.toContain('cli_abc')
  })
})

describe('DingtalkUnmatchedStore compatibility', () => {
  it('reads legacy DingTalk records and exposes both field names', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'd'), { recursive: true })
    const file = join(dir, 'd', 'legacy.json')
    writeFileSync(file, JSON.stringify([{ eventId: 'old', conversationId: 'cidA', groupName: '旧群', senderOpenDingtalkId: 'od1', preview: 'p', receivedAt: 1 }]))
    const store = new DingtalkUnmatchedStore(file, async () => undefined, () => {})
    expect(await store.list()).toEqual([{ eventId: 'old', conversationId: 'cidA', conversationName: '旧群', groupName: '旧群', senderId: 'od1', senderOpenDingtalkId: 'od1', preview: 'p', receivedAt: 1 }])
    await store.add({ eventId: 'new', conversationId: 'cidB', senderId: 'od2', content: 'n' })
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    expect(stored.find((r) => r.eventId === 'new')).toMatchObject({ senderId: 'od2' })
  })
})
