# @mc/dsh-agent-kit 设计

- 日期：2026-09-23
- 状态：待评审（第二版，已合入第一轮多角色评审意见，见文末「评审记录」）

## 背景

多个项目都需要一个常驻的 Agent Worker：通过 WebSocket 连接业务系统接收事件，把告警推送到钉钉，把需要智能判断的任务交给 Claude Code、Codex 等 Agent 处理，并用 TypeSafe Jev 对结果做校验。这些能力与具体业务无关，每个项目重复实现既浪费又难以维护。

`@mc/dsh-agent-kit` 把这四项能力打包成一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件 Service。各项目的业务逻辑放在各自的业务包中，业务包通过 Cordis `inject` 使用本包提供的 Service。

## 目标

- 提供四个与业务无关的 Service：`ctx.agentWs`、`ctx.dingtalk`、`ctx.agentTasks`、`ctx.jev`。
- 每个 Service 可单独启用；未启用的 Service 不校验配置、不影响其他 Service。
- 每个 Service 的可变参数都是 cordis.yml 中经过校验的 `Config` 字段，均有明确默认值与取值范围。
- 密钥只从环境变量读取，且不传递给任何子进程；钉钉凭据由 `dws` 自己的登录态管理，本包不保存。
- Agent 默认以最小权限运行，来自外部的数据一律视为不可信。
- 常驻运行时，任何 Service 进入不可用状态都能被外部发现。
- 业务包只依赖本包导出的 TypeScript 接口即可开发，并能在没有 dws / Agent 登录态的环境下本地调试。

## 非目标

- 不包含任何业务协议、事件类型、告警模板、提示词或分类体系。
- 第一版不提供「Agent 执行 → Jev 校验 → 升级」级联 helper。第二个项目出现同类需求时再提升到本包。
- 不保存可靠事件状态；投递可靠性由对端业务系统负责。
- 不支持同一业务系统连接的多实例部署；一个 Profile 对应一条上游连接，多实例导致的重复消费与重复告警不在本包处理范围内。
- 不实现 Claude Code / Codex 的调用细节，复用 dsh 已有的 subagent provider。
- 不内置备用告警通道；钉钉发送失败通过健康状态和事件暴露，由业务包或外部监控处理。

## 总体架构

```text
┌──────────── dsh Profile（常驻，基于 web 模板）────────────┐
│  业务包（各项目私有，例如 @<org>/dsh-agent-<project>）      │
│        │ inject                                           │
│        ▼                                                  │
│  @mc/dsh-agent-kit（四个 Service 各自独立注册、单独启用）    │
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

本包是一个 npm 包，内部每个 Service 一个目录，各自独立注册。`patch.yml` 中四个 Service 默认以**禁用**状态注册，Profile 按需启用；只有启用的 Service 在加载时校验配置与环境变量。业务包只 inject 用到的 Service。

暂不拆包。出现以下任一情况时再拆分：某个 Service 被不使用其他 Service 的项目单独依赖；某个 Service 的依赖（如 `@typesafe-ai/sdk`）的体积或发布节奏明显拖累其他 Service。

## 通用约定

### 错误模型

所有错误继承 `KitError`：

```ts
class KitError extends Error {
  service: 'agentWs' | 'dingtalk' | 'agentTasks' | 'jev'
  code: string        // 各 Service 自己的错误码
  retryable: boolean  // 调用方据此决定是否重试
  cause?: unknown     // 已脱敏
}
export function isKitError(e: unknown): e is KitError
```

- 业务包用 `isKitError()` 与 `code` 判断错误，不依赖 `instanceof`（避免多份实例时判断失效）。
- 错误信息与 `cause` 在构造时经过统一脱敏（见「安全」）。

### 生命周期与卸载

- 所有长期资源（连接、定时器、子进程、排队中的任务）都通过 `ctx.effect()` 注册，随调用方插件卸载而释放。
- 卸载时：WebSocket 以 1001 关闭；正在执行的 `onMessage` 收到的 `signal` 被中止；`agentTasks` 排队和运行中的任务以 `aborted` 结束；dws 子进程按「子进程终止」规则回收。

### 子进程终止

本包自己启动的子进程（dws）超时或卸载时：先向进程组发 SIGTERM，宽限 `killGraceMs`（默认 5000）后发 SIGKILL。子进程只继承环境变量白名单（见「安全」）。

### 健康状态与可观测性

- 每个启用的 Service 提供 `health()`，返回 `{ status: 'ok' | 'degraded' | 'failed', detail, counters }`，counters 至少包括：
  - agentWs：当前状态、重连次数、最近一次收到帧的时间、待处理消息数。
  - dingtalk：成功、失败次数，最近一次失败时间与错误码。
  - agentTasks：运行中数、排队数、按结果分类的完成数、耗时分布。
  - jev：成功、失败次数（按错误码）。
- 状态变为 `failed` 时，除日志外还触发 Cordis 事件 `agent-kit/service-failed`，业务包或 Profile 可据此向外部监控上报。
- 日志为结构化字段，所有 Service 调用接受可选的 `traceId` 并写入日志，便于用事件 ID 串起一次处理链路。

## Service 接口

以下为接口草案，最终签名在实施计划中确定。

### ctx.agentWs：WebSocket 客户端

```ts
const conn = ctx.agentWs.connect<TIn>({
  url: 'wss://example.com/stream',
  headers: async () => ({ 'X-Token': await getToken() }), // 也接受静态对象
  parse: (v: unknown): TIn => v as TIn,                   // 可选，默认原样返回 JsonValue
  onMessage: async (frame: TIn, { signal }) => {},
  onError: (err, frame) => {},                            // 可选，默认只记日志
  onStateChange: (state: 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed') => {},
  fatalCloseCodes: [4001],
  concurrency: 1,
})
conn.state          // 当前状态
await conn.whenOpen({ signal })
await conn.send(frame)   // 写入 socket 缓冲区后 resolve
await conn.close()
```

- `connect()` 返回的连接注册为 effect，随调用方插件卸载而关闭，状态变为 `closed`。
- 只允许 `wss://`；`ws://` 仅在主机为 `localhost` / `127.0.0.1` 时允许（用于测试）。不允许关闭证书校验；不跟随重定向（`followRedirects: false`），避免鉴权头随重定向泄露。
- `headers` 为函数时，每次（重）连接前调用，用于刷新会过期的令牌。
- 只收发 JSON 文本帧；无法解析为 JSON 或 `parse` 抛错的帧记录日志（只记长度与哈希）后丢弃，连接不受影响。超过 `maxPayloadBytes` 的帧由 `ws` 断开连接并按普通断线重连。
- 消息处理：
  - 同时最多 `concurrency` 个 `onMessage` 在执行，默认 1（即按到达顺序串行）。
  - 待处理消息超过 `maxPendingMessages` 时暂停读取 socket，回落到阈值以下后恢复（背压）。
  - `onMessage` 抛错交给 `onError`，默认只记日志，不断开连接。
- `send()` 在连接未处于 `open` 时 reject（`code: not_open`, `retryable: true`），不做内部排队；是否重发由业务包决定。
- 断线后按指数退避加抖动自动重连；连接稳定保持 `stableResetMs` 后退避时间重置为初始值。
- 握手返回 401/403，或连接以 `fatalCloseCodes` 中的关闭码断开时，视为鉴权或配置错误：状态置为 `failed`，`health()` 返回 `failed` 并触发 `agent-kit/service-failed`。若 `fatalRetryDelayMs > 0`，则按该间隔慢速重试（重试前重新获取 `headers`）；为 0 时不再重试，由进程托管或人工恢复。
- 客户端定时发送 WS ping，超过读超时未收到任何帧（含 pong）则主动断开并重连。

Config：

| 字段 | 默认值 | 取值范围 |
|---|---|---|
| `pingIntervalMs` | 30000 | ≥ 1000 |
| `readTimeoutMs` | 75000 | ≥ 2 × `pingIntervalMs` |
| `reconnect.initialDelayMs` | 1000 | ≥ 100 |
| `reconnect.maxDelayMs` | 60000 | ≥ `initialDelayMs` |
| `reconnect.jitter` | 0.2 | [0, 1] |
| `stableResetMs` | 60000 | ≥ 0 |
| `fatalRetryDelayMs` | 300000 | 0 或 ≥ 10000 |
| `maxPayloadBytes` | 1048576 | [1024, 104857600] |
| `maxPendingMessages` | 100 | ≥ 1 |

`connect()` 参数中的 `fatalCloseCodes`（默认空）与 `concurrency`（默认 1）由业务包按对端约定给出。

### ctx.dingtalk：钉钉推送

```ts
const r = await ctx.dingtalk.send({
  markdown: '## 标题\n正文',
  title: '标题',
  target: { chatId: 'cid...' },          // 或 { userId } / { openDingtalkId } / { chatIds: [...] }（仅 bot）
  at: { userIds: ['...'], all: false },
  idempotencyKey: 'evt_...',
  traceId: 'evt_...',
})
// r: { results: Array<{ target, ok: boolean, messageId?: string, error?: KitError }> }
```

- 调用 `dws chat +messages-send` 子进程：用 `execFile`（不经过 shell），参数统一写成 `--key=value` 形式，避免以 `-` 开头的正文被当成选项；固定附加 `--yes -f json`，保证常驻进程不会卡在交互确认上；超时后按「子进程终止」规则回收。
- `dwsPath` 必须为绝对路径（默认在启动时通过 `PATH` 解析为绝对路径并记录）。
- `target` 省略时使用配置的 `defaultTarget`；`chatId`、`userId`、`openDingtalkId` 在拼装参数前用正则校验格式。单次调用的 `target` 覆盖默认值，多个业务包共用本包时互不影响。
- 支持的目标与身份矩阵以 dws 为准：`user` 支持群聊与单聊；`bot` 支持多群（最多 100 个，返回逐目标结果）；`webhook` 的目标由 token 所在群决定。
- `idempotencyKey` 在 `user` 身份下透传为 `--idempotency-key`，其他身份下忽略并只记录一次警告。
- 自动重试：仅在 `user` 身份且给出 `idempotencyKey` 时，对 `retryable` 的失败（超时、网络错误）最多重试 `retry.maxAttempts` 次；其他情况不自动重试，避免重复发送。
- 命令非零退出或输出无法解析时抛出 `DingtalkSendError`（`KitError`），`code` 为 `timeout`、`exit_nonzero`、`bad_output`、`invalid_target` 之一，包含退出码和经过脱敏、截断的 stderr 摘要。bot 多群发送的部分失败不抛错，体现在 `results` 中。
- `dryRun: true` 时附加 `--dry-run`，只做参数解析与日志、不真实发送，用于本地开发与测试。
- 加载时校验身份与必填字段的组合，不合法则该 Service 启动失败。启动时及每隔 `preflightIntervalMs` 检查一次 dws 登录态（具体命令见「实施前需核实」），失效时 `health()` 返回 `failed`。

Config：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `identity` | 无（必填） | `user` \| `bot` \| `webhook`。服务器环境推荐 `bot`，`user` 依赖个人登录态 |
| `defaultTarget` | 无 | 省略 `target` 时使用 |
| `robotCode` | 无 | `bot` 身份必填 |
| `webhookTokenEnv` | 无 | `webhook` 身份必填，环境变量名；传递方式见「实施前需核实」 |
| `dwsPath` | `PATH` 中解析 | 绝对路径 |
| `timeoutMs` | 15000 | [1000, 120000] |
| `killGraceMs` | 5000 | ≥ 0 |
| `retry.maxAttempts` | 2 | [0, 5] |
| `preflightIntervalMs` | 3600000 | 0 表示只在启动时检查 |
| `dryRun` | false | |

### ctx.agentTasks：Agent 任务

```ts
const r = await ctx.agentTasks.run<Verdict>({
  provider: 'claude-code',
  title: 'task title',
  prompt: [
    '请判断下面的事件是否异常。',
    untrusted('event', eventJson),   // 本包导出，用分隔标记包裹外部数据并声明其不是指令
  ],
  outputSchema,                      // JSONSchemaType<Verdict>
  model: 'optional-model-id',
  permissions: 'read-only',          // 默认值
  timeoutMs: 120_000,
  signal,
  traceId,
  onEvent: (e) => {},                // 可选，转发 provider 的过程事件
})
// r: { sessionId, text, output: Verdict, usage?, durationMs }
```

- `provider` 是 `ctx.subagents` 中已注册的 provider 名称，例如 `claude-code`、`codex`。
- 每次运行在配置的工作目录下创建一个根 Session 作为父 Agent，再通过 `ctx.subagents` 发起一次性委托；Session 标题使用 `title`，可在 dsh Web 界面审计。该做法能否成立见「实施前需核实」第 1 项。
- **隔离与权限**：
  - 每个任务在 `workspaceDir/<taskId>/` 下使用一个新建的空目录，结束后删除（`keepWorkdir: true` 时保留，便于排查）。
  - `permissions` 默认 `read-only`：不允许 Bash、不允许写文件、不允许网络访问；可选 `workspace-write`（允许在任务目录内写文件），不提供更高权限档位。具体映射到 provider 的工具过滤能力，见「实施前需核实」。
  - Agent 的 `text` 与 `output` 视为不可信数据：本包只做 Schema 校验，业务包在据此触发推送等副作用前必须按白名单校验取值。
- **结构化输出**：给出 `outputSchema` 时，优先使用 provider 原生的结构化输出能力（`outputSchema` → `result.structured`）；provider 不支持时，从最终答案中提取 JSON 兜底：
  - 取最后一个标注为 `json` 的代码块；没有则取最后一个未标注语言的代码块；都没有则把整段答案作为 JSON 解析。
  - 选中的候选解析失败时直接判为 `invalid_output`，不回退到更早的代码块。
  - 空答案判为 `invalid_output`。
  - 解析结果用 Ajv 校验，通过后放入 `output`，类型由 `outputSchema` 推断。
- 失败抛出 `AgentTaskError`（`KitError`），`code` 与 `retryable`：
  - `provider_failed`：由 provider 错误决定，能区分时细分为限流（可重试）与鉴权失败（不可重试）。
  - `timeout`：可重试。
  - `invalid_output`：不可重试。
  - `aborted`：不可重试。
  - `queue_full`：可重试。
- **并发与背压**：同时最多 `maxConcurrency` 个任务运行，其余按 FIFO 排队；排队数达到 `maxQueueSize` 时新调用立即以 `queue_full` 失败。`signal` 在排队期中止时移出队列、不占用并发槽；运行期中止时取消委托；调用时 `signal` 已中止则立即以 `aborted` 失败。
- **成本控制**：单任务受 `timeoutMs` 和 `maxTurns` 限制（provider 支持时）；`usage` 在 provider 提供时返回，并计入 `health()`。
- **Session 保留**：本包创建的 Session 超过 `sessionRetentionDays` 后清理（依赖 dsh 的删除能力，见「实施前需核实」）。

Config：

| 字段 | 默认值 | 取值范围 |
|---|---|---|
| `workspaceDir` | 无（必填） | 专用目录，不得是业务代码目录 |
| `defaultTimeoutMs` | 600000 | [10000, 3600000] |
| `maxConcurrency` | 2 | [1, 16] |
| `maxQueueSize` | 100 | ≥ 0 |
| `maxTurns` | 20 | ≥ 1 |
| `keepWorkdir` | false | |
| `sessionRetentionDays` | 14 | ≥ 1 |

### ctx.jev：Jev 判断

```ts
const { answers } = await ctx.jev.judge({
  state: { ... },
  questions: {
    isWrong: noul('...', { true: '...', false: '...' }),
    pick: choice('...', { A: '...', B: '...' }),
  },
  signal,
  traceId,
})
```

- 包装 `@typesafe-ai/sdk`，重新导出 `choice`、`noul`、`score` 等问题构造函数与答案类型，保留 SDK 的答案类型推断。`answers` 各字段的结构以 SDK 类型为准，本文档在核实后补充字段含义与阈值使用示例。
- `@typesafe-ai/sdk` 为可选 peer 依赖：只有启用 jev Service 时才需要安装。
- API Key 从 `TYPESAFE_API_KEY` 读取；仅在 jev Service 启用时校验，缺失则该 Service 启动失败。
- `timeoutMs` 是一次 `judge()` 的总时长（包含 SDK 内部重试）；超出或 `signal` 中止时取消请求。
- 请求失败抛出 `JevError`（`KitError`），`code` 与 `retryable`：
  - `unavailable`（网络错误、5xx、超时）：可重试。
  - `rate_limited`（429）：可重试。
  - `unauthorized`（401/403）：不可重试，同时 `health()` 置为 `failed`。
  - `bad_request`：不可重试。
  - `aborted`：不可重试。

Config：

| 字段 | 默认值 | 取值范围 |
|---|---|---|
| `model` | `jev-latest` | SDK 支持的模型名 |
| `timeoutMs` | 30000 | [1000, 300000] |

## 安全

- **凭据不进入子进程**：本包启动的子进程只继承环境变量白名单（`PATH`、`HOME`、`LANG`，以及 dws 运行所需的变量，实施时确定）；`TYPESAFE_API_KEY`、WebSocket 令牌等不传入。Agent 子进程由 subagent provider 启动，能否限制其环境变量见「实施前需核实」；核实前，文档要求部署时不要把与 Agent 无关的密钥放进 Profile 进程环境。
- **不可信数据与提示注入**：来自 WebSocket 的数据一律视为不可信。传给 Agent 时用 `untrusted()` 包裹；Agent 默认 `read-only` 权限，在每个任务独立的空目录内运行；Agent 输出只有经过 Schema 与业务白名单校验后才能触发副作用。
- **命令行注入**：dws 通过 `execFile` 调用，参数使用 `--key=value` 形式，目标 ID 先经过格式校验，`dwsPath` 为绝对路径。
- **统一脱敏**：所有日志与错误对象经过同一个脱敏函数。该函数按已知密钥值精确替换（WebSocket 鉴权头、Jev API Key、webhook token），并截断长文本。消息正文、WebSocket 帧、Agent 原始输出只记录长度与哈希；`ws` 握手错误、dws stderr、`invalid_output` 的原文都经过该函数。
- **传输**：强制 `wss://`，不允许关闭证书校验，不跟随重定向。
- **资源上限**：`maxPayloadBytes`、`maxPendingMessages`、`maxQueueSize` 均有默认值，防止超大帧、消息洪泛和无上限排队。
- **Session 审计数据**：Session 中保存完整 prompt 与输出。部署要求 dsh Web 界面只绑定 `127.0.0.1` 或放在鉴权代理之后，并配合 `sessionRetentionDays` 清理。
- 发给 Claude Code、Codex、TypeSafe 的内容由业务包决定，业务包负责数据最小化。

## 目录结构

```text
dsh-agent-kit/
  package.json            # name: @mc/dsh-agent-kit，type: module，dsh.bundle，files 白名单
  src/
    index.ts              # 导出全部 Service、KitError 与类型
    common/               # KitError、脱敏、子进程终止、健康状态
    ws/  dingtalk/  agent-tasks/  jev/
    testing/              # 以 @mc/dsh-agent-kit/testing 导出
  patch.yml               # bundle 默认 patch 层：以禁用状态注册四个 Service，默认配置
  tests/
    unit/  integration/  e2e/  fixtures/
  docs/superpowers/specs/
```

- `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-*` 均为 `peerDependencies`，版本与目标 dsh 版本精确对齐（当前 dsh `0.1.5-rc.3` 依赖 cordis `4.0.2`），不放进 `dependencies`，避免装出重复实例、破坏 Context 类型扩展。`@typesafe-ai/sdk` 为可选 peer。
- ESM、TypeScript `strict: true`；注册都通过 `ctx.effect()` / `ctx.on()`。
- `@mc/dsh-agent-kit/testing` 导出：本地 WebSocket 测试服务端、假 subagent provider、Jev mock、假 dws 脚本。业务包可以用它们在没有 dws / Agent 登录态的环境下开发和测试。

## 测试

测试框架使用 Vitest；与时间相关的测试（退避、心跳、超时）一律使用假时钟。覆盖率门槛：行 80%、分支 70%。CI 在 Linux 与 macOS 上、按支持的 Node 版本矩阵运行。

### 单元测试

| Service | 覆盖内容 | 方式 |
|---|---|---|
| `agentWs` | 鉴权头（静态与函数，重连时重新获取）；收发；心跳与读超时断开重连；退避延迟上界与 `maxDelayMs` 封顶、稳定后重置；401 与 403 进入 `failed`；`fatalCloseCodes` 进入 `failed`；`fatalRetryDelayMs` 慢速重试；非 JSON 帧与 `parse` 抛错被丢弃且连接可用；超大帧；`concurrency` 与顺序；`maxPendingMessages` 触发暂停读取与恢复；`onMessage` 抛错走 `onError`；`send` 在 connecting / reconnecting / failed 时 reject；`onStateChange` 状态序列；`ws://` 非本机地址被拒；卸载关闭并中止 `onMessage` | 测试内启动本地 `ws` 服务端 |
| `dingtalk` | 各身份的参数拼装；以 `-` 开头的正文不被当成选项；目标 ID 格式校验；单聊、多群与 @ 参数；幂等键透传，非 user 身份只警告一次；默认 target；重试条件；bot 多群部分失败的 `results`；输出解析；超时后子进程确实被终止（无残留）；非零退出；身份与必填字段组合非法时启动失败；`dryRun`；stderr 脱敏 | 假 `dws` 脚本，其输出来自录制的真实 fixture |
| `agentTasks` | provider 原生结构化输出；JSON 提取的全部边界（多个 json 代码块、只有未标注代码块、无代码块整体解析、选中候选非法、空答案）；Schema 校验；超时；`maxConcurrency=N` 时第 N+1 个任务排队且按 FIFO 执行；`maxQueueSize` 触发 `queue_full`；排队期中止不占并发槽；运行期中止取消委托；调用时 `signal` 已中止；任务目录创建与清理；`permissions` 传递给 provider | 注册假 subagent provider |
| `jev` | 请求组装；答案映射；错误分类（5xx、429、401、400、超时）；`timeoutMs` 为总时长；`signal` 中止；缺少 `TYPESAFE_API_KEY` 时 Service 启动失败 | mock `@typesafe-ai/sdk` |
| 通用 | 所有 Config 字段的默认值生效，非法值（负数、0、`maxDelayMs < initialDelayMs`、`readTimeoutMs < 2 × pingIntervalMs` 等）导致启动失败并返回可识别的错误；脱敏：捕获全部日志与错误对象，断言不含 token、API Key、鉴权头与消息正文；`isKitError` 与 `retryable`；`health()` 与 `agent-kit/service-failed` 事件 | — |

### 集成测试

在真实 dsh（锁定版本）中加载 `patch.yml`：默认全部禁用时 Profile 正常启动；只启用部分 Service 时，未启用的 Service 缺少配置不影响启动；启用后四个 Service 都能被 inject；卸载后连接、定时器、子进程全部回收。

### 契约与端到端测试

- 契约：把真实 dws 输出（成功、非零退出、bot 多群部分失败）与真实 subagent 结果录制为 `tests/fixtures/`，纳入版本管理；假 dws 与假 provider 基于这些 fixture，升级 dws 或 dsh 版本时重新录制。
- 端到端冒烟：真实 dws 向测试群发一条消息，真实 subagent 执行一个最小任务，真实 Jev 做一次判断。通过 CI secrets 注入凭据，只在夜间或手动触发时运行，PR 上默认跳过。

测试只使用通用示例数据，不包含任何具体业务项目的数据。

## 发布与安装

```sh
dsh --profile <name> --from-default-profile web
dsh plugin --profile <name> add @mc/dsh-agent-kit <业务包> \
  @deepseek-ai/dsh-subagent-claude-code@0.1.5-rc.3 \
  @deepseek-ai/dsh-subagent-codex@0.1.5-rc.3
```

- subagent 包必须显式指定版本：其 `latest` 标签目前指向 `0.0.1-rc.1`，与 dsh `0.1.5-rc.3` 不匹配。
- 公开发布到 npm。发布前先注册或确认 `@mc` scope 的发布权限，否则更换 scope；发布账号开启 2FA，发布时附带 provenance；`package.json` 用 `files` 白名单限定发布内容，不包含 install 脚本。
- 业务包必须把本包同时声明在 `peerDependencies` 与 `devDependencies` 中，目的是让一个 Profile 只加载一份本包实例（是否生效见「实施前需核实」）；开发期可用 `link:` 指向本地 checkout。
- 按语义化版本发布，不兼容的接口变化升主版本号。
- 运行前提：启用 dingtalk 时本机需已登录 `dws`（服务器环境推荐 `bot` 身份）；启用 agentTasks 时需已登录对应的 Claude Code / Codex。登录态失效会反映在 `health()` 中。
- 部署要求：Profile 进程由 systemd、pm2 等进程守护托管；每条上游连接只部署一个实例；升级时先停旧实例（卸载流程会中止在途任务），失败可回滚到上一个版本号。

## 实施前需核实

以下每一项都要先用原型或文档核实，结论写回本文档后再进入实施。第 1、2 项决定对应 Service 的设计能否成立，优先核实。

1. `ctx.subagents` 能否用未执行任何轮次的根 Agent 作为父 Agent（`SubagentStartRequest` 要求 `parent: Agent`、`prompt: ContentBlock[]`），以及创建根 Agent 所需的最小服务集合；provider 原生 `outputSchema` / `result.structured` 的行为。
2. dws webhook token 能否通过环境变量或文件传入，而不是 `--webhook-token` 命令行参数（命令行参数会出现在 `ps` 中）。如不能，`webhook` 身份在文档中标注为不推荐，或推动 dws 支持。
3. `dws chat +messages-send -f json` 的 JSON 输出格式（含 bot 多群的逐目标结果）与退出码约定；检查 dws 登录态的命令。
4. subagent provider 是否支持工具过滤、禁用 Bash 与网络、限制轮次、限制子进程环境变量，以及如何映射到 `permissions`、`maxTurns`。
5. dsh 如何加载 bundle 的 `patch.yml`，以及如何表达「默认禁用」。
6. `dsh plugin add` 如何解析依赖：peer 声明能否保证一个 Profile 只有一份本包及 cordis 实例。
7. dsh 是否提供删除 Session 的能力，用于 `sessionRetentionDays`。
8. `@typesafe-ai/sdk` 当前版本中 `noul`、`score` 构造函数与答案字段的准确名称和含义、内置重试行为、可用的模型名。

## 评审记录

### 第一轮（2026-09-23）

参与角色：架构、安全、SRE、接入方开发者、测试/QA。结论：需修改。本版做了以下调整：

- 安全：Agent 默认只读，每个任务使用独立目录；新增 `untrusted()`，Agent 输出视为不可信；子进程只继承环境变量白名单；dws 通过 `execFile` 调用，参数使用 `--key=value` 形式；强制 `wss://`；统一脱敏；为帧大小、待处理消息数、排队长度设上限；约束 Web 界面的绑定地址。
- 运维：新增 `failed` 状态、`health()` 与 `agent-kit/service-failed` 事件；fatal 断开后可慢速重试；连接稳定后重置退避；新增背压与 `queue_full`；明确子进程终止规则；定期检查 dws 登录态；明确 Session 保留期、部署与回滚要求。
- 架构：四个 Service 默认禁用、单独启用；`agentTasks` 优先使用 provider 原生结构化输出；dsh/cordis 改为精确版本的 peer 依赖，`@typesafe-ai/sdk` 改为可选 peer；错误判断改为基于 `code`；补充拆包条件与 3 项待核实。
- 接入体验：新增统一的 `KitError`（含 `retryable`）；新增 `onMessage` 的并发、错误与中止语义；新增泛型 `parse` 与 `run<T>`；连接句柄增加 `state`、`close()`、`whenOpen()`；`headers` 支持传函数；钉钉支持单聊、多群、@ 和逐目标结果；新增 `dryRun` 与 `@mc/dsh-agent-kit/testing`；Jev 新增 `signal`，`timeoutMs` 明确为总时长。
- 测试：所有 Config 字段写明默认值与取值范围；测试表补齐缺口；明确 JSON 提取的边界规则；引入假时钟和覆盖率门槛；新增集成测试、fixture 契约测试和夜间端到端测试。
- 暂不采纳：备用告警通道（列为非目标，通过健康状态与事件暴露）；`withRetry` helper 与业务包脚手架（等第二个项目出现时再评估，第一版靠 `retryable` 字段支持调用方自行重试）；A2UI 卡片消息（第一版只支持文本与 Markdown）。
