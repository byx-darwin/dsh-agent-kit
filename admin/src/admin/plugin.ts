import type { Context } from '@deepseek-ai/cordis'
import { AgentKitAdmin } from './service.js'

/** 根入口插件：常驻加载，承载 AgentKitAdmin（Task 8）并让 dsh 发现本包的前端模块。 */
export const name = 'agent-kit-admin'
export const inject = ['loader']

export function apply(ctx: Context): void {
  ctx.plugin(AgentKitAdmin)
}
