# @mc/dsh-agent-kit 设计

- 日期：2026-09-23
- 状态：待评审

## 背景

多个项目都需要一个常驻的 Agent Worker：通过 WebSocket 连接业务系统接收事件，把告警推送到钉钉，把需要智能判断的任务交给 Claude Code、Codex 等 Agent 处理，并用 TypeSafe Jev 对结果做校验。这些能力与具体业务无关，每个项目重复实现既浪费又难以维护。

`@mc/dsh-agent-kit` 把这四项能力打包成一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件 Service。各项目的业务逻辑放在各自的业务包中，业务包通过 Cordis `inject` 使用本包提供的 Service。

## 目标

- 提供四个与业务无关的 Service：`ctx.agentWs`、`ctx.dingtalk`、`ctx.agentTasks`、`ctx.jev`。
- 每个 Service 的可变参数都是 cordis.yml 中经过校验的 `Config` 字段。
- 密钥只从环境变量读取；钉钉凭据由 `dws` 自己的登录态管理，本包不保存。
- 业务包只依赖本包导出的 TypeScript 接口即可开发。

## 非目标

- 不包含任何业务协议、事件类型、告警模板、提示词或分类体系。
- 第一版不提供「Agent 执行 → Jev 校验 → 升级」级联 helper。第二个项目出现同类需求时再提升到本包。
- 不保存可靠事件状态；投递可靠性由对端业务系统负责。
- 不实现 Claude Code / Codex 的调用细节，复用 dsh 已有的 subagent provider。

## 总体架构

```text
┌──────────── dsh Profile（常驻，基于 web 模板）────────────┐
│  业务包（各项目私有，例如 @<org>/dsh-agent-<project>）      │
│        │ inject                                           │
│        ▼                                                  │
│  @mc/dsh-agent-kit                                        │
│    ├─ ctx.agentWs     WebSocket 客户端                     │
│    ├─ ctx.dingtalk    钉钉推送（调用 dws CLI）              │
│    ├─ ctx.agentTasks  Agent 任务（基于 ctx.subagents）      │
│    └─ ctx.jev         TypeSafe Jev 判断                    │
│        │                                                  │
│        ▼                                                  │
│  dsh 已有能力：ctx.subagents（subagent-claude-code /       │
│  subagent-codex）、子进程管理、Session 持久化、Web 界面      │
└───────────────────────────────────────────────────────────┘
```

本包是一个 npm 包，内部每个 Service 一个目录，各自独立注册，业务包可以只 inject 用到的 Service。

## Service 接口

以下为接口草案，最终签名在实施计划中确定。

### ctx.agentWs：WebSocket 客户端

```ts
const conn = ctx.agentWs.connect({
  url: 'wss://example.com/stream',
  headers: { 'X-Token': token },
  onMessage: async (frame: JsonValue) => {},
  onStateChange: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => {},
})
await conn.send(frame)
```

- `connect()` 返回的连接注册为 effect，随调用方插件卸载而关闭。
- 只收发 JSON 文本帧；无法解析为 JSON 的帧记录日志后丢弃。
- `send()` 在连接未打开时 reject，不做内部排队；是否重发由业务包决定。
- 断线后按指数退避加抖动自动重连。握手返回 401/403，或连接以 `fatalCloseCodes` 中的关闭码断开时，视为鉴权或配置错误：停止重连，把状态置为 `closed`，通过日志报错。
- 使用 `ws` 库；客户端定时发送 WS ping，超过读超时未收到任何帧则主动断开并重连。
- Config：`pingIntervalMs`、`readTimeoutMs`、`reconnect.initialDelayMs`、`reconnect.maxDelayMs`、`reconnect.jitter`；`connect()` 参数另接受 `fatalCloseCodes`（默认空），由业务包按对端约定给出。

### ctx.dingtalk：钉钉推送

```ts
const r = await ctx.dingtalk.send({
  markdown: '## 标题\n正文',
  title: '标题',
  target: { chatId: 'cid...' },
  idempotencyKey: 'evt_...',
})
```

- 调用 `dws chat +messages-send` 子进程，通过 dsh 子进程管理启动，超时后终止。
- `target` 省略时使用配置的默认目标；`idempotencyKey` 在 `user` 身份下透传为 `--idempotency-key`，其他身份下忽略并记录一次警告。
- 命令非零退出或输出无法解析时抛出 `DingtalkSendError`，包含退出码和经过脱敏的 stderr 摘要。
- Config：`identity`（`user` | `bot` | `webhook`，默认 `user`）、`defaultTarget`、`robotCode`（bot 身份必填）、`webhookTokenEnv`（webhook 身份必填，环境变量名）、`dwsPath`（默认 `dws`）、`timeoutMs`。
- 加载时校验身份与必填字段的组合，不合法则启动失败。

### ctx.agentTasks：Agent 任务

```ts
const r = await ctx.agentTasks.run({
  provider: 'claude-code',
  title: 'task title',
  prompt: '...',
  outputSchema,
  timeoutMs: 120_000,
  signal,
})
// r: { sessionId, text, output }
```

- `provider` 是 `ctx.subagents` 中已注册的 provider 名称，例如 `claude-code`、`codex`。
- 每次运行在配置的工作目录下创建一个根 Session 作为父 Agent，再通过 `ctx.subagents` 发起一次性委托；Session 标题使用 `title`，可在 dsh Web 界面审计。
- 给出 `outputSchema`（JSON Schema）时，从最终答案中提取 JSON（优先取最后一个 ```json 代码块，否则整体解析），用 Ajv 校验，结果放在 `output`。
- 失败抛出 `AgentTaskError`，`code` 为 `provider_failed`、`timeout`、`invalid_output` 或 `aborted`。
- 超过 `maxConcurrency` 的调用排队等待；`signal` 中止时取消排队或运行中的委托。
- Config：`workspaceDir`、`defaultTimeoutMs`、`maxConcurrency`。

### ctx.jev：Jev 判断

```ts
const { answers } = await ctx.jev.judge({
  state: { ... },
  questions: {
    isWrong: noul('...', { true: '...', false: '...' }),
    pick: choice('...', { A: '...', B: '...' }),
  },
})
```

- 包装 `@typesafe-ai/sdk`，重新导出 `choice`、`noul`、`score` 等问题构造函数，保留 SDK 的答案类型推断。
- API Key 从 `TYPESAFE_API_KEY` 读取，缺失时启动失败。
- 请求失败或超时抛出 `JevError`，区分 `unavailable`（可重试）与 `bad_request`（不可重试）。
- Config：`model`（例如 `jev-1.12`）、`timeoutMs`。

## 安全

- 日志不记录 WebSocket 鉴权头、Jev API Key、钉钉 webhook token 和完整消息正文。
- 本包不向模型传递任何凭据；`agentTasks` 只传调用方给出的 `prompt`。
- 发给 Claude Code、Codex、TypeSafe 的内容由业务包决定，业务包负责数据最小化。

## 目录结构

```text
dsh-agent-kit/
  package.json            # name: @mc/dsh-agent-kit，type: module，dsh.bundle
  src/
    index.ts              # 导出全部 Service 与类型
    ws/  dingtalk/  agent-tasks/  jev/
  patch.yml               # bundle 默认 patch 层：注册四个 Service，默认配置
  tests/
  docs/superpowers/specs/
```

- `@deepseek-ai/cordis` 为 `peerDependencies`；依赖已发布的 `@deepseek-ai/dsh-*` 包。
- ESM、TypeScript `strict: true`；注册都通过 `ctx.effect()` / `ctx.on()`。

## 测试

| Service | 覆盖内容 | 方式 |
|---|---|---|
| `agentWs` | 鉴权头、收发、心跳、退避重连、401 停止重连、卸载关闭 | 测试内启动本地 `ws` 服务端 |
| `dingtalk` | 各身份参数拼装、幂等键、输出解析、超时、非零退出 | 用假 `dws` 脚本替代真实命令 |
| `agentTasks` | JSON 提取、Schema 校验、超时、并发排队、中止 | 注册假 subagent provider |
| `jev` | 请求组装、答案映射、错误分类 | mock `@typesafe-ai/sdk` |

测试只使用通用示例数据，不包含任何具体业务项目的数据。

## 发布与安装

```sh
dsh --profile <name> --from-default-profile web
dsh plugin --profile <name> add @mc/dsh-agent-kit <业务包> \
  @deepseek-ai/dsh-subagent-claude-code @deepseek-ai/dsh-subagent-codex
```

- 公开发布到 npm；发布前确认拥有 `@mc` scope 的发布权限，否则更换 scope。
- 业务包必须把本包同时声明在 `peerDependencies` 与 `devDependencies` 中，保证一个 Profile 只加载一份本包实例；开发期可用 `link:` 指向本地 checkout。
- 按语义化版本发布，不兼容的接口变化升主版本号。
- 使用本包需要本机已登录 `dws`、Claude Code、Codex。

## 实施前需核实

1. `ctx.subagents` 是否接受未执行任何轮次的根 Agent 作为父 Agent，以及创建根 Agent 所需的最小服务集合。
2. `dws chat +messages-send` 的 JSON 输出格式与退出码约定。
3. `@typesafe-ai/sdk` 当前版本中 `noul`、`score` 构造函数与答案字段的准确名称。
