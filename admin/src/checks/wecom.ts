import { WECOM_SECRET_REF } from '@baoyx/dsh-agent-kit/wecom'
import { describeSecretRef } from '@baoyx/dsh-agent-kit/secrets'
import type { Check, CheckResult } from './types.js'

type WecomCheckConfig = { botId?: string; secretRef?: string }

const SOURCE: Record<string, string> = { env: '环境变量', credentials: 'dsh 凭据文件' }

/** 不做在线凭据检查：同一机器人只能有一条长连接，doctor 建连会把运行中的 Agent 挤下线。 */
export const wecomChecks: Check = async (ctx) => {
  const scope = 'agent-kit-wecom' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as WecomCheckConfig
  const ref = config.secretRef ?? WECOM_SECRET_REF
  const sdk = ctx.resolveModule('@wecom/aibot-node-sdk')
  const secret = await describeSecretRef(ref, { ...ctx.keyStore, env: ctx.env })
  const results: CheckResult[] = [
    { id: `${scope}.sdk`, scope, title: '@wecom/aibot-node-sdk 已安装', status: sdk ? 'pass' : 'fail', detail: sdk ? '已安装' : '未安装', ...(sdk ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @wecom/aibot-node-sdk` }) },
    { id: `${scope}.botId`, scope, title: '企业微信 BotID', status: config.botId ? 'pass' : 'fail', detail: config.botId ?? '未填写', ...(config.botId ? {} : { fix: '在设置页或 setup 中填写 BotID' }) },
    { id: `${scope}.secret`, scope, title: `企业微信 Secret（${ref}）`, status: secret.configured ? 'pass' : 'fail', detail: secret.configured ? `已配置（来源：${SOURCE[secret.source!] ?? secret.source}）` : '未配置', ...(secret.configured ? {} : { fix: `在设置页保存 Secret，或设置环境变量 ${ref}` }) },
    { id: `${scope}.connection`, scope, title: '企业微信长连接', status: 'skip', detail: '不在线检查：同一机器人只能有一条长连接，检查会把运行中的 Agent 挤下线。请在设置页查看连接状态，或用 setup 的连接测试' },
  ]
  return results
}
