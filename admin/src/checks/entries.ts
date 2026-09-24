import { validateEntryConfig, type EntryCheckResult, type RegisteredEntry } from '../admin/entry.js'
import { redact } from '@mc/dsh-agent-kit'
import type { CheckContext, CheckResult } from './types.js'

/**
 * 业务包登记行的检查。与本包四行不同，行被停用时也照常检查（issue #1）：业务行往往在首次部署、
 * 配置有误时保持 `disabled: true`，这正是最需要看到检查结果的时候。停用行的配置错误记为 warn，
 * 不让 `doctor` 因一个没启用的行失败。
 */
export async function entryChecks(ctx: CheckContext, { entry, state }: RegisteredEntry): Promise<CheckResult[]> {
  const scoped = (r: EntryCheckResult): CheckResult => ({ ...r, id: r.id.startsWith(`${entry.id}.`) ? r.id : `${entry.id}.${r.id}`, scope: entry.id })
  const results: CheckResult[] = []
  if (!state.enabled && state.config === undefined) {
    results.push({ id: `${entry.id}.config`, scope: entry.id, title: `${entry.label} 配置`, status: 'skip', detail: '未启用，也没有配置' })
  } else {
    const validated = validateEntryConfig(entry, state.config)
    results.push({
      id: `${entry.id}.config`,
      scope: entry.id,
      title: `${entry.label} 配置`,
      status: validated.ok ? 'pass' : state.enabled ? 'fail' : 'warn',
      detail: validated.ok ? '配置有效' : validated.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      ...(validated.ok ? {} : { fix: `在设置页修改 ${entry.label} 配置，或编辑 cordis.patch.yml 中的 ${entry.id} 行` }),
    })
  }
  if (entry.checks) {
    try {
      for (const r of await entry.checks({ ...ctx, entry: { id: entry.id, enabled: state.enabled, config: state.config } })) results.push(scoped(r))
    } catch (e) {
      results.push({ id: `${entry.id}.checks`, scope: entry.id, title: `${entry.label} 检查`, status: 'fail', detail: `检查执行失败：${redact((e as Error).message ?? String(e))}`, fix: `检查登记 ${entry.id} 的业务包中 checks() 的实现` })
    }
  }
  return results
}
