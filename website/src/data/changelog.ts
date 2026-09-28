export interface ChangelogEntry {
  version: string
  date: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.2.0',
    date: '2026-09-28',
    items: [
      '移除飞书 Service、CLI 检查与文档；钉钉只保留当前 dws 登录账号的 user 身份，不再支持机器人或 webhook 身份。',
      '钉钉新增群内 @ 当前 user 的消息监听：设置页按群 ID 指定业务插件，未命中消息按账号留存并可查看群名；业务插件决定是否回复及如何处理。',
      '业务插件可以搜索当前账号可见的群或个人，并在自己的设置字段中选择稳定 ID 作为发送目标；群消息接收路由与主动发送目标分别配置。',
      'Agent 任务支持为代码任务创建独立 Git worktree；项目选择、仓库路径和可写权限由下游业务插件负责，不自动提交、推送或合并。',
      '设置页隐藏钉钉发送身份、默认目标、dryRun 与通知 Service 卡片；钉钉设备授权链接可在本机生成二维码，授权是否成功仍取决于 dws 和组织权限。',
      'ctx.jev 可在 TypeSafe Jev 与本地部署的 Laya 之间二选一：新增 provider、baseURL、apiKeyRef 配置；选 laya 时不读取、也不发送 TypeSafe Key，业务代码不用改。',
      'admin 包：设置页、setup 与 doctor 支持 Laya（服务地址、可选的 Laya Key、连接检查）。',
      'Laya 截断告警：新增 contextTokens 配置，输入占满上下文窗口时记 warn 日志，judge() 结果带 truncated: true，health() 计数器 truncated 加一。',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-24',
    items: [
      '五个 Service：ctx.agentWs（WebSocket 客户端）、ctx.dingtalk（钉钉 user 推送）、ctx.notify（通知转发至钉钉）、ctx.agentTasks（Agent 任务）、ctx.jev（Jev 判断），默认禁用、按需启用。',
      '统一的 KitError 错误模型、health() 健康状态与 agent-kit/service-failed 事件、日志统一脱敏。',
      '钉钉 user 登录状态与设备流登录：status()、login()、logout()；ctx.notify.status() / login() / logout() 转给钉钉。',
      '两个包：@baoyx/dsh-agent-kit 是给业务包用的库；可选的 @baoyx/dsh-agent-kit-admin 提供 doctor 检查、setup 交互式配置、dsh Web「设置 → Agent Kit」页与业务包设置入口的登记。',
      'TypeSafe Key 可来自环境变量、macOS 钥匙串（ai.typesafe.api-key）或 dsh 凭据文件。',
      'Linux、macOS、Windows 三平台 CI 通过。',
      '@baoyx/dsh-agent-kit/testing：本地 WebSocket 测试服务端、假 subagent provider、Jev mock、假 dws。',
    ],
  },
]
