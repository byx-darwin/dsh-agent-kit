import { macosKeychain, type Keychain } from './keychain.js'
import { credentialsFile, readCredential, writeCredential, type AclRunner } from './credentials-file.js'

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
  /** 测试用：替换 Windows 下 `writeCredential` 收紧 ACL 时执行的子进程（见 credentials-file.ts）。 */
  aclRunner?: AclRunner
  /** Windows 下 ACL 收紧失败（best-effort）时的回调。 */
  onAclWarning?: (message: string) => void
}

const isMac = (o: KeyStoreOptions) => (o.platform ?? process.platform) === 'darwin'
/**
 * 服务名解析顺序：显式传入 `keychainService`（含显式空数组，表示不查钥匙串）始终优先；
 * 未传入（`undefined`）时，macOS 上默认回退到 `[SHARED_KEYCHAIN_SERVICE]`，非 macOS 上为空。
 * 这样 Web 端 `JevForm` 不设置 `keychainService` 时，`setSecret`/`status()`/`jev` 检查仍能读到
 * 写入到 `SHARED_KEYCHAIN_SERVICE` 的钥匙串项（否则保存到钥匙串后无从查起）。
 */
const services = (o: KeyStoreOptions) => {
  if (o.keychainService !== undefined) return ([] as string[]).concat(o.keychainService)
  return isMac(o) ? [SHARED_KEYCHAIN_SERVICE] : []
}
const account = (o: KeyStoreOptions) => o.keychainAccount ?? (o.env ?? process.env).USER ?? ''

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
  await writeCredential(TYPESAFE_KEY_REF, value, o.credentialsFile ?? credentialsFile(), { platform: o.platform, aclRunner: o.aclRunner, onWarning: o.onAclWarning })
}

export async function clearTypesafeKey(target: KeyTarget, o: KeyStoreOptions = {}): Promise<void> {
  if (target === 'keychain') {
    if (!isMac(o)) return
    await (o.keychain ?? macosKeychain).remove(services(o)[0] ?? SHARED_KEYCHAIN_SERVICE, account(o))
    return
  }
  await writeCredential(TYPESAFE_KEY_REF, undefined, o.credentialsFile ?? credentialsFile(), { platform: o.platform, aclRunner: o.aclRunner, onWarning: o.onAclWarning })
}
