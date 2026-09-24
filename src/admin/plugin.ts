import type { Context } from '@deepseek-ai/cordis'

/** 根入口插件：常驻加载，承载 AgentKitAdmin（Task 8）并让 dsh 发现本包的前端模块。 */
export const name = 'agent-kit'
export const inject = ['loader']

export function apply(_ctx: Context): void {
  // Task 8 在此挂载 AgentKitAdmin；可选服务（webServer、credentials）届时通过 ctx.get() 读取。
}
