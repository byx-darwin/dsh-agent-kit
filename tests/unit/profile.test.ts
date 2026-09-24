import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KIT_ENTRIES, listProfiles, locateProfile, previewKitEntries, readKitEntries, resolveDshHome, writeKitEntries } from '../../src/profile/index.js'
import { isKitError } from '../../src/common/errors.js'

let home: string
let profileDir: string
let patchFile: string

const ORIGINAL = `# 用户自己的注释
- id: tools
  config:
    mode: basic
# 启用钉钉
- id: agent-kit-dingtalk
  disabled: false
  config:
    identity: bot   # 行内注释
    robotCode: ding1
`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  profileDir = join(home, 'profiles', 'kit')
  mkdirSync(profileDir, { recursive: true })
  patchFile = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchFile, ORIGINAL)
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@mc/dsh-agent-kit'], patchReload: 'live' } } }))
  mkdirSync(join(home, 'profiles', 'other'))
  writeFileSync(join(home, 'profiles', 'other', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('locate', () => {
  it('resolves DSH_HOME with the dsh default', () => {
    expect(resolveDshHome({})).toBe(join(homedir(), '.dsh'))
    expect(resolveDshHome({ DSH_HOME: '/x/y' })).toMatch(/[\\/]x[\\/]y$/)
  })

  it('lists profiles and reads bundle / reload facts', async () => {
    expect((await listProfiles(home)).sort()).toEqual(['kit', 'other'])
    const kit = await locateProfile('kit', home)
    expect(kit).toMatchObject({ name: 'kit', patchFile, patchReload: 'live', hasKit: true })
    const other = await locateProfile('other', home)
    expect(other).toMatchObject({ hasKit: false, patchReload: 'startup' })
    await expect(locateProfile('missing', home)).rejects.toThrow(/missing/)
  })
})

describe('patch file', () => {
  it('reads kit entries with defaults for absent rows', async () => {
    const snap = await readKitEntries(patchFile)
    expect(snap.version).toMatch(/^[0-9a-f]{64}$/)
    expect(snap.entries['agent-kit-dingtalk']).toEqual({ enabled: true, config: { identity: 'bot', robotCode: 'ding1' } })
    expect(snap.entries['agent-kit-ws']).toEqual({ enabled: false, config: undefined })
  })

  it('updates existing rows and appends missing ones, preserving comments and other rows', async () => {
    const { version } = await readKitEntries(patchFile)
    await writeKitEntries(
      patchFile,
      {
        'agent-kit-dingtalk': { enabled: true, config: { identity: 'bot', robotCode: 'ding2' } },
        'agent-kit-ws': { enabled: true },
      },
      version,
    )
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toContain('# 用户自己的注释')
    expect(text).toContain('# 启用钉钉')
    expect(text).toContain('mode: basic')
    expect(text).toContain('robotCode: ding2')
    expect(text).toMatch(/- id: agent-kit-ws\n\s+disabled: false/)
    const snap = await readKitEntries(patchFile)
    expect(snap.entries['agent-kit-ws'].enabled).toBe(true)
  })

  it('disables a row without dropping its config', async () => {
    const { version } = await readKitEntries(patchFile)
    await writeKitEntries(patchFile, { 'agent-kit-dingtalk': { enabled: false } }, version)
    expect((await readKitEntries(patchFile)).entries['agent-kit-dingtalk']).toEqual({ enabled: false, config: { identity: 'bot', robotCode: 'ding1' } })
  })

  it('creates the file when absent', async () => {
    rmSync(patchFile)
    const { version } = await readKitEntries(patchFile)
    await writeKitEntries(patchFile, { 'agent-kit-jev': { enabled: true, config: { model: 'jev-latest' } } }, version)
    expect((await readKitEntries(patchFile)).entries['agent-kit-jev'].enabled).toBe(true)
  })

  it('rejects stale versions', async () => {
    const { version } = await readKitEntries(patchFile)
    writeFileSync(patchFile, `${ORIGINAL}\n# 别人改过\n`)
    const err = await writeKitEntries(patchFile, { 'agent-kit-ws': { enabled: true } }, version).catch((e: unknown) => e)
    expect(isKitError(err) && err.code).toBe('conflict')
  })

  it('validates config with the service schema and cross-field rules', async () => {
    const { version } = await readKitEntries(patchFile)
    const bad = await writeKitEntries(patchFile, { 'agent-kit-ws': { enabled: true, config: { pingIntervalMs: 30000, readTimeoutMs: 1000 } } }, version).catch((e: unknown) => e)
    expect(isKitError(bad) && bad.code).toBe('invalid_config')
    expect((bad as { details: { errors: { path: string }[] } }).details.errors[0]!.path).toMatch(/readTimeoutMs/)
    const bad2 = await writeKitEntries(patchFile, { 'agent-kit-dingtalk': { enabled: true, config: { identity: 'nobody' } } }, version).catch((e: unknown) => e)
    expect(isKitError(bad2) && bad2.code).toBe('invalid_config')
    expect(readFileSync(patchFile, 'utf8')).toBe(ORIGINAL)
  })

  it('validates supplied config even when the row stays disabled', async () => {
    const { version } = await readKitEntries(patchFile)
    const bad = await writeKitEntries(patchFile, { 'agent-kit-ws': { enabled: false, config: { pingIntervalMs: 30000, readTimeoutMs: 1000 } } }, version).catch((e: unknown) => e)
    expect(isKitError(bad) && bad.code).toBe('invalid_config')
    expect((bad as { details: { errors: { path: string }[] } }).details.errors[0]!.path).toMatch(/readTimeoutMs/)
    expect(readFileSync(patchFile, 'utf8')).toBe(ORIGINAL)
  })

  it('refuses to edit kit rows containing !!js', async () => {
    writeFileSync(patchFile, `- id: agent-kit-jev\n  disabled: !!js process.env.X === '1'\n`)
    const { version } = await readKitEntries(patchFile)
    const err = await writeKitEntries(patchFile, { 'agent-kit-jev': { enabled: true } }, version).catch((e: unknown) => e)
    expect(isKitError(err) && err.code).toBe('unsupported_yaml')
    expect((err as { details: { line: number } }).details.line).toBe(2)
  })

  it('reports unparsable files', async () => {
    writeFileSync(patchFile, '- id: [unclosed\n')
    await expect(readKitEntries(patchFile)).rejects.toMatchObject({ code: 'parse_error' })
  })

  it('previews changes without writing', async () => {
    const { before, after } = await previewKitEntries(patchFile, { 'agent-kit-ws': { enabled: true } })
    expect(before).toBe(ORIGINAL)
    expect(after).toContain('agent-kit-ws')
    expect(readFileSync(patchFile, 'utf8')).toBe(ORIGINAL)
  })

  it('exposes metadata for all four services', () => {
    expect(KIT_ENTRIES.map((e) => e.id)).toEqual(['agent-kit-ws', 'agent-kit-dingtalk', 'agent-kit-agent-tasks', 'agent-kit-jev'])
    expect(KIT_ENTRIES.find((e) => e.id === 'agent-kit-agent-tasks')!.validate({}).ok).toBe(false)
  })
})
