import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

describe('client bundle', () => {
  it('is wrapped for the dsh module loader and keeps shared modules external', () => {
    execFileSync(process.execPath, [resolve(ROOT, 'scripts/build-client.mjs')], { cwd: ROOT })
    const text = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8')
    expect(text.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(text).toContain('id: "@mc/dsh-agent-kit-admin"')
    expect(text).toContain('require("react")')
    expect(text).not.toMatch(/function createElement|react\.production/)
    // 模拟 dsh 前端加载：factory 返回 apply 与 inject
    let registered: { id: string; factory: (req: (m: string) => unknown) => Record<string, unknown> } | undefined
    const window = { __ModuleLoader__: { load: (m: typeof registered) => void (registered = m) } }
    new Function('window', text)(window)
    const shared: Record<string, unknown> = { react: {}, 'react/jsx-runtime': { jsx: () => null, jsxs: () => null }, '@deepseek-ai/dsh-client-ui-primitives': {} }
    const mod = registered!.factory((name) => {
      if (!(name in shared)) throw new Error(`unexpected require ${name}`)
      return shared[name]
    })
    expect(typeof mod.apply).toBe('function')
    expect(mod.inject).toEqual(['slots', 'locale', 'remote'])
  })
})
