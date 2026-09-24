import { CHANNEL_CLIS, installCommand } from '../common/clis.js'
import { identityAvailable, parseFeishuError } from '../feishu/output.js'
import type { Check, CheckResult } from './types.js'

export const feishuChecks: Check = async (ctx) => {
  const config = (ctx.snapshot.entries['agent-kit-feishu'].config ?? {}) as { identity?: 'bot' | 'user'; dryRun?: boolean; larkPath?: string; profile?: string }
  const scope = 'agent-kit-feishu' as const
  const lark = config.larkPath ?? ctx.findExecutable('lark-cli')
  const results: CheckResult[] = [
    {
      id: `${scope}.lark-cli`,
      scope,
      title: 'lark-cli 已安装',
      status: lark ? 'pass' : 'fail',
      detail: lark ?? '在 PATH 中找不到 lark-cli',
      ...(lark ? {} : { fix: `${installCommand(CHANNEL_CLIS.feishu)}，或重新运行 setup 选择安装` }),
    },
  ]
  if (!lark || config.dryRun === true) {
    results.push({ id: `${scope}.identity`, scope, title: '飞书身份可用', status: 'skip', detail: config.dryRun ? 'dryRun 模式不检查' : '跳过' })
    return results
  }
  const identity = config.identity ?? 'bot'
  const r = await ctx.exec(lark, [...(config.profile ? [`--profile=${config.profile}`] : []), 'auth', 'status', '--json']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  const status = r.exitCode === 0 ? identityAvailable(r.stdout, identity) : { ok: false, detail: parseFeishuError(r.stderr).message }
  const fix = identity === 'user' ? 'lark-cli auth login --scope "im:message.send_as_user im:message"' : 'lark-cli config init（填写应用的 App ID / App Secret）'
  results.push({
    id: `${scope}.identity`,
    scope,
    title: `飞书 ${identity} 身份可用`,
    status: status.ok ? 'pass' : 'fail',
    detail: status.detail,
    ...(status.ok ? {} : { fix }),
  })
  return results
}
