import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProfileError } from './patch-file.js'

export interface ProfileInfo {
  name: string
  dir: string
  patchFile: string
  bundles: string[]
  patchReload: 'live' | 'startup'
  hasKit: boolean
}

export const KIT_PACKAGE = '@mc/dsh-agent-kit'

/** 与 dsh 一致：DSH_HOME 非空时使用它，否则为 <home>/.dsh；支持 ~ 前缀。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
  const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1).replace(/^[\\/]/, '')) : raw
  return resolve(expanded)
}

export async function listProfiles(home = resolveDshHome()): Promise<string[]> {
  try {
    const entries = await readdir(join(home, 'profiles'), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export async function locateProfile(name: string, home = resolveDshHome()): Promise<ProfileInfo> {
  const dir = join(home, 'profiles', name)
  let manifest: { dsh?: { profile?: { bundles?: string[]; patchReload?: string } } }
  try {
    manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    throw new ProfileError('profile_not_found', `profile ${name} not found under ${home}`)
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  return {
    name,
    dir,
    patchFile: join(dir, 'cordis.patch.yml'),
    bundles,
    patchReload: manifest.dsh?.profile?.patchReload === 'live' ? 'live' : 'startup',
    hasKit: bundles.includes(KIT_PACKAGE),
  }
}
