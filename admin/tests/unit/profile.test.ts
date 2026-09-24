import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KIT_ENTRIES, listProfiles, locateProfile, previewKitEntries, readKitEntries, readPatchEntries, resolveDshHome, writeKitEntries, writePatchEntries, type EntryValidator } from '../../src/profile/index.js'
import { isKitError } from '@mc/dsh-agent-kit'

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

  it('exposes metadata for every kit service', () => {
    expect(KIT_ENTRIES.map((e) => e.id)).toEqual(['agent-kit-ws', 'agent-kit-dingtalk', 'agent-kit-feishu', 'agent-kit-notify', 'agent-kit-agent-tasks', 'agent-kit-jev'])
    expect(KIT_ENTRIES.find((e) => e.id === 'agent-kit-notify')!.validate({ channel: 'email' })).toMatchObject({ ok: false, errors: [{ path: 'channel' }] })
    expect(KIT_ENTRIES.find((e) => e.id === 'agent-kit-notify')!.validate({ channel: 'feishu' }).ok).toBe(true)
    expect(KIT_ENTRIES.find((e) => e.id === 'agent-kit-feishu')!.validate({ identity: 'bot' }).ok).toBe(true)
    expect(KIT_ENTRIES.find((e) => e.id === 'agent-kit-agent-tasks')!.validate({}).ok).toBe(false)
  })
})

describe('patch file: arbitrary rows (issue #1)', () => {
  const BUSINESS_ROW = `-   id: my-business-row   # 业务行
    disabled: false
    config:
      url: 'wss://a.example/ws'   # trailing
      targets: [a,  b]
      note: >-
        folded
        text


      mask: 0x1F
`
  const MIXED = `# head
${BUSINESS_ROW}# 钉钉
- id: agent-kit-dingtalk
  disabled: false
  config: { identity: bot,   robotCode: ding1 }
- id: tools
  config:
    n: 0x2A
`
  const accept: EntryValidator = (_id, config) => ({ ok: true, value: config })

  it('reads any row id', async () => {
    writeFileSync(patchFile, MIXED)
    const snap = await readPatchEntries(patchFile, ['my-business-row', 'missing'])
    expect(snap.entries['my-business-row']).toMatchObject({ enabled: true, config: { url: 'wss://a.example/ws', targets: ['a', 'b'] } })
    expect(snap.entries.missing).toEqual({ enabled: false, config: undefined })
    expect(snap.version).toBe((await readKitEntries(patchFile)).version)
  })

  it('saving a kit row leaves a business row byte-for-byte unchanged', async () => {
    writeFileSync(patchFile, MIXED)
    const { version } = await readKitEntries(patchFile)
    await writeKitEntries(patchFile, { 'agent-kit-dingtalk': { enabled: true, config: { identity: 'bot', robotCode: 'ding2' } }, 'agent-kit-ws': { enabled: true } }, version)
    const text = readFileSync(patchFile, 'utf8')
    expect(text.startsWith(`# head\n${BUSINESS_ROW}# 钉钉\n`)).toBe(true)
    expect(text).toContain('- id: tools\n  config:\n    n: 0x2A\n')
    expect(text).toMatch(/robotCode: ding2/)
    expect(text.endsWith('- id: agent-kit-ws\n  disabled: false\n')).toBe(true)
  })

  it('saving a business row leaves kit rows byte-for-byte unchanged', async () => {
    writeFileSync(patchFile, MIXED)
    const kitText = MIXED.slice(MIXED.indexOf('# 钉钉'))
    const { version } = await readKitEntries(patchFile)
    await writePatchEntries(patchFile, { 'my-business-row': { enabled: true, config: { url: 'wss://b.example/ws' } } }, version, accept)
    const text = readFileSync(patchFile, 'utf8')
    expect(text.endsWith(kitText)).toBe(true)
    expect(text).toContain("url: wss://b.example/ws")
    expect(text).toContain('# 业务行')
    expect((await readPatchEntries(patchFile, ['my-business-row'])).entries['my-business-row']).toEqual({ enabled: true, config: { url: 'wss://b.example/ws' } })
  })

  it('keeps the indentation of an indented top-level list and a file without a trailing newline', async () => {
    writeFileSync(patchFile, '  - id: tools\n    config: {a:  1}\n  - id: my-business-row\n    disabled: true')
    const { version } = await readKitEntries(patchFile)
    await writePatchEntries(patchFile, { 'my-business-row': { enabled: true, config: { k: 'v' } }, 'new-row': { enabled: false } }, version, accept)
    const text = readFileSync(patchFile, 'utf8')
    expect(text.startsWith('  - id: tools\n    config: {a:  1}\n  - id: my-business-row\n    disabled: false\n    config:\n      k: v\n  - id: new-row\n')).toBe(true)
    expect((await readPatchEntries(patchFile, ['tools', 'my-business-row', 'new-row'])).entries).toEqual({
      tools: { enabled: true, config: { a: 1 } },
      'my-business-row': { enabled: true, config: { k: 'v' } },
      'new-row': { enabled: false, config: undefined },
    })
  })

  it('validates business rows with the given validator and reports paths under the row id', async () => {
    const { version } = await readKitEntries(patchFile)
    const reject: EntryValidator = () => ({ ok: false, errors: [{ path: 'url', message: 'must be wss' }] })
    const err = await writePatchEntries(patchFile, { 'my-business-row': { enabled: true, config: { url: 'http://x' } } }, version, reject).catch((e) => e)
    expect(isKitError(err) && err.code).toBe('invalid_config')
    expect(err.details.errors).toEqual([{ path: 'my-business-row.url', message: 'must be wss' }])
    expect(readFileSync(patchFile, 'utf8')).toBe(ORIGINAL)
    await expect(writePatchEntries(patchFile, { 'my-business-row': { enabled: false } }, 'stale', accept)).rejects.toMatchObject({ code: 'conflict' })
  })
})
