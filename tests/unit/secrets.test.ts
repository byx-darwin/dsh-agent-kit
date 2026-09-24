import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearTypesafeKey,
  createMacosKeychain,
  credentialsFile,
  defaultKeyTarget,
  describeTypesafeKey,
  macosKeychain,
  readCredential,
  resolveTypesafeKey,
  restrictWindowsAcl,
  saveTypesafeKey,
  writeCredential,
  type Keychain,
} from '../../src/secrets/index.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')

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

/**
 * I3：Windows 上 `mode: 0o600` 对 NTFS 无效（Node 在 win32 上忽略 POSIX 权限位），写完凭据文件后
 * 用 `icacls <file> /inheritance:r /grant:r <USERNAME>:F` 收紧 ACL（不经过 shell，短超时）。这里
 * 用一个假的 `aclRunner` 模拟 win32，断言调用的确切参数；不会在非 Windows 机器上真的调用 icacls。
 */
describe('windows ACL restriction (I3)', () => {
  it('runs icacls with the exact shell-less args after writing on win32', async () => {
    const calls: Array<[string, readonly string[]]> = []
    const runner = (cmd: string, args: readonly string[]) => (calls.push([cmd, args]), { status: 0 })
    await writeCredential('TYPESAFE_API_KEY', 'v', file, { platform: 'win32', aclRunner: runner, username: 'testuser' })
    expect(calls).toEqual([['icacls', [file, '/inheritance:r', '/grant:r', 'testuser:F']]])
  })

  it('does not touch the ACL on non-Windows platforms', async () => {
    const calls: unknown[] = []
    const runner = (cmd: string, args: readonly string[]) => (calls.push([cmd, args]), { status: 0 })
    await writeCredential('TYPESAFE_API_KEY', 'v', file, { platform: 'darwin', aclRunner: runner })
    expect(calls).toEqual([])
  })

  it('is best-effort: the write already succeeded, so a failing icacls only reports a warning and does not throw', async () => {
    const runner = () => ({ status: 1 })
    const warnings: string[] = []
    await writeCredential('TYPESAFE_API_KEY', 'v', file, { platform: 'win32', aclRunner: runner, username: 'testuser', onWarning: (m) => warnings.push(m) })
    expect(warnings).toEqual(['icacls exited with code 1'])
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBe('v')
  })

  it('swallows a thrown error from the runner (e.g. icacls missing) and warns instead of throwing', async () => {
    const runner = () => {
      throw new Error('spawn icacls ENOENT')
    }
    const warnings: string[] = []
    await writeCredential('TYPESAFE_API_KEY', 'v', file, { platform: 'win32', aclRunner: runner, username: 'testuser', onWarning: (m) => warnings.push(m) })
    expect(warnings).toEqual(['icacls failed: spawn icacls ENOENT'])
  })

  it('restrictWindowsAcl warns and returns false when USERNAME is not set', async () => {
    const warnings: string[] = []
    const ok = await restrictWindowsAcl(file, { username: '', runner: () => ({ status: 0 }), onWarning: (m) => warnings.push(m) })
    expect(ok).toBe(false)
    expect(warnings[0]).toMatch(/USERNAME/)
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

  it('defaults the keychain lookup to SHARED_KEYCHAIN_SERVICE on macOS when keychainService is unset', async () => {
    memory.set('ai.typesafe.api-key/alice', 'from-shared-default')
    // 没有传 keychainService（Web 端 JevForm 从不设置它）
    expect(await resolveTypesafeKey(base())).toEqual({ key: 'from-shared-default', source: 'keychain:ai.typesafe.api-key' })
  })

  it('does not look up the keychain when keychainService is explicitly an empty array', async () => {
    memory.set('ai.typesafe.api-key/alice', 'should-not-be-read')
    await writeCredential('TYPESAFE_API_KEY', 'from-file', file)
    expect(await resolveTypesafeKey({ ...base(), keychainService: [] })).toEqual({ key: 'from-file', source: 'credentials' })
  })

  it('does not default the keychain lookup outside macOS', async () => {
    memory.set('ai.typesafe.api-key/alice', 'k')
    expect(await resolveTypesafeKey({ ...base(), platform: 'linux' })).toBeUndefined()
  })

  it('picks the default target per platform', () => {
    expect(defaultKeyTarget('darwin')).toBe('keychain')
    expect(defaultKeyTarget('linux')).toBe('credentials')
    expect(defaultKeyTarget('win32')).toBe('credentials')
  })

  // 钥匙串只在 macOS 上使用；假 security 是 shell 脚本，Windows 无法直接执行
  it.skipIf(process.platform === 'win32')('write times out and kills a hung security process instead of hanging forever', async () => {
    const slow = createMacosKeychain(join(fixturesDir, 'slow-security.sh'), 200)
    await expect(slow.write('svc', 'acct', 'v')).rejects.toThrow(/timed out/)
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
