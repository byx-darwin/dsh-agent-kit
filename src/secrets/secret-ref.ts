import { credentialsFile, readCredential, writeCredential } from './credentials-file.js'
import type { KeyStoreOptions } from './typesafe-key.js'

/**
 * 业务包登记的密钥（issue #1）：按 ref 名存取，只用环境变量与 dsh 凭据文件——业务插件运行时用
 * `ctx.credentials.resolve(ref)` 或 {@link resolveSecretRef} 就能读到，不需要额外读钥匙串。
 */
export type SecretRefSource = 'env' | 'credentials'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** ref 同时是环境变量名，只允许字母、数字与下划线，且不以数字开头。 */
export function isSecretRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_PATTERN.test(ref)
}

function assertRef(ref: string): void {
  if (!isSecretRef(ref)) throw new Error(`invalid secret ref: ${JSON.stringify(ref)}`)
}

export async function resolveSecretRef(ref: string, o: KeyStoreOptions = {}): Promise<{ value: string; source: SecretRefSource } | undefined> {
  assertRef(ref)
  const fromEnv = (o.env ?? process.env)[ref]
  if (fromEnv?.trim()) return { value: fromEnv, source: 'env' }
  const stored = o.credentials ? (await o.credentials.resolve(ref))?.value : await readCredential(ref, o.credentialsFile ?? credentialsFile())
  return stored ? { value: stored, source: 'credentials' } : undefined
}

export async function describeSecretRef(ref: string, o: KeyStoreOptions = {}): Promise<{ configured: boolean; source?: SecretRefSource }> {
  const r = await resolveSecretRef(ref, o)
  return r ? { configured: true, source: r.source } : { configured: false }
}

export async function saveSecretRef(ref: string, value: string, o: KeyStoreOptions = {}): Promise<void> {
  assertRef(ref)
  if (!value.trim()) throw new Error(`${ref} 不能为空`)
  await writeCredential(ref, value, o.credentialsFile ?? credentialsFile(), { platform: o.platform, aclRunner: o.aclRunner, onWarning: o.onAclWarning })
}

export async function clearSecretRef(ref: string, o: KeyStoreOptions = {}): Promise<void> {
  assertRef(ref)
  await writeCredential(ref, undefined, o.credentialsFile ?? credentialsFile(), { platform: o.platform, aclRunner: o.aclRunner, onWarning: o.onAclWarning })
}
