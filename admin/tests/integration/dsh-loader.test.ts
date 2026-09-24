import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

// 在真实 dsh loader 中同时加载基础包与本包的 bundle patch（通过 node_modules 软链指向已构建的 lib/）。
const ADMIN = resolve(import.meta.dirname, '../..')
const ROOT = resolve(ADMIN, '..')
const PATCHES = [...loadOverlayPatches('agent-kit', join(ROOT, 'patch.yml')), ...loadOverlayPatches('agent-kit-admin', join(ADMIN, 'patch.yml'))]

let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function start() {
  const configPath = join(ROOT, '.tmp', `cordis-admin-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`)
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  writeFileSync(configPath, '[]\n')
  try {
    ctx = await boot('agent-kit-admin-test', configPath, PATCHES as never[])
  } finally {
    rmSync(configPath, { force: true })
  }
  return ctx
}

describe('admin bundle in a real dsh loader', () => {
  it('loads the always-on admin row next to the disabled kit rows', async () => {
    const ids = PATCHES.flatMap((p: any) => p.insert ?? []).map((e: any) => [e.id, e.disabled])
    expect(ids).toContainEqual(['agent-kit-admin', undefined])
    expect(ids.filter(([id]) => id !== 'agent-kit-admin').every(([, disabled]) => disabled === true)).toBe(true)
    const c = await start()
    for (const name of ['agentWs', 'dingtalk', 'feishu', 'notify', 'agentTasks', 'jev']) expect(c.get(name)).toBeUndefined()
  })

  it('exposes AgentKitAdmin as a Remote service', async () => {
    const c = await start()
    const admin = c.get('agentKitAdmin')
    expect(admin).toBeDefined()
    const names = remoteMethods(admin as object).map((m) => m.exportName ?? m.method).sort()
    expect(names).toEqual(['clearSecret', 'saveService', 'setSecret', 'status'])
  })
})
