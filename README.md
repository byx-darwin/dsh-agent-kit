# dsh-agent-kit

构建常驻 Agent Worker 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件工具包：WebSocket 接入、钉钉推送、Claude Code / Codex 任务委托、TypeSafe Jev 校验。

> **状态：已实现，待发布 `0.1.0`。** 接口以 [设计文档](docs/superpowers/specs/2026-09-23-dsh-agent-kit-design.md) 为准，首个版本发布前可能调整。

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
| `ctx.agentWs` | WebSocket 客户端（仅 `wss://`）：可刷新的鉴权请求头、心跳、指数退避重连、并发与背压控制；鉴权失败或指定关闭码时进入 `failed` 状态并可慢速重试 |
| `ctx.dingtalk` | 通过钉钉 `dws` CLI 发送文本 / Markdown 消息，支持 `user` / `bot` / `webhook` 身份、群聊 / 单聊 / 多群、@ 人、幂等键和 `dryRun` |
| `ctx.agentTasks` | 调用 dsh 已注册的 subagent provider（如 `claude-code`、`codex`）执行一次性任务：默认只读权限（无法由本包强制的 provider 需运维声明权限上限）、每个任务独立目录、类型化的 JSON Schema 输出、并发与排队上限 |
| `ctx.jev` | 调用 TypeSafe Jev，返回 Choice / Noul / Score 的类型化判断和概率 |

- 四个 Service 默认禁用，按需启用；未启用的 Service 不校验配置，也不影响其他 Service。
- 每个 Service 提供 `health()`；进入 `failed` 时触发 `agent-kit/service-failed` 事件，便于接入外部监控。
- 所有错误都是 `KitError`，带 `code` 与 `retryable`，调用方据此决定是否重试。

## 架构

```text
┌──────────── dsh Profile（常驻进程）────────────┐
│  你的业务包（协议、路由、模板、流程）              │
│        │ inject                                 │
│        ▼                                        │
│  @mc/dsh-agent-kit（各 Service 单独启用）         │
│    agentWs · dingtalk · agentTasks · jev        │
│        │                                        │
│        ▼                                        │
│  dsh：subagent-claude-code / subagent-codex、    │
│       子进程管理、Session 持久化、Web 界面        │
└─────────────────────────────────────────────────┘
```

本包不包含任何业务协议、事件类型、提示词或分类体系，也不保存可靠事件状态；投递可靠性由对端系统负责。一条上游连接只应部署一个实例。

## 环境要求

- Node.js `^22.19` 或 `>=24`
- [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) CLI `0.1.5-rc.3`（当前为预发布版本，dsh 与 cordis 相关依赖需锁定到与之一致的版本）
- 使用 `ctx.dingtalk`：已安装并登录 `dws`；服务器环境推荐 `bot` 身份
- 使用 `ctx.agentTasks`：安装 `@deepseek-ai/dsh-subagent-claude-code` 和/或 `@deepseek-ai/dsh-subagent-codex`（`ctx.subagents` 与子进程服务由 dsh 的 base bundle 提供），并完成 Claude Code / Codex 的原生登录（provider 会剔除名字含 KEY / TOKEN / SECRET / PASSWORD 的环境变量，依赖这类变量鉴权时需在 provider 的 Config `env` 中显式给出）
- 使用 `ctx.jev`：安装 `@typesafe-ai/sdk`，并设置环境变量 `TYPESAFE_API_KEY`；macOS 上也可以用 `keychainService` 从钥匙串读取，推荐与 gitflow-cli 等工具共享的服务名 `ai.typesafe.api-key`（保存：`security add-generic-password -a "$USER" -s ai.typesafe.api-key -U -w`）
- 生产部署：Profile 进程由 systemd、pm2 等进程守护托管

## 安装

```sh
npm i -g @deepseek-ai/dsh@0.1.5-rc.3

# 基于 web 模板创建一个常驻 Profile
dsh --profile my-agent --from-default-profile web

# 安装本包、Agent provider 和你的业务包
# subagent 包必须显式指定版本：其 latest 标签目前指向 0.0.1-rc.1，与 dsh 不匹配
dsh plugin --profile my-agent add @mc/dsh-agent-kit \
  @deepseek-ai/dsh-subagent-claude-code@0.1.5-rc.3 \
  @deepseek-ai/dsh-subagent-codex@0.1.5-rc.3
dsh plugin --profile my-agent add ./my-business-plugin-0.1.0.tgz

# 在 Profile 的 cordis.patch.yml 中启用需要的 Service（见下文「配置」）

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
    "@deepseek-ai/cordis": "4.0.2",
    "@mc/dsh-agent-kit": "^0.1.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@mc/dsh-agent-kit": "^0.1.0"
  },
  "dsh": { "bundle": { "patch": "./patch.yml" } }
}
```

`@deepseek-ai/cordis` 的版本与目标 dsh 依赖的版本保持一致（dsh `0.1.5-rc.3` 对应 `4.0.2`）。开发期可以用 `link:` 指向本包的本地 checkout。

插件示例：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { choice, isKitError, noul, untrusted } from '@mc/dsh-agent-kit'

export const name = 'my-agent'
export const inject = ['agentWs', 'dingtalk', 'agentTasks', 'jev']

export function apply(ctx: Context, config: Config) {
  const conn = ctx.agentWs.connect<Frame>({
    url: config.url,
    headers: async () => ({ 'X-Token': await getToken() }), // 每次（重）连接前调用
    parse: parseFrame,                                       // 把 JsonValue 转成业务类型，抛错则丢弃该帧
    concurrency: 2,
    onMessage: async (frame, { signal }) => {
      if (frame.type === 'alert') {
        await ctx.dingtalk.send({
          title: frame.title,
          markdown: renderAlert(frame),
          idempotencyKey: frame.id,
          traceId: frame.id,
        })
        return
      }

      const draft = await ctx.agentTasks.run<Result>({
        provider: 'claude-code',
        title: `classify ${frame.id}`,
        // 来自 WebSocket 的数据是不可信的，用 untrusted() 包裹，声明它不是指令
        prompt: [CLASSIFY_INSTRUCTIONS, untrusted('event', frame.input)],
        outputSchema: ResultSchema, // JSONSchemaType<Result>，draft.output 的类型为 Result
        signal,
        traceId: frame.id,
      })

      // Agent 输出同样不可信：触发副作用前按业务白名单校验
      if (!CATEGORIES_ALLOWLIST.has(draft.output.category)) throw new Error('unexpected category')

      const { answers } = await ctx.jev.judge({
        state: { input: frame.input, candidate: draft.output },
        questions: {
          wrong: noul('候选结果与输入证据不符', { true: '不符', false: '相符' }),
          pick: choice('输入最符合哪个类别', CATEGORIES),
        },
        signal,
        traceId: frame.id,
      })

      // noul 为回答"是"的概率；choice 带 confidence 与各选项概率
      await conn.send({ id: frame.id, result: draft.output, verified: answers.wrong.noul < 0.7 })
    },
    onError: (err, frame) => {
      if (isKitError(err) && err.retryable) {
        // 例如：记录下来，交给对端系统重投
      }
    },
  })
}
```

没有 `dws` 或 Agent 登录态时，可以把 dingtalk 设为 `dryRun: true`，并使用 `@mc/dsh-agent-kit/testing` 导出的工具开发与测试：

```ts
import { createFakeDws, createJevMock, FakeSubagentProvider, FakeSubagentRuntime, startTestWsServer } from '@mc/dsh-agent-kit/testing'

const server = await startTestWsServer()          // ws://127.0.0.1:<port>，可模拟 401、关闭 pong
const dws = createFakeDws({ send: [{ mode: 'partial', failTargets: ['cidB'] }] })
process.env.DWS_CONFIG_DIR = dws.dir              // 假 dws 从这里读取场景；dingtalk 配置 dwsPath: dws.path
const restoreJev = createJevMock().install()      // jev 不发网络请求
const provider = new FakeSubagentProvider({ name: 'claude-code', handler: () => '```json\n{"category":"a"}\n```' })
await ctx.plugin(FakeSubagentRuntime, { providers: [provider] }) // 或注册到真实 ctx.subagents
```

完整接口、错误码、配置默认值和卸载语义见 [设计文档](docs/superpowers/specs/2026-09-23-dsh-agent-kit-design.md)。

## 配置

各 Service 的可变参数都是 cordis.yml 中经过校验的配置字段，均有默认值与取值范围。本包的 bundle 以禁用状态注册四个 loader 行（`agent-kit-ws`、`agent-kit-dingtalk`、`agent-kit-agent-tasks`、`agent-kit-jev`），在 Profile 的 `cordis.patch.yml` 中按 id 启用并给出配置：

```yaml
- id: agent-kit-ws
  disabled: false
- id: agent-kit-dingtalk
  disabled: false
  config:
    identity: bot
    robotCode: dingxxxx
    defaultTarget: { chatId: cidxxxx }
- id: agent-kit-agent-tasks
  disabled: false
  config:
    workspaceDir: /var/lib/my-agent/tasks
    declaredPermissions:
      claude-code: read-only                   # claude-code 默认 permissionMode: dontAsk，不能执行命令或写文件
- id: agent-kit-jev
  disabled: false                              # 需要 @typesafe-ai/sdk 与环境变量 TYPESAFE_API_KEY
  config:
    keychainService: [ai.typesafe.api-key, gitflow-cli-typesafe]  # 可选：macOS 上未设置环境变量时按顺序从钥匙串读取；旧名仅用于迁移期
```

按 id 修改 `config` 时整段替换；未给出的字段使用默认值。

| Service | 主要字段 |
|---|---|
| `agentWs` | `pingIntervalMs`、`readTimeoutMs`、`reconnect.initialDelayMs`、`reconnect.maxDelayMs`、`reconnect.jitter`、`stableResetMs`、`fatalRetryDelayMs`、`maxPayloadBytes`、`maxPendingMessages` |
| `dingtalk` | `identity`（必填）、`defaultTarget`、`robotCode`、`webhookTokenEnv`、`dwsPath`、`timeoutMs`、`killGraceMs`、`retry.maxAttempts`、`preflightIntervalMs`、`dryRun` |
| `agentTasks` | `workspaceDir`（必填）、`defaultTimeoutMs`、`maxConcurrency`、`maxQueueSize`、`keepWorkdir`、`declaredPermissions`、`toolAllowlist` |
| `jev` | `model`、`timeoutMs`、`keychainService`、`keychainAccount` |

- `agentTasks.declaredPermissions`：claude-code、codex 不支持按任务过滤工具，权限由 provider 实例自己的配置决定。运维在这里声明其实际权限上限（`read-only` / `workspace-write`）；未声明或上限高于任务请求的档位时，任务以 `unsupported_permissions` 失败。
- `dingtalk` 的 `webhook` 身份只能把 token 作为命令行参数传给 dws（会出现在 `ps` 中），不推荐使用。

## 安全

- 密钥只从环境变量读取，且不传给本包启动的子进程；钉钉凭据由 `dws` 自己的登录态管理，本包不保存。
- 来自 WebSocket 的数据和 Agent 的输出都视为不可信：Agent 默认只读，在每个任务独立的空目录中运行；输出经过 Schema 与业务白名单校验后才应触发副作用。
- 只允许 `wss://`，不关闭证书校验，不跟随重定向。
- 日志和错误经过统一脱敏，不记录鉴权头、API Key、webhook token 和完整消息正文。
- dsh Web 界面中保存了完整的 prompt 与输出，只应绑定 `127.0.0.1` 或放在鉴权代理之后。
- 发送给 Claude Code、Codex、TypeSafe 的内容由业务包决定，请在业务包中做数据最小化。

## 路线图

- [x] 完成设计文档中的「实施前需核实」项
- [x] 四个 Service 的首个实现与测试
- [ ] 发布 `0.1.0` 到 npm
- [ ] 通用的「Agent 执行 → Jev 校验 → 升级」级联 helper
- [ ] 钉钉卡片消息

## 开发

```sh
npm install
npm run typecheck
npm test                 # 单元 + 集成测试（集成测试会先构建 lib/，并在真实 dsh loader 中加载 patch.yml）
npm run test:coverage
npm run test:e2e         # 端到端冒烟，按环境变量启用，见 tests/e2e/smoke.test.ts
```

## 许可证

[MIT](LICENSE)
