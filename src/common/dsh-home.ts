import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 与 dsh 一致：DSH_HOME 非空时使用它，否则为 <home>/.dsh；支持 ~ 前缀。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
  const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1).replace(/^[\\/]/, '')) : raw
  return resolve(expanded)
}
