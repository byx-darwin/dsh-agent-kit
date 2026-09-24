import type { CheckReport } from '../checks/index.js'
import { ALL_CHECKS_PASSED, COMMON_SCOPE_LABEL, FIX_PREFIX, ICON, PROFILE_LABEL, SOME_CHECKS_FAILED, kitScopeLabel } from './messages.js'

export function formatReport(report: CheckReport): string {
  const lines = [`${PROFILE_LABEL}${report.profile}`, '']
  let scope = ''
  for (const r of report.results) {
    if (r.scope !== scope) {
      scope = r.scope
      lines.push(scope === 'common' ? COMMON_SCOPE_LABEL : kitScopeLabel(scope))
    }
    lines.push(`  ${ICON[r.status]} ${r.title}：${r.detail}`)
    if (r.fix && r.status !== 'pass') lines.push(`${FIX_PREFIX}${r.fix}`)
  }
  lines.push('', report.ok ? ALL_CHECKS_PASSED : SOME_CHECKS_FAILED, '')
  return lines.join('\n')
}
