import type { KeyStoreOptions } from '@mc/dsh-agent-kit/secrets'
import type { KitId, KitSnapshot, ProfileInfo } from '../profile/index.js'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export interface CheckResult {
  id: string
  /** `common`、本包的行 id，或业务包登记的行 id（issue #1）。 */
  scope: 'common' | KitId | (string & {})
  title: string
  status: CheckStatus
  detail: string
  fix?: string
}
export interface CheckContext {
  profile: ProfileInfo
  snapshot: KitSnapshot
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  nodeVersion: string
  resolveModule(name: string): boolean
  exec(file: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }>
  keyStore: KeyStoreOptions
  findExecutable(name: string): string | undefined
  /** 探测 HTTP 地址是否可连（收到任意 HTTP 响应即可）；不传时用全局 fetch，超时 3 秒。 */
  probeHttp?(url: string): Promise<boolean>
}
export interface CheckReport {
  profile: string
  ok: boolean
  results: CheckResult[]
}
export type Check = (ctx: CheckContext) => Promise<CheckResult[]> | CheckResult[]
