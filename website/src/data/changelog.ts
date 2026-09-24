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
      '四个 Service：ctx.agentWs（WebSocket 客户端）、ctx.dingtalk（钉钉推送）、ctx.agentTasks（Agent 任务）、ctx.jev（Jev 判断），默认禁用、按需启用。',
      '统一的 KitError 错误模型、health() 健康状态与 agent-kit/service-failed 事件、日志统一脱敏。',
      '配置引导：doctor 检查、setup 交互式配置、dsh Web「设置 → Agent Kit」页。',
      'TypeSafe Key 可来自环境变量、macOS 钥匙串（ai.typesafe.api-key）或 dsh 凭据文件。',
      'Linux、macOS、Windows 三平台 CI 通过。',
      '@mc/dsh-agent-kit/testing：本地 WebSocket 测试服务端、假 subagent provider、Jev mock、假 dws。',
    ],
  },
]
