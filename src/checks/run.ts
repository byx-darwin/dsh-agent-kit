import { createRequire } from 'node:module'
import { join } from 'node:path'
import { KIT_ENTRIES, readKitEntries, type ProfileInfo } from '../profile/index.js'
import { BASE_ENV_WHITELIST, pickEnv, runProcess } from '../common/process.js'
import { DWS_ENV_WHITELIST, resolveExecutable } from '../dingtalk/service.js'
import { agentTasksChecks } from './agent-tasks.js'
import { commonChecks } from './common.js'
import { dingtalkChecks } from './dingtalk.js'
import { jevChecks } from './jev.js'
import type { Check, CheckContext, CheckReport, CheckResult } from './types.js'

const SERVICE_CHECKS: Record<string, Check> = {
  'agent-kit-dingtalk': dingtalkChecks,
  'agent-kit-agent-tasks': agentTasksChecks,
  'agent-kit-jev': jevChecks,
}

export async function createCheckContext(profile: ProfileInfo, over: Partial<CheckContext> = {}): Promise<CheckContext> {
  // 按 dsh 的解析规则：模块从 Profile 目录解析
  const require = createRequire(join(profile.dir, 'package.json'))
  return {
    profile,
    snapshot: await readKitEntries(profile.patchFile),
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    resolveModule: (name) => {
      try {
        require.resolve(`${name}/package.json`)
        return true
      } catch {
        return false
      }
    },
    exec: async (file, args) => {
      const r = await runProcess(file, args, { env: pickEnv([...BASE_ENV_WHITELIST, ...DWS_ENV_WHITELIST]), timeoutMs: 15_000, killGraceMs: 1000 })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
    keyStore: {},
    // resolveExecutable 已内部处理 win32 上 .exe / .cmd shim 的解析，这里不要再拼接 '.cmd'
    findExecutable: (name) => resolveExecutable(name),
    ...over,
  }
}

export async function runChecks(ctx: CheckContext): Promise<CheckReport> {
  const results: CheckResult[] = [...(await commonChecks(ctx))]
  for (const meta of KIT_ENTRIES) {
    const state = ctx.snapshot.entries[meta.id]
    if (!state.enabled) continue
    const validated = meta.validate(state.config)
    results.push({
      id: `${meta.id}.config`,
      scope: meta.id,
      title: `${meta.title} 配置`,
      status: validated.ok ? 'pass' : 'fail',
      detail: validated.ok ? '配置有效' : validated.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      ...(validated.ok ? {} : { fix: `运行 npx @mc/dsh-agent-kit setup 或在设置页修改 ${meta.title} 配置` }),
    })
    const extra = SERVICE_CHECKS[meta.id]
    if (extra) results.push(...(await extra(ctx)))
  }
  return { profile: ctx.profile.name, ok: results.every((r) => r.status !== 'fail'), results }
}
