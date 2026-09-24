import type { Check, CheckResult } from './types.js'

export const dingtalkChecks: Check = async (ctx) => {
  const config = (ctx.snapshot.entries['agent-kit-dingtalk'].config ?? {}) as { identity?: string; dryRun?: boolean; dwsPath?: string; webhookTokenEnv?: string }
  const scope = 'agent-kit-dingtalk' as const
  const dws = config.dwsPath ?? ctx.findExecutable('dws')
  const results: CheckResult[] = [
    {
      id: `${scope}.dws`,
      scope,
      title: 'dws 已安装',
      status: dws ? ('pass' as const) : ('fail' as const),
      detail: dws ?? '在 PATH 中找不到 dws',
      ...(dws ? {} : { fix: 'npm i -g dingtalk-workspace-cli' }),
    },
  ]
  if (config.identity === 'webhook') {
    const set = !!config.webhookTokenEnv && !!ctx.env[config.webhookTokenEnv]
    results.push({
      id: `${scope}.webhook-token`,
      scope,
      title: 'webhook token 环境变量',
      status: set ? 'pass' : 'fail',
      detail: set ? `${config.webhookTokenEnv} 已设置` : `${config.webhookTokenEnv ?? '(未配置)'} 未设置`,
      ...(set ? {} : { fix: config.webhookTokenEnv ? `在启动 dsh 前设置环境变量 ${config.webhookTokenEnv}` : '在配置中填写 webhookTokenEnv' }),
    })
  }
  const skipLogin = config.dryRun === true || config.identity === 'webhook' || !dws
  if (skipLogin) {
    results.push({ id: `${scope}.login`, scope, title: 'dws 登录状态', status: 'skip', detail: config.dryRun ? 'dryRun 模式不检查' : '跳过' })
    return results
  }
  const r = await ctx.exec(dws!, ['auth', 'status', '--format=json']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  let ok = false
  let who = ''
  try {
    const data = JSON.parse(r.stdout) as { authenticated?: boolean; token_valid?: boolean; refresh_token_valid?: boolean; user_name?: string; corp_name?: string }
    ok = r.exitCode === 0 && data.authenticated === true && (data.token_valid === true || data.refresh_token_valid === true)
    who = [data.user_name, data.corp_name].filter(Boolean).join(' @ ')
  } catch {
    ok = false
  }
  results.push({ id: `${scope}.login`, scope, title: 'dws 登录状态', status: ok ? 'pass' : 'fail', detail: ok ? `已登录 ${who}`.trim() : '未登录或登录已过期', ...(ok ? {} : { fix: 'dws auth login' }) })
  return results
}
