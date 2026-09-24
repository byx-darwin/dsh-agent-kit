import type { Check } from './types.js'

/** Node.js 版本要求：^22.19 || >=24（即 22.19+，或 24 及以上；23.x 不满足）。 */
function isNodeVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number(n))
  if (major >= 24) return true
  if (major === 22 && minor >= 19) return true
  return false
}

export const commonChecks: Check = (ctx) => {
  const nodeOk = isNodeVersionOk(ctx.nodeVersion)
  const { profile } = ctx
  return [
    {
      id: 'node',
      scope: 'common',
      title: 'Node.js 版本',
      status: nodeOk ? 'pass' : 'fail',
      detail: `当前 ${ctx.nodeVersion}，需要 ^22.19 或 >=24`,
      ...(nodeOk ? {} : { fix: '安装 Node.js 24 LTS' }),
    },
    {
      id: 'bundle',
      scope: 'common',
      title: '本包已加入 Profile',
      status: profile.hasKit ? 'pass' : 'fail',
      detail: profile.hasKit ? `Profile ${profile.name} 已包含 @mc/dsh-agent-kit` : `Profile ${profile.name} 未安装 @mc/dsh-agent-kit`,
      ...(profile.hasKit ? {} : { fix: `dsh plugin --profile ${profile.name} add @mc/dsh-agent-kit` }),
    },
    {
      id: 'patch-reload',
      scope: 'common',
      title: '配置修改即时生效',
      status: profile.patchReload === 'live' ? 'pass' : 'warn',
      detail: profile.patchReload === 'live' ? 'patchReload: live' : 'patchReload: startup，修改配置后需要重启 dsh',
      ...(profile.patchReload === 'live' ? {} : { fix: '修改后重启 dsh；或在 Profile package.json 的 dsh.profile.patchReload 设为 "live"' }),
    },
  ]
}
