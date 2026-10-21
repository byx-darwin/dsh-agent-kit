import { describeSecretRef, resolveSecretRef } from '@baoyx/dsh-agent-kit/secrets'
import { probeFeishu } from '../feishu-probe.js'
import type { Check, CheckResult } from './types.js'

type FeishuCheckConfig = { appId?: string; appSecretRef?: string; domain?: 'feishu' | 'lark' }

const PERMISSIONS = 'im:message:send_as_bot、im:message.group_at_msg:readonly、im:message.p2p_msg:readonly'
const SOURCE: Record<string, string> = { env: '环境变量', credentials: 'dsh 凭据文件' }

export const feishuChecks: Check = async (ctx) => {
  const scope = 'agent-kit-feishu' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as FeishuCheckConfig
  const ref = config.appSecretRef ?? 'FEISHU_APP_SECRET'
  const keyStore = { ...ctx.keyStore, env: ctx.env }
  const sdk = ctx.resolveModule('@larksuiteoapi/node-sdk')
  const secret = await describeSecretRef(ref, keyStore)
  const results: CheckResult[] = [
    { id: `${scope}.sdk`, scope, title: '@larksuiteoapi/node-sdk 已安装', status: sdk ? 'pass' : 'fail', detail: sdk ? '已安装' : '未安装', ...(sdk ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @larksuiteoapi/node-sdk` }) },
    { id: `${scope}.appId`, scope, title: '飞书 App ID', status: config.appId ? 'pass' : 'fail', detail: config.appId ? config.appId : '未填写', ...(config.appId ? {} : { fix: '在设置页或 setup 中填写 App ID' }) },
    { id: `${scope}.secret`, scope, title: `飞书 App Secret（${ref}）`, status: secret.configured ? 'pass' : 'fail', detail: secret.configured ? `已配置（来源：${SOURCE[secret.source!] ?? secret.source}）` : '未配置', ...(secret.configured ? {} : { fix: `在设置页保存 App Secret，或设置环境变量 ${ref}` }) },
  ]
  if (!config.appId || !secret.configured) {
    results.push({ id: `${scope}.credential`, scope, title: '飞书凭据有效', status: 'skip', detail: '缺少 App ID 或 App Secret，跳过' })
    return results
  }
  const value = (await resolveSecretRef(ref, keyStore))!.value
  const r = await (ctx.feishuProbe ?? probeFeishu)({ appId: config.appId, appSecret: value, domain: config.domain ?? 'feishu' })
  results.push({
    id: `${scope}.credential`,
    scope,
    title: '飞书凭据有效',
    status: r.ok ? 'pass' : 'fail',
    detail: r.ok ? `机器人：${r.botName ?? '未知'}；另需在开发者后台开通权限 ${PERMISSIONS}，事件订阅选长连接` : r.detail,
    ...(r.ok ? {} : { fix: '核对 App ID / App Secret，并在飞书开发者后台开启机器人能力' }),
  })
  return results
}
