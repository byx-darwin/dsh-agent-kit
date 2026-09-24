import type { CheckResult } from '../checks/types.js'
import { readPatchEntries } from '../profile/patch-file.js'
import type { ProfileInfo } from '../profile/locate.js'
import type { AgentKitEntry, RegisteredEntry } from './entry.js'
import { loadManifestEntries } from './manifest.js'

export interface CollectedEntries {
  entries: RegisteredEntry[]
  errors: CheckResult[]
}

/**
 * 合并静态清单与运行时登记的条目，并读取它们在 `cordis.patch.yml` 中的状态。同 id 时运行时登记
 * 覆盖清单；多个清单声明同一 id 时保留第一个并报错。`profile` 缺省（无法定位 Profile）时只返回
 * 运行时登记、状态一律为未启用。
 */
export async function collectEntries(profile: ProfileInfo | undefined, runtime: Iterable<AgentKitEntry>): Promise<CollectedEntries> {
  const manifest = profile ? await loadManifestEntries(profile) : { entries: [], errors: [] }
  const byId = new Map<string, AgentKitEntry>()
  const errors = [...manifest.errors]
  for (const entry of manifest.entries) {
    if (byId.has(entry.id)) {
      errors.push({ id: `manifest:${entry.id}`, scope: 'common', title: `登记行 ${entry.id}`, status: 'fail', detail: '多个包的清单声明了同一个行 id', fix: '让每个业务行 id 只由一个包声明' })
      continue
    }
    byId.set(entry.id, entry)
  }
  for (const entry of runtime) byId.set(entry.id, entry)
  const ids = [...byId.keys()]
  const states = profile ? (await readPatchEntries(profile.patchFile, ids)).entries : {}
  return {
    entries: ids.map((id) => ({ entry: byId.get(id)!, state: states[id] ?? { enabled: false, config: undefined } })),
    errors,
  }
}
