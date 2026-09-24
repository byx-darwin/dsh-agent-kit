export interface ChangelogEntry {
  version: string
  date: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.1.0',
    date: '2026-09-24',
    items: [
      '六个 Service：ctx.agentWs（WebSocket 客户端）、ctx.dingtalk（钉钉推送）、ctx.feishu（飞书推送，经 lark-cli）、ctx.notify（与渠道无关的通知，同一时间一个渠道，可改配置或用 use() 在运行中切换）、ctx.agentTasks（Agent 任务）、ctx.jev（Jev 判断），默认禁用、按需启用。',
      '统一的 KitError 错误模型、health() 健康状态与 agent-kit/service-failed 事件、日志统一脱敏。',
      '钉钉与飞书的登录状态与设备流登录：status()、login()（拿到授权链接即返回，由业务包决定怎么交付）、logout()；ctx.notify.status() / login() / logout() 转给当前渠道。',
      '两个包：@mc/dsh-agent-kit 是给业务包用的库；可选的 @mc/dsh-agent-kit-admin 提供 doctor 检查、setup 交互式配置（缺少 dws / lark-cli 时列出并在确认后安装锁定版本）、dsh Web「设置 → Agent Kit」页与业务包设置入口的登记。',
      'TypeSafe Key 可来自环境变量、macOS 钥匙串（ai.typesafe.api-key）或 dsh 凭据文件。',
      'Linux、macOS、Windows 三平台 CI 通过。',
      '@mc/dsh-agent-kit/testing：本地 WebSocket 测试服务端、假 subagent provider、Jev mock、假 dws、假 lark-cli。',
    ],
  },
]
