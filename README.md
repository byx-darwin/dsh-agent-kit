# dsh-agent-kit

构建常驻 Agent Worker 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件工具包：WebSocket 接入、钉钉推送、Claude Code / Codex 任务委托、TypeSafe Jev 校验。

> **状态：设计阶段。** 接口以 [设计文档](docs/superpowers/specs/2026-09-23-dsh-agent-kit-design.md) 为准，首个版本发布前可能调整。

## 为什么需要它

很多系统都需要一个"常驻 Agent Worker"：

1. 通过 WebSocket 接收业务系统推送的事件；
2. 把告警类事件推送到钉钉群；
3. 把需要语义判断的任务交给 Claude Code、Codex 等 Agent 处理；
4. 用 [TypeSafe Jev](https://docs.typesafe.ai/) 对 Agent 的结果做低成本校验，不通过时升级或转人工。

这四项能力与业务无关。`@mc/dsh-agent-kit` 把它们实现为一组 DeepSeek Harness（dsh）插件 Service，项目只需在自己的**业务包**里编写协议、路由、模板和流程。

## 功能

| Service | 作用 |
|---|---|
| `ctx.agentWs` | WebSocket 客户端：自定义鉴权请求头、心跳、指数退避重连；鉴权失败和指定关闭码停止重连 |
| `ctx.dingtalk` | 通过钉钉 `dws` CLI 发送钉钉 Markdown 消息，支持 `user` / `bot` / `webhook` 身份和幂等键 |
| `ctx.agentTasks` | 调用 dsh 已注册的 subagent provider（如 `claude-code`、`codex`）执行一次性任务，可选 JSON Schema 校验输出 |
| `ctx.jev` | 调用 TypeSafe Jev，返回 Choice / Noul / Score 的类型化判断和概率 |

每个任务都会生成一个 dsh Session，可以在 dsh Web 界面中查看和审计。

## 架构

```text
┌──────────── dsh Profile（常驻进程）────────────┐
│  你的业务包（协议、路由、模板、流程）              │
│        │ inject                                 │
│        ▼                                        │
│  @mc/dsh-agent-kit                              │
│    agentWs · dingtalk · agentTasks · jev        │
│        │                                        │
│        ▼                                        │
│  dsh：subagent-claude-code / subagent-codex、    │
│       子进程管理、Session 持久化、Web 界面        │
└─────────────────────────────────────────────────┘
```

本包不包含任何业务协议、事件类型、提示词或分类体系，也不保存可靠事件状态；投递可靠性由对端系统负责。

## 环境要求

- Node.js `^22.19` 或 `>=24`
- [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) CLI（当前为 alpha 版本，依赖需锁定到与之一致的版本）
- 使用 `ctx.dingtalk`：已安装并登录 `dws`
- 使用 `ctx.agentTasks`：已安装 `@deepseek-ai/dsh-subagent-claude-code` 和/或 `@deepseek-ai/dsh-subagent-codex`，并完成 Claude Code / Codex 的原生登录
- 使用 `ctx.jev`：环境变量 `TYPESAFE_API_KEY`

## 安装

```sh
npm i -g @deepseek-ai/dsh

# 基于 web 模板创建一个常驻 Profile
dsh --profile my-agent --from-default-profile web

# 安装本包、Agent provider 和你的业务包
dsh plugin --profile my-agent add @mc/dsh-agent-kit \
  @deepseek-ai/dsh-subagent-claude-code @deepseek-ai/dsh-subagent-codex
dsh plugin --profile my-agent add ./my-business-plugin-0.1.0.tgz

dsh --profile my-agent --dump-config   # 检查各层是否生效
dsh --profile my-agent --no-open
```

## 编写业务包

业务包把本包声明为 peer 依赖，保证一个 Profile 中只加载一份实例：

```jsonc
{
  "name": "@your-org/dsh-agent-your-project",
  "type": "module",
  "peerDependencies": {
    "@deepseek-ai/cordis": "<与 dsh 一致>",
    "@mc/dsh-agent-kit": "^0.1.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "<与 dsh 一致>",
    "@mc/dsh-agent-kit": "^0.1.0"
  },
  "dsh": { "bundle": { "patch": "./patch.yml" } }
}
```

插件示例（接口草案）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { choice, noul } from '@mc/dsh-agent-kit'

export const name = 'my-agent'
export const inject = ['agentWs', 'dingtalk', 'agentTasks', 'jev']

export function apply(ctx: Context, config: Config) {
  const conn = ctx.agentWs.connect({
    url: config.url,
    headers: { 'X-Token': process.env.MY_AGENT_TOKEN! },
    onMessage: async (frame) => {
      if (frame.type === 'alert') {
        await ctx.dingtalk.send({
          title: frame.title,
          markdown: renderAlert(frame),
          idempotencyKey: frame.id,
        })
        return
      }

      const draft = await ctx.agentTasks.run({
        provider: 'claude-code',
        title: `classify ${frame.id}`,
        prompt: buildPrompt(frame),
        outputSchema: ResultSchema,
      })

      const { answers } = await ctx.jev.judge({
        state: { input: frame.input, candidate: draft.output },
        questions: {
          wrong: noul('候选结果与输入证据不符', { true: '不符', false: '相符' }),
          pick: choice('输入最符合哪个类别', CATEGORIES),
        },
      })

      await conn.send({ id: frame.id, result: draft.output, verified: answers.wrong.noul < 0.7 })
    },
  })
}
```

完整接口、错误类型和配置字段见 [设计文档](docs/superpowers/specs/2026-09-23-dsh-agent-kit-design.md)。

## 配置

各 Service 的可变参数都是 cordis.yml 中经过校验的配置字段，可在 Profile 的 `cordis.patch.yml` 中覆盖。

| Service | 主要字段 |
|---|---|
| `agentWs` | `pingIntervalMs`、`readTimeoutMs`、`reconnect.initialDelayMs`、`reconnect.maxDelayMs`、`reconnect.jitter` |
| `dingtalk` | `identity`、`defaultTarget`、`robotCode`、`webhookTokenEnv`、`dwsPath`、`timeoutMs` |
| `agentTasks` | `workspaceDir`、`defaultTimeoutMs`、`maxConcurrency` |
| `jev` | `model`、`timeoutMs` |

## 安全

- 密钥只从环境变量读取；钉钉凭据由 `dws` 自己的登录态管理，本包不保存。
- 本包不向模型传递任何凭据，日志不记录鉴权头、API Key 和完整消息正文。
- 发送给 Claude Code、Codex、TypeSafe 的内容由业务包决定，请在业务包中做数据最小化。

## 路线图

- [ ] 四个 Service 的首个实现与测试
- [ ] 发布 `0.1.0` 到 npm
- [ ] 通用的「Agent 执行 → Jev 校验 → 升级」级联 helper
- [ ] 连接请求头动态刷新（支持会过期的令牌）

## 许可证

[MIT](LICENSE)
