// 给 AI 读的纯文本文档：llms.txt（概述）、llms-full.txt（完整）、llms-config.txt（配置与命令）。
import { configRows } from '../data/config-tables'
import { RELEASE } from '../data/release'
import { SERVICES } from '../data/services'
import { SITE } from './site'

const page = (path: string) => `${SITE.url}${path}`

function status(): string {
  return `版本 v${RELEASE.version}，${RELEASE.published ? '已发布' : '尚未发布'}到 npm（${SITE.npm}）。源码：${SITE.repo}`
}

export function renderLlms(): string {
  const docs = [
    ['快速开始', '/quickstart/'],
    ...SERVICES.map((s) => [`${s.name}（${s.context}）`, `/docs/${s.slug}/`]),
    ['配置引导（doctor / setup / 设置页）', '/docs/onboarding/'],
    ['安全', '/docs/security/'],
    ['架构', '/architecture/'],
    ['兼容性', '/compatibility/'],
  ]
  return [
    `# ${SITE.name}`,
    '',
    `> ${SITE.positioning}`,
    '',
    status(),
    '',
    '## 文档',
    '',
    ...docs.map(([title, path]) => `- [${title}](${page(path!)})`),
    '',
    '## 更多',
    '',
    `- [完整文档](${page('/llms-full.txt')})`,
    `- [配置项与命令](${page('/llms-config.txt')})`,
    '',
  ].join('\n')
}

export function renderLlmsFull(): string {
  const sections = SERVICES.map((s) =>
    [
      `## ${s.context}：${s.name}`,
      '',
      s.summary,
      '',
      `启用：Profile 的 cordis.patch.yml 中 id 为 ${s.kitId} 的行设为 disabled: false。`,
      '',
      ...s.notes.map((n) => `- ${n}`),
      '',
      '错误码：',
      '',
      ...s.errors.map((e) => `- ${e.code}（可重试：${e.retryable}）：${e.meaning}`),
      '',
    ].join('\n'),
  )
  return [
    `# ${SITE.name}`,
    '',
    `> ${SITE.positioning}`,
    '',
    status(),
    '',
    '## 通用约定',
    '',
    '- 所有错误都是 KitError，带 service、code、retryable；用 isKitError(e) 与 code 判断，不依赖 instanceof。',
    '- 每个启用的 Service 提供 health()，返回 { status: ok | degraded | failed, detail, counters }；进入 failed 时触发 cordis 事件 agent-kit/service-failed。',
    '- 六个 Service 默认禁用、按需启用；业务包只 inject 用到的 Service，并把 @mc/dsh-agent-kit 声明为 peer 依赖。',
    '- 只需要发通知时推荐 inject notify：发往钉钉还是飞书由 agent-kit-notify 的 channels / strategy 决定，运维可随时修改，不需要改业务代码。',
    '- 本包运行时从不安装 CLI；dws（dingtalk-workspace-cli@1.0.62）与 lark-cli（@larksuite/cli@1.0.96）只由 setup 在用户确认后安装。',
    '- 来自 WebSocket 的数据与 Agent 输出都视为不可信：传给 Agent 时用 untrusted() 包裹；触发副作用前按业务白名单校验。',
    '',
    ...sections,
    '## 配置引导',
    '',
    '- npx @mc/dsh-agent-kit doctor [--profile <名字>] [--json]：只读检查，有失败项时退出码为 1。',
    '- npx @mc/dsh-agent-kit setup [--profile <名字>]：交互式配置；启用的渠道缺少 dws / lark-cli 时列出并在确认后安装锁定版本；预览 cordis.patch.yml 的改动并确认后写入。',
    '- dsh Web「设置 → Agent Kit」：查看状态、启停 Service、修改配置（包括飞书与通知渠道）、保存 TypeSafe Key；仅在 dsh Web 绑定 127.0.0.1 时可写。',
    '',
    `完整文档见 ${page('/docs/')}`,
    '',
  ].join('\n')
}

export function renderLlmsConfig(): string {
  const tables = SERVICES.map((s) =>
    [
      `## ${s.context}（${s.kitId}）`,
      '',
      '| 字段 | 默认值 | 取值范围 | 说明 |',
      '|---|---|---|---|',
      ...configRows(s.id).map((r) => `| ${r.path}${r.required ? '（必填）' : ''} | ${r.default} | ${r.range} | ${r.description.replace(/\|/g, '\\|')} |`),
      '',
    ].join('\n'),
  )
  return [
    `# ${SITE.name} 配置项与命令`,
    '',
    status(),
    '',
    ...tables,
    '## 命令',
    '',
    '- npx @mc/dsh-agent-kit setup [--profile <名字>]',
    '- npx @mc/dsh-agent-kit doctor [--profile <名字>] [--json]',
    '',
    '## TypeSafe Key 读取顺序',
    '',
    '1. 环境变量 TYPESAFE_API_KEY',
    '2. macOS 钥匙串，服务名默认 ai.typesafe.api-key（仅 macOS）',
    '3. dsh 凭据文件 $DSH_HOME/.credentials.yaml',
    '',
  ].join('\n')
}
