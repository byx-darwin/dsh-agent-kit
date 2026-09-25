import { describeSecretRef, describeTypesafeKey } from '@mc/dsh-agent-kit/secrets'
import type { Check, CheckResult } from './types.js'

type JevCheckConfig = { provider?: 'typesafe' | 'laya'; baseURL?: string; apiKeyRef?: string; keychainService?: string | string[]; keychainAccount?: string }

const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) })
    return true
  } catch {
    return false
  }
}

export const jevChecks: Check = async (ctx) => {
  const scope = 'agent-kit-jev' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as JevCheckConfig
  const sdk = ctx.resolveModule('@typesafe-ai/sdk')
  const sdkResult: CheckResult = { id: `${scope}.sdk`, scope, title: '@typesafe-ai/sdk 已安装', status: sdk ? 'pass' : 'fail', detail: sdk ? '已安装' : '未安装', ...(sdk ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @typesafe-ai/sdk` }) }
  if (config.provider === 'laya') return [sdkResult, ...(await layaChecks(ctx, config))]
  // 只在 jev 配置里显式给出了字段时才覆盖 ctx.keyStore 的同名字段（I1）：无条件展开
  // `keychainService: config.keychainService` 会在未配置时把 `undefined` 覆盖到
  // `ctx.keyStore.keychainAccount`（若有）上，导致钥匙串账户名被错误清空。
  const key = await describeTypesafeKey({
    ...ctx.keyStore,
    ...(config.keychainService !== undefined ? { keychainService: config.keychainService } : {}),
    ...(config.keychainAccount !== undefined ? { keychainAccount: config.keychainAccount } : {}),
  })
  return [
    sdkResult,
    {
      id: `${scope}.key`,
      scope,
      title: 'TypeSafe Key',
      status: key.configured ? 'pass' : 'fail',
      detail: key.configured ? `来源：${key.source}` : '环境变量、钥匙串与 dsh 凭据中都没有找到',
      ...(key.configured ? {} : { fix: 'npx @mc/dsh-agent-kit-admin setup（或设置环境变量 TYPESAFE_API_KEY）' }),
    },
  ]
}

/** provider 为 laya：Key 可选（取不到时不带鉴权），重点是 baseURL 能否连上；不检查 TypeSafe Key。 */
async function layaChecks(ctx: Parameters<Check>[0], config: JevCheckConfig): Promise<CheckResult[]> {
  const scope = 'agent-kit-jev' as const
  const ref = config.apiKeyRef ?? 'LAYA_API_KEY'
  const key = await describeSecretRef(ref, ctx.keyStore)
  const results: CheckResult[] = [
    {
      id: `${scope}.key`,
      scope,
      title: 'Laya Key',
      status: key.configured ? 'pass' : 'warn',
      detail: key.configured ? `${ref}，来源：${key.source}` : `未找到 ${ref}，请求不带鉴权`,
      ...(key.configured ? {} : { fix: `Laya 开启了鉴权时，设置环境变量 ${ref} 或在设置页保存到 dsh 凭据；未开启鉴权可忽略` }),
    },
  ]
  if (!config.baseURL) {
    results.push({ id: `${scope}.reachable`, scope, title: 'Laya 服务可连接', status: 'fail', detail: '未配置 baseURL', fix: '在设置页或 cordis.patch.yml 中配置 baseURL，例如 http://127.0.0.1:8000' })
    return results
  }
  const up = await (ctx.probeHttp ?? defaultProbe)(config.baseURL)
  results.push({
    id: `${scope}.reachable`,
    scope,
    title: 'Laya 服务可连接',
    status: up ? 'pass' : 'fail',
    detail: up ? config.baseURL : `无法连接 ${config.baseURL}`,
    ...(up ? {} : { fix: '启动 laya-serve（或本地的 Laya 常驻服务），并确认 baseURL 的地址与端口' }),
  })
  return results
}
