import { describeTypesafeKey } from '../secrets/index.js'
import type { Check } from './types.js'

export const jevChecks: Check = async (ctx) => {
  const scope = 'agent-kit-jev' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as { keychainService?: string | string[]; keychainAccount?: string }
  const sdk = ctx.resolveModule('@typesafe-ai/sdk')
  // 只在 jev 配置里显式给出了字段时才覆盖 ctx.keyStore 的同名字段（I1）：无条件展开
  // `keychainService: config.keychainService` 会在未配置时把 `undefined` 覆盖到
  // `ctx.keyStore.keychainAccount`（若有）上，导致钥匙串账户名被错误清空。
  const key = await describeTypesafeKey({
    ...ctx.keyStore,
    ...(config.keychainService !== undefined ? { keychainService: config.keychainService } : {}),
    ...(config.keychainAccount !== undefined ? { keychainAccount: config.keychainAccount } : {}),
  })
  return [
    { id: `${scope}.sdk`, scope, title: '@typesafe-ai/sdk 已安装', status: sdk ? 'pass' : 'fail', detail: sdk ? '已安装' : '未安装', ...(sdk ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @typesafe-ai/sdk` }) },
    {
      id: `${scope}.key`,
      scope,
      title: 'TypeSafe Key',
      status: key.configured ? 'pass' : 'fail',
      detail: key.configured ? `来源：${key.source}` : '环境变量、钥匙串与 dsh 凭据中都没有找到',
      ...(key.configured ? {} : { fix: 'npx @mc/dsh-agent-kit setup（或设置环境变量 TYPESAFE_API_KEY）' }),
    },
  ]
}
