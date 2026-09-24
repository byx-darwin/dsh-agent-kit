import type { Check } from './types.js'

const PROVIDERS = [
  { name: 'claude-code', module: '@deepseek-ai/dsh-subagent-claude-code' },
  { name: 'codex', module: '@deepseek-ai/dsh-subagent-codex' },
]

export const agentTasksChecks: Check = (ctx) => {
  const scope = 'agent-kit-agent-tasks' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as { declaredPermissions?: Record<string, string> }
  const installed = PROVIDERS.filter((p) => ctx.resolveModule(p.module))
  const undeclared = installed.filter((p) => !config.declaredPermissions?.[p.name])
  return [
    {
      id: `${scope}.provider`,
      scope,
      title: 'subagent provider 已安装',
      status: installed.length > 0 ? 'pass' : 'fail',
      detail: installed.length > 0 ? installed.map((p) => p.name).join(', ') : '未安装 claude-code 或 codex provider',
      ...(installed.length > 0 ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @deepseek-ai/dsh-subagent-claude-code@0.1.5-rc.3` }),
    },
    {
      id: `${scope}.permissions`,
      scope,
      title: '权限上限已声明',
      status: undeclared.length === 0 ? 'pass' : 'warn',
      detail: undeclared.length === 0 ? '所有已安装 provider 都已声明' : `${undeclared.map((p) => p.name).join(', ')} 未声明 declaredPermissions，对应任务会被拒绝`,
      ...(undeclared.length === 0 ? {} : { fix: '运行 setup 或在设置页声明权限上限（claude-code 默认 dontAsk 可声明为 read-only）' }),
    },
  ]
}
