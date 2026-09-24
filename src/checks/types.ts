import type { KeyStoreOptions } from '../secrets/index.js'
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
}
export interface CheckReport {
  profile: string
  ok: boolean
  results: CheckResult[]
}
export type Check = (ctx: CheckContext) => Promise<CheckResult[]> | CheckResult[]
