import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CheckResult } from '../checks/types.js'
import { redact } from '../common/redact.js'
import { KIT_PACKAGE, type ProfileInfo } from '../profile/locate.js'
import { assertEntry, type AgentKitEntry } from './entry.js'

/**
 * 静态清单（issue #1）：Profile 里每个 bundle 的 `package.json` 可以声明
 *
 * ```json
 * { "dsh": { "agentKit": { "entries": ["./lib/agent-kit-entry.js"] } } }
 * ```
 *
 * 每个路径指向一个无副作用的模块，默认导出一个条目或条目数组（也接受具名导出 `entry` / `entries`）。
 * 设置页与 `doctor` 都从这里发现业务行，不依赖业务插件正在运行。
 */
export interface ManifestResult {
  entries: AgentKitEntry[]
  errors: CheckResult[]
}

type Importer = (url: string) => Promise<Record<string, unknown>>

async function packageDir(profile: ProfileInfo, bundle: string): Promise<string | undefined> {
  const require = createRequire(join(profile.dir, 'package.json'))
  try {
    return dirname(require.resolve(`${bundle}/package.json`))
  } catch {
    // 包的 exports 未导出 ./package.json 时 require.resolve 会失败，退回 Profile 自己的 node_modules
    const dir = join(profile.dir, 'node_modules', bundle)
    return (await readFile(join(dir, 'package.json')).then(() => true, () => false)) ? dir : undefined
  }
}

function exported(mod: Record<string, unknown>): unknown[] {
  const value = mod.default ?? mod.entries ?? mod.entry
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

export async function loadManifestEntries(profile: ProfileInfo, importer: Importer = (url) => import(url)): Promise<ManifestResult> {
  const entries: AgentKitEntry[] = []
  const errors: CheckResult[] = []
  const fail = (bundle: string, detail: string) =>
    errors.push({
      id: `manifest:${bundle}`,
      scope: 'common',
      title: `${bundle} 的 agent-kit 清单`,
      status: 'fail',
      detail: redact(detail),
      fix: `检查 ${bundle} 的 package.json 中 dsh.agentKit.entries 指向的模块`,
    })
  for (const bundle of profile.bundles) {
    if (bundle === KIT_PACKAGE) continue
    const dir = await packageDir(profile, bundle)
    if (!dir) continue
    let paths: unknown
    try {
      paths = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))?.dsh?.agentKit?.entries
    } catch (e) {
      fail(bundle, `读取 package.json 失败：${(e as Error).message}`)
      continue
    }
    if (paths === undefined) continue
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) {
      fail(bundle, 'dsh.agentKit.entries 必须是字符串数组')
      continue
    }
    for (const path of paths as string[]) {
      const file = resolve(dir, path)
      const rel = relative(dir, file)
      if (rel.startsWith('..') || rel.startsWith(sep) || resolve(file) === resolve(dir)) {
        fail(bundle, `${path} 不在包目录内`)
        continue
      }
      try {
        for (const entry of exported(await importer(pathToFileURL(file).href))) {
          assertEntry(entry)
          entries.push(entry)
        }
      } catch (e) {
        fail(bundle, `加载 ${path} 失败：${(e as Error).message}`)
      }
    }
  }
  return { entries, errors }
}
