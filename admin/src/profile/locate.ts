import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@mc/dsh-agent-kit'
import { ProfileError } from './profile-error.js'

export { resolveDshHome }

export interface ProfileInfo {
  name: string
  dir: string
  patchFile: string
  bundles: string[]
  patchReload: 'live' | 'startup'
  hasKit: boolean
}

export const KIT_PACKAGE = '@mc/dsh-agent-kit'
export const ADMIN_PACKAGE = '@mc/dsh-agent-kit-admin'

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
    throw new ProfileError('profile_not_found', `未找到 Profile ${name}（${home}）`)
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
