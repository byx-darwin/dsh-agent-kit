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
    ['配置引导（可选的 admin 包：doctor / setup / 设置页）', '/docs/onboarding/'],
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
    '- 两个包：@mc/dsh-agent-kit 是给业务包用的库（五个 Service 与 testing 工具）；@mc/dsh-agent-kit-admin 是可选的运维工具（doctor / setup 命令行、dsh Web 设置页、业务包设置入口登记）。',
    '- 五个 Service 默认禁用、按需启用；钉钉仅支持 user 身份，通知固定转发至钉钉。',
    '- 只需要发通知时推荐 inject notify：启用 dingtalk 和 notify 后，业务包调用 ctx.notify.send()。',
    '- 钉钉提供 status() / login() / logout()；login() 返回设备授权链接与完成状态，logout() 只退出当前账号。',
    '- 钉钉群内 @ 当前 user 的消息按群 ID 路由到一个业务插件；未命中记录按账号保留，群名只用于展示。业务插件可搜索群或个人作为自己的发送目标。',
    '- 代码任务可由业务插件选择仓库并请求独立 Git worktree；项目路径、provider 和可写权限由业务插件配置，Kit 不自动提交、推送或合并。',
    '- 本包运行时从不安装 CLI；dws（dingtalk-workspace-cli@1.0.62）只由 admin 包的 setup 在用户确认后安装。',
    '- 来自 WebSocket 的数据与 Agent 输出都视为不可信：传给 Agent 时用 untrusted() 包裹；触发副作用前按业务白名单校验。',
    '',
    ...sections,
    '## 配置引导（可选的 @mc/dsh-agent-kit-admin）',
    '',
    '- 安装：dsh plugin --profile <名字> add @mc/dsh-agent-kit @mc/dsh-agent-kit-admin',
    '- npx @mc/dsh-agent-kit-admin doctor [--profile <名字>] [--json]：只读检查，有失败项时退出码为 1。',
    '- npx @mc/dsh-agent-kit-admin setup [--profile <名字>]：交互式配置；启用钉钉而缺少 dws 时确认后安装锁定版本；预览 cordis.patch.yml 的改动并确认后写入。',
    '- dsh Web「设置 → Agent Kit」：查看状态、启停 Service、修改配置、钉钉 user 扫码登录、群消息路由与未命中记录、保存 TypeSafe Key（Jev 选本地 Laya 时保存 Laya Key）；通知 Service 卡片隐藏，仅在 dsh Web 绑定 127.0.0.1 时可写。',
    '- 业务包设置入口：package.json 的 dsh.agentKit.entries 静态清单，或 ctx.agentKitAdmin.registerEntry()；defineEntry 与条目类型从 @mc/dsh-agent-kit-admin/entry 导入。',
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
    '## 命令（需要可选的 @mc/dsh-agent-kit-admin）',
    '',
    '- npx @mc/dsh-agent-kit-admin setup [--profile <名字>]',
    '- npx @mc/dsh-agent-kit-admin doctor [--profile <名字>] [--json]',
    '',
    '## TypeSafe Key 读取顺序（provider: typesafe，默认）',
    '',
    '1. 环境变量 TYPESAFE_API_KEY',
    '2. macOS 钥匙串，服务名默认 ai.typesafe.api-key（仅 macOS）',
    '3. dsh 凭据文件 $DSH_HOME/.credentials.yaml',
    '',
    '## 本地 Laya（provider: laya）',
    '',
    '- Jev 行配置 provider: laya 与 baseURL，请求发往本地部署的 Laya（与 Jev 相同的 POST /v1/systemone），ctx.jev.judge() 用法不变。',
    '- Key 可选：按 apiKeyRef（默认 LAYA_API_KEY）从环境变量或 dsh 凭据文件读取，取不到则不带鉴权；不读取、也不发送 TypeSafe Key。',
    '',
  ].join('\n')
}
