import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearTypesafeKey,
  credentialsFile,
  defaultKeyTarget,
  describeTypesafeKey,
  macosKeychain,
  readCredential,
  resolveTypesafeKey,
  saveTypesafeKey,
  writeCredential,
  type Keychain,
} from '../../src/secrets/index.js'

let home: string
let file: string
const memory = new Map<string, string>()
const fakeKeychain: Keychain = {
  read: async (s, a) => memory.get(`${s}/${a}`),
  write: async (s, a, v) => void memory.set(`${s}/${a}`, v),
  remove: async (s, a) => void memory.delete(`${s}/${a}`),
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  file = credentialsFile(home)
  memory.clear()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('credentials file', () => {
  it('writes version 1 layout with 0600 and preserves other refs', async () => {
    writeFileSync(file, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ds-1\n', { mode: 0o600 })
    await writeCredential('TYPESAFE_API_KEY', 'ts-1', file)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('DEEPSEEK_API_KEY: ds-1')
    expect(text).toContain('TYPESAFE_API_KEY: ts-1')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBe('ts-1')
    await writeCredential('TYPESAFE_API_KEY', undefined, file)
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toContain('DEEPSEEK_API_KEY')
  })

  it('creates the file when missing and treats empty values as absent', async () => {
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBeUndefined()
    await writeCredential('TYPESAFE_API_KEY', 'v', file)
    expect(readFileSync(file, 'utf8')).toMatch(/^version: 1\n/)
    writeFileSync(file, 'version: 1\nrefs:\n  TYPESAFE_API_KEY: ""\n')
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBeUndefined()
  })
})

describe('typesafe key', () => {
  const base = () => ({ env: {}, platform: 'darwin' as const, keychain: fakeKeychain, keychainAccount: 'alice', credentialsFile: file })

  it('resolves env, then keychain services in order, then credentials', async () => {
    expect(await resolveTypesafeKey(base())).toBeUndefined()
    await writeCredential('TYPESAFE_API_KEY', 'from-file', file)
    expect(await resolveTypesafeKey(base())).toEqual({ key: 'from-file', source: 'credentials' })
    memory.set('gitflow-cli-typesafe/alice', 'from-old')
    expect(await resolveTypesafeKey({ ...base(), keychainService: ['ai.typesafe.api-key', 'gitflow-cli-typesafe'] })).toEqual({ key: 'from-old', source: 'keychain:gitflow-cli-typesafe' })
    memory.set('ai.typesafe.api-key/alice', 'from-new')
    expect(await resolveTypesafeKey({ ...base(), keychainService: ['ai.typesafe.api-key', 'gitflow-cli-typesafe'] })).toEqual({ key: 'from-new', source: 'keychain:ai.typesafe.api-key' })
    expect(await resolveTypesafeKey({ ...base(), env: { TYPESAFE_API_KEY: 'from-env' }, keychainService: 'ai.typesafe.api-key' })).toEqual({ key: 'from-env', source: 'env' })
  })

  it('prefers the running dsh credentials service over direct file reads', async () => {
    const credentials = { resolve: async () => ({ value: 'from-service' }) }
    expect(await resolveTypesafeKey({ ...base(), credentials })).toEqual({ key: 'from-service', source: 'credentials' })
  })

  it('skips the keychain outside macOS', async () => {
    memory.set('ai.typesafe.api-key/alice', 'k')
    expect(await resolveTypesafeKey({ ...base(), platform: 'linux', keychainService: 'ai.typesafe.api-key' })).toBeUndefined()
  })

  it('describes without revealing the value', async () => {
    memory.set('ai.typesafe.api-key/alice', 'secret-value')
    const d = await describeTypesafeKey({ ...base(), keychainService: 'ai.typesafe.api-key' })
    expect(d).toEqual({ configured: true, source: 'keychain:ai.typesafe.api-key' })
    expect(JSON.stringify(d)).not.toContain('secret-value')
  })

  it('saves and clears in the chosen target', async () => {
    await saveTypesafeKey('keychain', 'k1', { ...base(), keychainService: ['ai.typesafe.api-key', 'gitflow-cli-typesafe'] })
    expect(memory.get('ai.typesafe.api-key/alice')).toBe('k1')
    await saveTypesafeKey('credentials', 'k2', base())
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBe('k2')
    await clearTypesafeKey('keychain', { ...base(), keychainService: 'ai.typesafe.api-key' })
    expect(memory.has('ai.typesafe.api-key/alice')).toBe(false)
    await expect(saveTypesafeKey('keychain', 'k', { ...base(), platform: 'linux' })).rejects.toThrow(/macOS/)
  })

  it('picks the default target per platform', () => {
    expect(defaultKeyTarget('darwin')).toBe('keychain')
    expect(defaultKeyTarget('linux')).toBe('credentials')
    expect(defaultKeyTarget('win32')).toBe('credentials')
  })

  it.skipIf(process.platform !== 'darwin')('real macOS keychain round trip', async () => {
    const service = `dsh-agent-kit-test-${process.pid}`
    const account = process.env.USER!
    try {
      await macosKeychain.write(service, account, 'round-trip-value')
      expect(await macosKeychain.read(service, account)).toBe('round-trip-value')
      await macosKeychain.write(service, account, 'updated')
      expect(await macosKeychain.read(service, account)).toBe('updated')
    } finally {
      await macosKeychain.remove(service, account)
    }
    expect(await macosKeychain.read(service, account)).toBeUndefined()
  })
})
