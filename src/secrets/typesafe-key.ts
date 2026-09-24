import { macosKeychain, type Keychain } from './keychain.js'
import { credentialsFile, readCredential, writeCredential } from './credentials-file.js'

export const TYPESAFE_KEY_REF = 'TYPESAFE_API_KEY'
/** 与其他工具（如 gitflow-cli）共享 TypeSafe Key 时推荐的钥匙串服务名。 */
export const SHARED_KEYCHAIN_SERVICE = 'ai.typesafe.api-key'

export type KeySource = 'env' | `keychain:${string}` | 'credentials'
export type KeyTarget = 'keychain' | 'credentials'

export interface KeyStoreOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  keychainService?: string | string[]
  keychainAccount?: string
  keychain?: Keychain
  /** 运行中的 dsh 凭据服务；缺省时直接读凭据文件。 */
  credentials?: { resolve(ref: string): Promise<{ value: string } | undefined> }
  credentialsFile?: string
}

const services = (o: KeyStoreOptions) => ([] as string[]).concat(o.keychainService ?? [])
const account = (o: KeyStoreOptions) => o.keychainAccount ?? (o.env ?? process.env).USER ?? ''
const isMac = (o: KeyStoreOptions) => (o.platform ?? process.platform) === 'darwin'

export function defaultKeyTarget(platform: NodeJS.Platform = process.platform): KeyTarget {
  return platform === 'darwin' ? 'keychain' : 'credentials'
}

export async function resolveTypesafeKey(o: KeyStoreOptions = {}): Promise<{ key: string; source: KeySource } | undefined> {
  const fromEnv = (o.env ?? process.env)[TYPESAFE_KEY_REF]
  if (fromEnv?.trim()) return { key: fromEnv, source: 'env' }
  if (isMac(o) && account(o)) {
    const keychain = o.keychain ?? macosKeychain
    for (const service of services(o)) {
      const key = await keychain.read(service, account(o))
      if (key) return { key, source: `keychain:${service}` }
    }
  }
  const stored = o.credentials ? (await o.credentials.resolve(TYPESAFE_KEY_REF))?.value : await readCredential(TYPESAFE_KEY_REF, o.credentialsFile ?? credentialsFile())
  return stored ? { key: stored, source: 'credentials' } : undefined
}

export async function describeTypesafeKey(o: KeyStoreOptions = {}): Promise<{ configured: boolean; source?: KeySource }> {
  const r = await resolveTypesafeKey(o)
  return r ? { configured: true, source: r.source } : { configured: false }
}

export async function saveTypesafeKey(target: KeyTarget, value: string, o: KeyStoreOptions = {}): Promise<void> {
  if (!value.trim()) throw new Error('TypeSafe Key 不能为空')
  if (target === 'keychain') {
    if (!isMac(o)) throw new Error('钥匙串仅在 macOS 上可用')
    await (o.keychain ?? macosKeychain).write(services(o)[0] ?? SHARED_KEYCHAIN_SERVICE, account(o), value)
    return
  }
  await writeCredential(TYPESAFE_KEY_REF, value, o.credentialsFile ?? credentialsFile())
}

export async function clearTypesafeKey(target: KeyTarget, o: KeyStoreOptions = {}): Promise<void> {
  if (target === 'keychain') {
    if (!isMac(o)) return
    await (o.keychain ?? macosKeychain).remove(services(o)[0] ?? SHARED_KEYCHAIN_SERVICE, account(o))
    return
  }
  await writeCredential(TYPESAFE_KEY_REF, undefined, o.credentialsFile ?? credentialsFile())
}
