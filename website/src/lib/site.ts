/** 全站共享的名称、地址与定位语；JSON-LD、llms.txt 与页面元数据都从这里取值。 */
export const SITE = {
  name: 'dsh-agent-kit',
  url: 'https://byx-darwin.github.io/dsh-agent-kit',
  repo: 'https://github.com/byx-darwin/dsh-agent-kit',
  npm: '@mc/dsh-agent-kit',
  npmUrl: 'https://www.npmjs.com/package/@mc/dsh-agent-kit',
  author: { name: '皮哥不写PPT', url: 'https://byx-darwin.github.io/' },
  tagline: '让业务包只写业务。',
  positioning:
    '构建常驻 Agent Worker 的 DeepSeek Harness 插件工具包：WebSocket 接入、钉钉 / 飞书推送与渠道无关的通知、Claude Code / Codex 任务委托、TypeSafe Jev 校验，默认安全，按需启用。',
} as const
