import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../../src/client/locale.js'

const CLIENT_DIR = join(import.meta.dirname, '../../src/client')

describe('client dictionaries (issue #4)', () => {
  it('en and zh have exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('en keeps the same placeholders as zh', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(zh)) expect([key, vars(en[key]!)]).toEqual([key, vars(zh[key]!)])
  })

  it('en has no Chinese characters or full-width punctuation', () => {
    for (const [key, value] of Object.entries(en)) expect([key, /[　-〿一-鿿＀-￯]/.test(value)]).toEqual([key, false])
  })

  it('every literal t() key used by the client exists in both dictionaries', () => {
    const used = new Set<string>()
    for (const file of readdirSync(CLIENT_DIR)) {
      const text = readFileSync(join(CLIENT_DIR, file), 'utf8')
      for (const m of text.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]!)
    }
    expect(used.size).toBeGreaterThan(20)
    for (const key of used) expect([key, key in zh, key in en]).toEqual([key, true, true])
  })
})
