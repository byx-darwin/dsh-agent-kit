import type { CheckReport } from '../checks/index.js'
import { ICON } from './messages.js'

export function formatReport(report: CheckReport): string {
  const lines = [`Profile: ${report.profile}`, '']
  let scope = ''
  for (const r of report.results) {
    if (r.scope !== scope) {
      scope = r.scope
      lines.push(scope === 'common' ? '[通用]' : `[${scope.replace('agent-kit-', '')}]`)
    }
    lines.push(`  ${ICON[r.status]} ${r.title}：${r.detail}`)
    if (r.fix && r.status !== 'pass') lines.push(`      → ${r.fix}`)
  }
  lines.push('', report.ok ? '全部检查通过。' : '存在未通过的检查项，请按提示修复。', '')
  return lines.join('\n')
}
