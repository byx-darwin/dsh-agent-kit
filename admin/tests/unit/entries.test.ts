import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertEntry, entrySecretRefs, validateEntryConfig, type AgentKitEntry } from '../../src/admin/entry.js'
import { loadManifestEntries } from '../../src/admin/manifest.js'
import { collectEntries } from '../../src/admin/registry.js'
import { createCheckContext, runChecks } from '../../src/checks/index.js'
import { locateProfile } from '../../src/profile/index.js'

let home: string
let profileDir: string

/** 在 Profile 的 node_modules 里放一个带 `dsh.agentKit.entries` 清单的业务包。 */
function businessPackage(dir: string, name: string, files: Record<string, string>, entries: unknown = ['./entry.mjs']) {
  const pkg = join(dir, 'node_modules', name)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, type: 'module', dsh: { agentKit: { entries } } }))
  for (const [file, text] of Object.entries(files)) writeFileSync(join(pkg, file), text)
}

const ENTRY_MODULE = `export default {
  id: 'biz-row',
  label: '业务',
  schema: (v) => { if (v.url !== undefined && typeof v.url !== 'string') throw new Error('$.url expected string'); return { tokenEnv: 'BIZ_TOKEN', ...v } },
  validate: (c) => (c.url && !c.url.startsWith('wss://') ? [{ path: 'url', message: 'must be wss://' }] : []),
  fields: [{ path: 'url', label: 'URL' }],
  secrets: [{ label: 'Token', refFrom: 'tokenEnv', ref: 'BIZ_TOKEN' }],
  checks: (ctx) => [{ id: 'upstream', title: '上游', status: ctx.entry.enabled ? 'pass' : 'skip', detail: 'ok' }],
}
`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  profileDir = join(home, 'profiles', 'kit')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@mc/dsh-agent-kit', '@acme/biz'], patchReload: 'live' } } }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const entry = (over: Partial<AgentKitEntry> = {}): AgentKitEntry => ({ id: 'biz-row', label: '业务', ...over })

describe('entry definition', () => {
  it('accepts a minimal entry and rejects reserved or malformed ones', () => {
    expect(() => assertEntry(entry())).not.toThrow()
    expect(() => assertEntry(entry({ id: 'agent-kit-ws' }))).toThrow(/reserved/)
    expect(() => assertEntry(entry({ id: 'common' }))).toThrow(/reserved/)
    expect(() => assertEntry(entry({ id: 'a:b' }))).toThrow(/id/)
    expect(() => assertEntry(entry({ label: '' }))).toThrow(/label/)
    expect(() => assertEntry(entry({ fields: [{ path: 'x', label: 'X', kind: 'select' }] }))).toThrow(/options/)
    expect(() => assertEntry(entry({ secrets: [{ label: 'T' }] }))).toThrow(/ref/)
    expect(() => assertEntry(entry({ secrets: [{ label: 'T', ref: 'not a var' }] }))).toThrow(/environment variable/)
    expect(() => assertEntry(entry({ dependsOn: ['agent-kit-nope' as never] }))).toThrow(/dependsOn/)
  })

  it('validates with the schema first, then the validate hook, with paths relative to the row', () => {
    const e = entry({
      schema: (v) => {
        if (typeof (v as { n?: unknown }).n !== 'number') throw new Error('$.n expected number but got string')
        return v
      },
      validate: (c: { n: number; max: number }) => (c.n > c.max ? [{ path: 'n', message: 'n <= max' }] : []),
    })
    expect(validateEntryConfig(e, { n: 'x' })).toMatchObject({ ok: false, errors: [{ path: 'n' }] })
    expect(validateEntryConfig(e, { n: 5, max: 3 })).toEqual({ ok: false, errors: [{ path: 'n', message: 'n <= max' }] })
    expect(validateEntryConfig(e, { n: 1, max: 3 })).toEqual({ ok: true, value: { n: 1, max: 3 } })
    expect(validateEntryConfig(entry({ validate: () => { throw new Error('boom') } }), {})).toEqual({ ok: false, errors: [{ path: '', message: 'boom' }] })
  })

  it('resolves secret refs from config, falling back to the fixed ref', () => {
    const e = entry({ secrets: [{ label: 'T', refFrom: 'auth.tokenEnv', ref: 'DEFAULT_TOKEN' }, { label: 'Fixed', ref: 'FIXED' }] })
    expect(entrySecretRefs(e, undefined)).toEqual([{ label: 'T', ref: 'DEFAULT_TOKEN' }, { label: 'Fixed', ref: 'FIXED' }])
    expect(entrySecretRefs(e, { auth: { tokenEnv: 'OTHER' } })[0]).toEqual({ label: 'T', ref: 'OTHER' })
    expect(entrySecretRefs(e, { auth: { tokenEnv: 'bad ref' } })[0]).toEqual({ label: 'T', ref: undefined })
  })
})

describe('static manifest', () => {
  it('discovers entries declared by bundles in the Profile', async () => {
    businessPackage(profileDir, '@acme/biz', { 'entry.mjs': ENTRY_MODULE })
    const { entries, errors } = await loadManifestEntries(await locateProfile('kit', home))
    expect(errors).toEqual([])
    expect(entries.map((e) => e.id)).toEqual(['biz-row'])
  })

  it('reports broken manifests as failing common checks instead of throwing', async () => {
    businessPackage(profileDir, '@acme/biz', { 'bad.mjs': 'export default { id: "agent-kit-ws", label: "x" }' }, ['./bad.mjs', './missing.mjs', '../escape.mjs'])
    const { entries, errors } = await loadManifestEntries(await locateProfile('kit', home))
    expect(entries).toEqual([])
    expect(errors.map((e) => [e.scope, e.status])).toEqual([['common', 'fail'], ['common', 'fail'], ['common', 'fail']])
    expect(errors.map((e) => e.detail).join('\n')).toMatch(/reserved[\s\S]*missing\.mjs[\s\S]*不在包目录内/)
  })

  it('ignores bundles without a manifest or not installed', async () => {
    const { entries, errors } = await loadManifestEntries(await locateProfile('kit', home))
    expect({ entries, errors }).toEqual({ entries: [], errors: [] })
  })
})

describe('registered checks', () => {
  it('runs config and custom checks scoped to the row, even while it is disabled', async () => {
    businessPackage(profileDir, '@acme/biz', { 'entry.mjs': ENTRY_MODULE })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), "- id: biz-row\n  disabled: true\n  config:\n    url: 'http://x'\n")
    const profile = await locateProfile('kit', home)
    const report = await runChecks(await createCheckContext(profile, { nodeVersion: '24.0.0' }), await collectEntries(profile, []))
    const biz = report.results.filter((r) => r.scope === 'biz-row')
    expect(biz).toEqual([
      expect.objectContaining({ id: 'biz-row.config', status: 'warn', detail: 'url: must be wss://' }),
      expect.objectContaining({ id: 'biz-row.upstream', status: 'skip' }),
    ])
    expect(report.ok).toBe(true)
  })

  it('fails an enabled row with invalid config and reports a throwing check', async () => {
    const profile = await locateProfile('kit', home)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), "- id: biz-row\n  config:\n    url: 'http://x'\n")
    const throwing = entry({ validate: (c: { url: string }) => (c.url.startsWith('wss://') ? [] : [{ path: 'url', message: 'must be wss://' }]), checks: () => { throw new Error('upstream down') } })
    const report = await runChecks(await createCheckContext(profile, { nodeVersion: '24.0.0' }), await collectEntries(profile, [throwing]))
    expect(report.ok).toBe(false)
    expect(report.results.filter((r) => r.scope === 'biz-row').map((r) => [r.id, r.status])).toEqual([['biz-row.config', 'fail'], ['biz-row.checks', 'fail']])
  })

  it('keeps the first of two manifests declaring the same row id and reports the duplicate', async () => {
    businessPackage(profileDir, '@acme/biz', { 'entry.mjs': ENTRY_MODULE })
    businessPackage(profileDir, '@acme/other', { 'entry.mjs': "export default { id: 'biz-row', label: 'other' }" })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@acme/biz', '@acme/other'] } } }))
    const { entries, errors } = await collectEntries(await locateProfile('kit', home), [])
    expect(entries.map((e) => e.entry.label)).toEqual(['业务'])
    expect(errors).toEqual([expect.objectContaining({ id: 'manifest:biz-row', status: 'fail' })])
  })

  it('lets a runtime registration override the manifest entry with the same id', async () => {
    businessPackage(profileDir, '@acme/biz', { 'entry.mjs': ENTRY_MODULE })
    const { entries } = await collectEntries(await locateProfile('kit', home), [entry({ label: 'runtime' })])
    expect(entries.map((e) => e.entry.label)).toEqual(['runtime'])
  })
})
