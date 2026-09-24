import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/main.js'

let home: string
let out: string[]
let err: string[]
const io = () => ({ out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), env: {} })

function profile(name: string, withKit: boolean, patch = '') {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: withKit ? ['@mc/dsh-agent-kit'] : [], patchReload: 'live' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  out = []
  err = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('doctor', () => {
  it('auto-selects the only profile with the kit and prints a readable report', async () => {
    profile('a', false)
    profile('kit', true)
    const code = await main(['doctor'], io(), { home, checkOverrides: { nodeVersion: '24.1.0' } })
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).toContain('Profile: kit')
    expect(text).toMatch(/✓ Node\.js 版本/)
  })

  it('exits 1 with fixes when checks fail, and supports --json', async () => {
    profile('kit', true, '- id: agent-kit-jev\n  disabled: false\n')
    const code = await main(['doctor', '--profile', 'kit', '--json'], io(), {
      home,
      checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, keyStore: { env: {}, platform: 'linux', credentialsFile: join(home, 'none.yaml') } },
    })
    expect(code).toBe(1)
    const report = JSON.parse(out.join(''))
    expect(report.ok).toBe(false)
    expect(report.results.find((r: { id: string }) => r.id === 'agent-kit-jev.key').status).toBe('fail')
  })

  it('asks for --profile when several profiles have the kit', async () => {
    profile('a', true)
    profile('b', true)
    const code = await main(['doctor'], io(), { home })
    expect(code).toBe(2)
    expect(err.join('')).toMatch(/--profile.*a.*b/s)
  })

  it('prints usage for unknown commands', async () => {
    expect(await main(['nope'], io(), { home })).toBe(2)
    expect(err.join('')).toContain('用法')
    expect(await main(['--help'], io(), { home })).toBe(0)
  })
})

describe('doctor with registered entries (issue #1)', () => {
  it('lists checks from a business package manifest with scope equal to the entry id', async () => {
    profile('kit', true, '- id: biz-row\n  config:\n    url: wss://x\n')
    const dir = join(home, 'profiles', 'kit')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@mc/dsh-agent-kit', '@acme/biz'], patchReload: 'live' } } }))
    const pkg = join(dir, 'node_modules', '@acme', 'biz')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@acme/biz', dsh: { agentKit: { entries: ['./entry.mjs'] } } }))
    writeFileSync(join(pkg, 'entry.mjs'), "export default { id: 'biz-row', label: '业务', checks: () => [{ id: 'upstream', title: '上游', status: 'pass', detail: 'ok' }] }")
    const code = await main(['doctor', '--json'], io(), { home, checkOverrides: { nodeVersion: '24.0.0' } })
    const report = JSON.parse(out.join(''))
    expect(code).toBe(0)
    expect(report.results.filter((r: { scope: string }) => r.scope === 'biz-row').map((r: { id: string }) => r.id)).toEqual(['biz-row.config', 'biz-row.upstream'])
    out = []
    await main(['doctor'], io(), { home, checkOverrides: { nodeVersion: '24.0.0' } })
    expect(out.join('')).toContain('[biz-row]')
  })
})
