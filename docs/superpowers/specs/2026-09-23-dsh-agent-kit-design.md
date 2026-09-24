# @mc/dsh-agent-kit 设计

- 日期：2026-09-23
- 状态：已实施（第三版：合入第一轮多角色评审意见，并按「实施前核实结论」调整设计，见文末「核实结论」与「评审记录」）

## 背景

多个项目都需要一个常驻的 Agent Worker：通过 WebSocket 连接业务系统接收事件，把告警推送到钉钉，把需要智能判断的任务交给 Claude Code、Codex 等 Agent 处理，并用 TypeSafe Jev 对结果做校验。这些能力与具体业务无关，每个项目重复实现既浪费又难以维护。

`@mc/dsh-agent-kit` 把这四项能力打包成一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件 Service。各项目的业务逻辑放在各自的业务包中，业务包通过 Cordis `inject` 使用本包提供的 Service。

## 目标

- 提供四个与业务无关的 Service：`ctx.agentWs`、`ctx.dingtalk`、`ctx.agentTasks`、`ctx.jev`。
- 每个 Service 可单独启用；未启用的 Service 不校验配置、不影响其他 Service。
- 每个 Service 的可变参数都是 cordis.yml 中经过校验的 `Config` 字段，均有明确默认值与取值范围。
- 密钥从环境变量读取（Jev 在 macOS 上可选从钥匙串读取），且不传递给任何子进程；钉钉凭据由 `dws` 自己的登录态管理，本包不保存。
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

本包是一个 npm 包，内部每个 Service 一个目录，各自以子路径导出（`@mc/dsh-agent-kit/ws`、`/dingtalk`、`/agent-tasks`、`/jev`）并独立注册。`patch.yml` 中四个 Service 默认以**禁用**状态注册（`disabled: true`，loader 不会 import 禁用行的模块），Profile 按需启用；只有启用的 Service 在加载时校验配置与环境变量。业务包只 inject 用到的 Service。

| loader 行 id | 模块 | Context 属性 | 依赖的其他 Service |
|---|---|---|---|
| `agent-kit-ws` | `@mc/dsh-agent-kit/ws` | `ctx.agentWs` | 无 |
| `agent-kit-dingtalk` | `@mc/dsh-agent-kit/dingtalk` | `ctx.dingtalk` | 无 |
| `agent-kit-agent-tasks` | `@mc/dsh-agent-kit/agent-tasks` | `ctx.agentTasks` | `subagents`（dsh-subagent） |
| `agent-kit-jev` | `@mc/dsh-agent-kit/jev` | `ctx.jev` | 无 |

在 Profile 的 `cordis.patch.yml` 中按 id 启用，例如：

```yaml
- id: agent-kit-dingtalk
  disabled: false
  config:
    identity: bot
    robotCode: dingxxxx
    defaultTarget: { chatId: cidxxxx }
```

按 id 修改 `config` 时整段替换，不与 bundle 中的值合并；未给出的字段取 Config 默认值。

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
  details?: Record<string, unknown>  // 已脱敏
}
export function isKitError(e: unknown): e is KitError
```

配置或环境变量非法时抛出 `ConfigError`（`code: invalid_config`），对应 Service 启动失败。

- 业务包用 `isKitError()` 与 `code` 判断错误，不依赖 `instanceof`（避免多份实例时判断失效；实现上用 `Symbol.for` 标记）。
- 错误信息与 `cause` 在构造时经过统一脱敏（见「安全」）。

### 生命周期与卸载

- 所有长期资源（连接、定时器、子进程、排队中的任务）都通过 `ctx.effect()` 注册，随调用方插件卸载而释放。
- 卸载时：WebSocket 以 1001 关闭；正在执行的 `onMessage` 收到的 `signal` 被中止；`agentTasks` 排队和运行中的任务以 `aborted` 结束；dws 子进程按「子进程终止」规则回收。

### 子进程终止

本包自己启动的子进程（dws）以独立进程组启动、不经过 shell；超时或卸载时先向进程组发 SIGTERM，宽限 `killGraceMs`（默认 5000）后发 SIGKILL，父进程退出后再向进程组补发一次 SIGKILL，确保孙进程也被回收。子进程只继承环境变量白名单（见「安全」）。

### 健康状态与可观测性

- 每个启用的 Service 提供 `health()`，返回 `{ status: 'ok' | 'degraded' | 'failed', detail, counters }`，counters 至少包括：
  - agentWs：当前状态、重连次数、最近一次收到帧的时间、待处理消息数。
  - dingtalk：成功、失败次数，最近一次失败时间与错误码。
  - agentTasks：运行中数、排队数、按结果分类的完成数、耗时分布。
  - jev：成功、失败次数（按错误码）。
- 状态变为 `failed` 时，除日志外还触发 Cordis 事件 `agent-kit/service-failed`（参数 `{ service, detail, error? }`，已脱敏），业务包或 Profile 可据此向外部监控上报。只在从非 failed 变为 failed 时触发一次；恢复后再次失败会再次触发。
- 日志为结构化字段，所有 Service 调用接受可选的 `traceId` 并写入日志，便于用事件 ID 串起一次处理链路。日志通过 `ctx.logger('agent-kit:<service>')` 输出；注意 cordis 默认只导出 error / info 级别，warn / debug 需要在 Profile 的日志 exporter 中调高级别。

## Service 接口

以下为已实现的接口。

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
- 断线后按指数退避加抖动自动重连：第 n 次延迟为 `min(maxDelayMs, initialDelayMs × 2^n) × (1 − jitter × random)`，抖动只向下，保证不超过 `maxDelayMs`；连接稳定保持 `stableResetMs` 后退避时间重置为初始值（为 0 时一连上即重置）。
- 握手返回 401/403，或连接以 `fatalCloseCodes` 中的关闭码断开时，视为鉴权或配置错误：状态置为 `failed`，`health()` 返回 `failed` 并触发 `agent-kit/service-failed`。若 `fatalRetryDelayMs > 0`，则按该间隔慢速重试（重试前重新获取 `headers`）；为 0 时不再重试，由进程托管或人工恢复。
- 客户端定时发送 WS ping，超过读超时未收到任何帧（含 pong）则主动断开并重连。背压暂停读取期间读超时暂停计时。
- `onStateChange` 在 `connect()` 时先收到 `connecting`；之后的状态序列例如 `open → reconnecting → open → closed`，fatal 后慢速重试为 `failed → connecting → open`。
- 背压说明：`ws.pause()` 只停止继续读取 socket，已进入接收缓冲区的帧仍会被解析，因此暂停时待处理数可能略高于 `maxPendingMessages`。

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
  markdown: '## 标题\n正文',             // 或 text: '纯文本'，二选一
  title: '标题',
  target: { chatId: 'cid...' },          // 或 { userId } / { openDingtalkId } / { chatIds: [...] }（仅 bot）
  at: { userIds: ['...'], all: false },  // 另有 openDingtalkIds（user / bot）、mobiles（仅 webhook）
  idempotencyKey: 'evt_...',
  traceId: 'evt_...',
  signal,                                // 可选，中止时终止 dws 子进程
})
// r: { results: Array<{ target, ok: boolean, messageId?: string, error?: KitError }> }
```

- 调用 `dws chat +messages-send` 子进程：不经过 shell，参数统一写成 `--key=value` 形式，避免以 `-` 开头的正文被当成选项（已用真实 dws 验证）；固定附加 `--yes --format=json`，保证常驻进程不会卡在交互确认上；超时后按「子进程终止」规则回收。
- `dwsPath` 必须为绝对路径（默认在启动时通过 `PATH` 解析为绝对路径并记录）。
- `target` 省略时使用配置的 `defaultTarget`；`chatId`、`userId`、`openDingtalkId`、`robotCode`、@ 列表与幂等键在拼装参数前用正则校验格式，并拒绝以 `-` 开头的值（`invalid_target`）。单次调用的 `target` 覆盖默认值，多个业务包共用本包时互不影响。
- 目标与身份矩阵（以 dws v1.0.62 为准）：

  | 身份 | `chatId` | `chatIds` | `userId` | `openDingtalkId` | @ 参数 | 幂等键 |
  |---|---|---|---|---|---|---|
  | `user` | `--chat-id` | 不支持 | `--user` | `--open-dingtalk-id` | `openDingtalkIds`、`all` | 支持 |
  | `bot` | `--groups`（单个） | `--groups`（≤ 100，去重） | `--users` | `--open-dingtalk-ids` | `userIds`、`openDingtalkIds`、`all` | 忽略 |
  | `webhook` | 不允许传 target，目标由 token 所在群决定 | | | | `userIds`、`mobiles`、`all` | 忽略 |

  bot 身份统一走 `--groups` / `--users` 等批量参数，dws 返回 `im.batch-write.v1` 逐目标 ledger。
- `idempotencyKey` 在 `user` 身份下透传为 `--idempotency-key`，其他身份下忽略并只记录一次警告。
- 自动重试：仅在 `user` 身份且给出 `idempotencyKey` 时，对 `retryable` 的失败（超时，或 dws 错误类别为 network / timeout / rate_limit / server / unavailable）最多重试 `retry.maxAttempts` 次，间隔 500ms 起指数增长；其他情况不自动重试，避免重复发送。
- 失败抛出 `DingtalkSendError`（`KitError`），`code` 为 `timeout`（可重试）、`exit_nonzero`（按 dws 错误类别决定是否可重试）、`bad_output`、`invalid_target`、`send_failed`、`aborted`、`spawn_failed` 之一，`details` 中包含退出码、dws 错误类别和经过脱敏、截断的 stderr 摘要（dws 失败时把 `{ error: { category, code, message } }` 写到 stderr）。bot 批量发送的部分失败（乃至全部失败）不抛错，体现在 `results` 中。
- `dryRun: true` 时附加 `--dry-run`，只做参数解析与日志、不真实发送，用于本地开发与测试。
- 加载时校验身份与必填字段的组合、`dwsPath` 可执行、`defaultTarget` 格式，不合法则该 Service 启动失败。启动时及每隔 `preflightIntervalMs` 执行 `dws auth status --format=json` 检查登录态（`authenticated` 且 token 或 refresh token 有效），失效时 `health()` 返回 `failed` 并触发事件；`webhook` 身份与 `dryRun` 不做该检查。
- `webhook` 身份：dws 只支持以 `--webhook-token` 命令行参数传入 token（会出现在 `ps` 中），因此**不推荐**，启动时记录警告；token 从 `webhookTokenEnv` 指定的环境变量读取并登记为脱敏密钥。

Config：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `identity` | 无（必填） | `user` \| `bot` \| `webhook`。服务器环境推荐 `bot`，`user` 依赖个人登录态 |
| `defaultTarget` | 无 | 省略 `target` 时使用 |
| `robotCode` | 无 | `bot` 身份必填 |
| `webhookTokenEnv` | 无 | `webhook` 身份必填，环境变量名（不推荐该身份，见上） |
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
    untrusted('event', eventJson),   // 本包导出，用随机分隔标记包裹外部数据并声明其不是指令
  ],
  outputSchema,                      // JSONSchemaType<Verdict>；省略时 output 为 undefined
  model: 'optional-model-id',        // 仅传给声明了 agentOptions 能力的 provider
  permissions: 'read-only',          // 默认值
  timeoutMs: 120_000,
  signal,
  traceId,
  onEvent: (e) => {},                // 可选：queued / started / finished 生命周期事件
})
// r: { sessionId, taskId, text, output: Verdict, durationMs }
```

- `provider` 是 `ctx.subagents` 中已注册的 provider 名称，例如 `claude-code`、`codex`。本 Service `inject: ['subagents']`；`ctx.subagents`（`@deepseek-ai/dsh-subagent`）与 provider 依赖的 `subprocess` 服务已由 dsh 的 base bundle 加载，Profile 只需安装对应 provider。
- **委托方式**：每个任务通过 `ctx.subagents.start(provider, request)` 发起一次性委托。`parent` 使用一个只含 `session.header.cwd` 的桩对象，不创建根 Session（核实结论第 1 项）；`sessionId` 为 provider 返回的运行 ID。claude-code / codex 本身不持久化 Session，因此这些任务**不会**出现在 dsh Web 界面中；审计依赖本包的结构化日志（只记录长度与哈希）与业务包自己的记录。
- **隔离与权限**：
  - 每个任务在 `workspaceDir/<taskId>/` 下使用一个新建的空目录（权限 0700）作为 Agent 的 cwd，结束后删除（`keepWorkdir: true` 时保留，便于排查）。`workspaceDir` 必须是绝对路径，且不能是进程工作目录或其祖先。
  - `permissions` 默认 `read-only`，可选 `workspace-write`，不提供更高档位。映射方式：
    - provider 支持工具过滤（`capabilities.toolFilter`，如 dsh 进程内 provider）时，传入工具白名单 `toolFilter.allow`：`read-only` 为 `read`、`read_image`、`glob`、`grep`、`todo_write`；`workspace-write` 另加 `write`、`edit`、`str_replace_editor`（可通过 `toolAllowlist` 调整）。白名单之外的工具（含 bash、网络）都不可见。
    - provider 不支持工具过滤（claude-code、codex）时，权限由该 provider 实例自身的配置决定。运维必须在 `declaredPermissions` 中声明该 provider 的实际权限上限；未声明、或声明的上限高于本次请求的档位时，任务以 `unsupported_permissions` 失败（fail-closed）。已验证 claude-code 默认的 `permissionMode: dontAsk` 下 Agent 不能执行命令、不能写文件，可声明为 `read-only`。
  - Agent 的 `text` 与 `output` 视为不可信数据：本包只做 Schema 校验，业务包在据此触发推送等副作用前必须按白名单校验取值。
- **结构化输出**：给出 `outputSchema` 时，若 provider 声明了 `outputSchema` 能力（目前只有 dsh 进程内 provider）且 Schema 顶层为 object，使用原生结构化输出（`result.structured`）；否则（claude-code、codex）在 prompt 末尾追加「在一个 json 代码块中输出符合该 JSON Schema 的结果」的要求，并从最终答案中提取 JSON：
  - 取最后一个标注为 `json` 的代码块；没有则取最后一个未标注语言的代码块；都没有则把整段答案作为 JSON 解析。
  - 选中的候选解析失败时直接判为 `invalid_output`，不回退到更早的代码块。
  - 空答案判为 `invalid_output`。
  - 解析结果（含原生结构化结果）一律再用 Ajv 校验，通过后放入 `output`，类型由 `outputSchema` 推断。
- 失败抛出 `AgentTaskError`（`KitError`），`code` 与 `retryable`：
  - `provider_failed`：provider 未注册、委托基础设施出错（可重试），或 provider 以 `error` / `refusal` / `max-tokens` 结束。按 provider 的诊断信息细分：限流（可重试）；鉴权失败（不可重试，同时 `health()` 置为 `failed`，下次成功后恢复）；其他不可重试。
  - `timeout`：可重试。
  - `invalid_output`：不可重试。
  - `aborted`：不可重试。
  - `queue_full`：可重试。
  - `unsupported_permissions`：不可重试，见上。
- **并发与背压**：同时最多 `maxConcurrency` 个任务运行，其余按 FIFO 排队；排队数达到 `maxQueueSize` 时新调用立即以 `queue_full` 失败，`health()` 为 `degraded`。`signal` 在排队期中止时移出队列、不占用并发槽；运行期中止时取消委托；调用时 `signal` 已中止则立即以 `aborted` 失败；Service 卸载时排队和运行中的任务都以 `aborted` 结束。
- **成本控制**：单任务受 `timeoutMs` 限制，超时即取消委托。provider 不提供轮次上限与 usage（核实结论第 4 项），因此不再提供 `maxTurns` 配置，结果中也没有 `usage`；`health()` 统计按结果分类的完成数与耗时分布（p50 / p95 / max）。
- **子进程环境变量**：provider 启动 Agent 时会剔除名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量与 `DSH_*`。若 Agent 依赖这类变量鉴权（例如 `ANTHROPIC_AUTH_TOKEN`），需要在 provider 自己的 Config `env` 中显式给出；本包的密钥（`TYPESAFE_API_KEY` 等）因此不会进入 Agent 进程。

Config：

| 字段 | 默认值 | 取值范围 |
|---|---|---|
| `workspaceDir` | 无（必填） | 绝对路径的专用目录，不得是进程工作目录或其祖先 |
| `defaultTimeoutMs` | 600000 | [10000, 3600000] |
| `maxConcurrency` | 2 | [1, 16] |
| `maxQueueSize` | 100 | ≥ 0 |
| `keepWorkdir` | false | |
| `declaredPermissions` | `{}` | provider 名 → `read-only` \| `workspace-write`，用于不支持工具过滤的 provider |
| `toolAllowlist` | 见上 | `{ 'read-only': string[], 'workspace-write': string[] }`，用于支持工具过滤的 provider |

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

- 包装 `@typesafe-ai/sdk`（0.6）的 `client.systemOne()`。本包在主入口中按 SDK 的线上格式重新定义 `choice`、`noul`、`score` 问题构造函数与答案类型（测试保证与 SDK 输出一致），未启用 jev 的项目无需安装 SDK；答案类型按问题推断：
  - `noul(instructions, { true, false })` → `{ type: 'noul', noul }`，`noul` 为回答"是"（true）的概率，范围 [0, 1]。
  - `choice(instructions, { A: 描述, B: 描述 })` → `{ type: 'choice', choice: 'A' | 'B', confidence, probabilities: { A, B } }`。
  - `score(instructions, [档位0描述, 档位1描述, ...])` → `{ type: 'score', score, confidence, legend, probabilities }`，`score` 为期望分数，可能介于整数档位之间。
  - 阈值示例：`if (answers.wrong.noul >= 0.7) escalate()`；`if (answers.pick.confidence < 0.6) askHuman()`。
- 返回 `{ model, answers, usage? }`。
- `@typesafe-ai/sdk` 为可选 peer 依赖：只有启用 jev Service 时才需要安装。
- API Key 优先从 `TYPESAFE_API_KEY` 读取。未设置且配置了 `keychainService` 时，在 macOS 上通过 `/usr/bin/security find-generic-password -a <keychainAccount> -s <服务名> -w` 读取钥匙串（不经过 shell、5 秒超时、环境变量白名单），`keychainService` 可给多个服务名按顺序尝试，读到的值同样登记为脱敏密钥。与其他工具共享 TypeSafe Key 时统一使用中立服务名 `ai.typesafe.api-key`（导出常量 `SHARED_KEYCHAIN_SERVICE`；gitflow-cli 的迁移见 byx-darwin/gitflow-cli#407），迁移期可配置为 `[ai.typesafe.api-key, gitflow-cli-typesafe]`。非 macOS 上 `keychainService` 被忽略并记录警告。仅在 jev Service 启用时校验，两处都取不到则该 Service 启动失败。
- `timeoutMs` 是一次 `judge()` 的总时长（包含 SDK 内部重试）；超出或 `signal` 中止时取消请求。SDK 默认对 408 / 429 / 5xx 与连接错误最多重试 2 次，其 `timeout` 只约束单次尝试，因此本包用自己的定时器与 `AbortSignal` 控制总时长。创建 SDK 客户端时 `logLevel: 'off'`，避免 SDK 在 debug 日志中输出请求体。
- 请求失败抛出 `JevError`（`KitError`），`code` 与 `retryable`：
  - `unavailable`（网络错误、5xx、408、超时）：可重试。
  - `rate_limited`（429）：可重试。
  - `unauthorized`（401/403）：不可重试，同时 `health()` 置为 `failed`。
  - `bad_request`（其余 4xx 与参数错误）：不可重试。
  - `aborted`：不可重试。

Config：

| 字段 | 默认值 | 取值范围 |
|---|---|---|
| `model` | `jev-latest` | SDK 支持的模型名（可用 `client.models.list()` 查询）；单次调用可用 `model` 覆盖 |
| `timeoutMs` | 30000 | [1000, 300000] |
| `keychainService` | 无 | macOS 钥匙串服务名或服务名列表（按顺序尝试），推荐 `ai.typesafe.api-key`；仅在未设置 `TYPESAFE_API_KEY` 时读取 |
| `keychainAccount` | `$USER` | 钥匙串条目的账户名 |

## 安全

- **凭据不进入子进程**：本包启动的子进程（dws）只继承环境变量白名单：`PATH`、`HOME`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TZ`、`TMPDIR`、`USER`、`LOGNAME`，以及 dws 所需的 `DWS_CONFIG_DIR`、`DWS_KEYCHAIN_DIR`、`DWS_DISABLE_KEYCHAIN`、`XDG_CONFIG_HOME`（已验证 dws 在该环境下可读取登录态）；`TYPESAFE_API_KEY`、WebSocket 令牌等不传入。Agent 子进程由 subagent provider 启动，provider 会剔除名字含 KEY / PASSWORD / SECRET / TOKEN 的变量，Agent 需要的凭据由 provider 自己的 Config `env` 显式给出。
- **不可信数据与提示注入**：来自 WebSocket 的数据一律视为不可信。传给 Agent 时用 `untrusted()` 包裹（每次生成随机的分隔标记，外部数据无法伪造结束标记）；Agent 默认 `read-only` 权限，在每个任务独立的空目录内运行；不支持工具过滤的 provider 需显式声明权限上限，否则拒绝运行；Agent 输出只有经过 Schema 与业务白名单校验后才能触发副作用。
- **命令行注入**：dws 不经过 shell 调用，参数使用 `--key=value` 形式，目标 ID 先经过格式校验，`dwsPath` 为绝对路径。
- **统一脱敏**：所有日志与错误对象经过同一个脱敏函数。该函数按已登记的密钥值精确替换（WebSocket 鉴权头的值在每次连接前登记、Jev API Key、webhook token），把名字形如 authorization / token / secret / api key / password / cookie 的字段整体替换，并截断长文本。消息正文、WebSocket 帧、prompt 与 Agent 原始输出只记录长度与哈希；`ws` 握手错误、dws stderr、`invalid_output` 的原因都经过该函数。
- **传输**：强制 `wss://`，不允许关闭证书校验，不跟随重定向。
- **资源上限**：`maxPayloadBytes`、`maxPendingMessages`、`maxQueueSize` 均有默认值，防止超大帧、消息洪泛和无上限排队。
- **Session 审计数据**：claude-code / codex 委托不产生 dsh Session。若业务包自行使用会持久化 Session 的 provider，Session 中保存完整 prompt 与输出，部署要求 dsh Web 界面只绑定 `127.0.0.1` 或放在鉴权代理之后。
- 发给 Claude Code、Codex、TypeSafe 的内容由业务包决定，业务包负责数据最小化。

## 目录结构

```text
dsh-agent-kit/
  package.json            # name: @mc/dsh-agent-kit，type: module，dsh.bundle.patch，files 白名单，子路径 exports
  src/
    index.ts              # 导出全部 Service、KitError、untrusted()、Jev 问题构造函数与类型
    common/               # KitError、脱敏、子进程终止、健康状态与 Service 基类
    ws/  dingtalk/  agent-tasks/  jev/   # 各自的 index.ts 默认导出 Service 类，供 loader 按子路径加载
    testing/              # 以 @mc/dsh-agent-kit/testing 导出
  fixtures/fake-dws.mjs   # 假 dws 脚本（随包发布，供 testing 使用）
  patch.yml               # bundle 默认 patch 层：以禁用状态注册四个 Service
  tests/
    unit/  integration/  e2e/  fixtures/dws/   # fixtures 为录制的真实 dws 输出
  docs/superpowers/specs/
```

- `@deepseek-ai/cordis`（`4.0.2`）与 `@deepseek-ai/schemastery`（`^3.18.2`）为 `peerDependencies`，版本与目标 dsh 版本对齐（dsh `0.1.5-rc.3` 依赖 cordis `4.0.2`），不放进 `dependencies`，避免装出重复实例、破坏 Context 类型扩展。`@typesafe-ai/sdk` 为可选 peer。本包不 import `@deepseek-ai/dsh-subagent`，而是按其结构定义所需的类型，避免强制依赖并避免与其 Context 类型扩展冲突。运行时依赖只有 `ws` 与 `ajv`。
- ESM、TypeScript `strict: true`；注册都通过 `ctx.effect()` / `ctx.on()`。
- `@mc/dsh-agent-kit/testing` 导出（业务包可以用它们在没有 dws / Agent 登录态的环境下开发和测试）：
  - `startTestWsServer()`：本机随机端口的 WebSocket 服务端，可模拟握手拒绝（`rejectNext(401)`）、关闭自动 pong、广播帧，并记录握手头与收到的帧。
  - `FakeSubagentProvider`（结构与 dsh-subagent 的 provider 一致，可注册到真实 `ctx.subagents`）与 `FakeSubagentRuntime`（没有 dsh-subagent 时提供最小的 `ctx.subagents`）。
  - `createJevMock()`：替换 JevService 的 SDK 客户端，默认按问题生成确定的答案；`jevHttpError(status)` 模拟 HTTP 错误。
  - `createFakeDws()` / `fakeDwsPath`：假 dws 脚本，场景（成功、失败、挂起、非法输出、bot 部分失败、登录态失效）从 `$DWS_CONFIG_DIR/fake-dws.json` 读取，并记录每次调用的参数与环境变量名。

## 测试

测试框架使用 Vitest；与时间相关的测试（退避、心跳、超时）一律使用假时钟。覆盖率门槛：行 80%、分支 70%（当前约为行 97%、分支 89%）。CI 在 Linux 与 macOS 上、按支持的 Node 版本矩阵运行（`.github/workflows/ci.yml`）。

### 单元测试

| Service | 覆盖内容 | 方式 |
|---|---|---|
| `agentWs` | 鉴权头（静态与函数，重连时重新获取）；收发；心跳与读超时断开重连；退避延迟上界与 `maxDelayMs` 封顶、稳定后重置；401 与 403 进入 `failed`；`fatalCloseCodes` 进入 `failed`；`fatalRetryDelayMs` 慢速重试；非 JSON 帧与 `parse` 抛错被丢弃且连接可用；超大帧；`concurrency` 与顺序；`maxPendingMessages` 触发暂停读取与恢复；`onMessage` 抛错走 `onError`；`send` 在 connecting / reconnecting / failed 时 reject；`onStateChange` 状态序列；`ws://` 非本机地址被拒；卸载关闭并中止 `onMessage` | 测试内启动本地 `ws` 服务端 |
| `dingtalk` | 各身份的参数拼装；以 `-` 开头的正文不被当成选项；目标 ID 格式校验；单聊、多群与 @ 参数；幂等键透传，非 user 身份只警告一次；默认 target；重试条件；bot 多群部分失败的 `results`；输出解析；超时后子进程确实被终止（无残留）；非零退出；身份与必填字段组合非法时启动失败；`dryRun`；stderr 脱敏 | 假 `dws` 脚本，其输出来自录制的真实 fixture |
| `agentTasks` | provider 原生结构化输出；JSON 提取的全部边界（多个 json 代码块、只有未标注代码块、无代码块整体解析、选中候选非法、空答案）；Schema 校验；超时；`maxConcurrency=N` 时第 N+1 个任务排队且按 FIFO 执行；`maxQueueSize` 触发 `queue_full`；排队期中止不占并发槽；运行期中止取消委托；调用时 `signal` 已中止；任务目录创建与清理；`permissions` 传递给 provider | 注册假 subagent provider |
| `jev` | 请求组装；答案映射；错误分类（5xx、429、401、400、超时）；`timeoutMs` 为总时长；`signal` 中止；缺少 `TYPESAFE_API_KEY` 时 Service 启动失败 | mock `@typesafe-ai/sdk` |
| 通用 | 所有 Config 字段的默认值生效，非法值（负数、0、`maxDelayMs < initialDelayMs`、`readTimeoutMs < 2 × pingIntervalMs` 等）导致启动失败并返回可识别的错误；脱敏：捕获全部日志与错误对象，断言不含 token、API Key、鉴权头与消息正文；`isKitError` 与 `retryable`；`health()` 与 `agent-kit/service-failed` 事件 | — |

### 集成测试

用 dsh 自己的启动流程（`@deepseek-ai/dsh-app-boot` 的 `boot()` 与 bundle patch 加载，锁定版本）加载已构建的 `lib/` 与 `patch.yml`：默认全部禁用时 Profile 正常启动；只启用部分 Service 时，未启用的 Service 缺少配置不影响启动；启用的 Service 配置非法时启动失败；启用后四个 Service 与真实 `dsh-subagent` 一起都能被 inject 并协同工作；卸载后连接以 1001 关闭、在途 dws 子进程及其子进程全部回收。

### 契约与端到端测试

- 契约：真实 dws 输出录制在 `tests/fixtures/dws/`（`--mock` 下的 user 单发与 bot 多群成功、各身份的 `--dry-run`、参数校验失败的 stderr 与退出码、`auth status`），解析器直接以这些 fixture 做测试，假 dws 的输出结构与之一致；升级 dws 版本时重新录制。bot 多群部分失败时 `failures` 条目的真实结构需要真实机器人发送才能录制，目前按 `im.batch-write.v1` 的 `{ target, ... }` 约定宽松解析（取 `error.message` / `message` / `reason`），待首次夜间端到端运行时补录。subagent 结果的结构（`{ output, structured?, diagnostic?, stopReason }`）来自 dsh-subagent 的类型定义，并由真实 claude-code 端到端测试覆盖。
- 端到端冒烟（`npm run test:e2e`）：真实 dws 向测试群或指定用户（单聊）发一条消息，真实 subagent 执行一个最小任务并验证默认权限下不能执行命令或写文件，真实 Jev 做一次判断。每项通过环境变量单独启用（见 `tests/e2e/smoke.test.ts`），通过 CI secrets 注入凭据，只在夜间或手动触发时运行（`.github/workflows/e2e.yml`），PR 上默认跳过。

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
- 业务包必须把本包同时声明在 `peerDependencies` 与 `devDependencies` 中，目的是让一个 Profile 只加载一份本包实例（见「核实结论」第 6 项）；开发期可用 `link:` 指向本地 checkout。
- 按语义化版本发布，不兼容的接口变化升主版本号。
- 运行前提：启用 dingtalk 时本机需已登录 `dws`（服务器环境推荐 `bot` 身份）；启用 agentTasks 时需安装对应 provider（`ctx.subagents` 与 `subprocess` 服务由 dsh 的 base bundle 提供，行 id 分别为 `subagent`、`subprocess`），并已登录对应的 Claude Code / Codex（依赖 token 类环境变量鉴权时，经 provider 的 Config `env` 显式传入）。登录态失效会反映在 `health()` 中。
- 部署要求：Profile 进程由 systemd、pm2 等进程守护托管；每条上游连接只部署一个实例；升级时先停旧实例（卸载流程会中止在途任务），失败可回滚到上一个版本号。

## 核实结论

以下各项已在实施前用原型、源码阅读或真实命令核实（dsh `0.1.5-rc.3`、dws `v1.0.62`、`@typesafe-ai/sdk` `0.6.0`），结论已体现在上文设计中。

1. **父 Agent 与结构化输出**：`ctx.subagents.start(name, request)` 的 `parent` 在 claude-code / codex provider 中只被读取 `session.header.cwd`，runtime 只把它当作事件作用域的键；只有返回 `localAgent` 的 provider 才需要真实 Session。因此用只含 cwd 的桩对象作为父 Agent，不需要创建根 Agent（真实 claude-code 端到端测试已通过）。claude-code / codex 不支持 `outputSchema`（能力声明全为 false，传入会被拒绝），只有 dsh 进程内 provider 支持原生 `result.structured`，所以结构化输出以文本提取为主、原生为辅。
2. **webhook token**：dws 不支持从环境变量或文件读取 webhook token，只能用 `--webhook-token` 参数。`webhook` 身份标注为不推荐，启动时警告。
3. **dws 输出与登录态**：成功时 stdout 为 JSON（单目标 `{ ok, result, sendReceipt }`；bot 批量为 `im.batch-write.v1`：`{ succeeded: [{ target, result }], failures: [...], partial }`；`--dry-run` 为 `{ dry_run: true, actions }`）；失败时非零退出并在 stderr 输出 `{ error: { category, code, message } }`（例如参数校验错误 `category: validation`、退出码 3）。登录态用 `dws auth status --format=json`。录制的输出见 `tests/fixtures/dws/`。
4. **provider 能力**：claude-code / codex 不支持工具过滤、禁用 Bash / 网络、轮次上限，也不返回 usage；权限由 provider 实例配置决定（claude-code `permissionMode` 默认 `dontAsk`，codex 默认 `never`）。provider 启动子进程时剔除含 KEY / PASSWORD / SECRET / TOKEN 的环境变量，所需凭据经其 Config `env` 显式传入。因此：`permissions` 对这类 provider 采用「运维声明 + fail-closed」；删除 `maxTurns` 配置与结果中的 `usage`。
5. **bundle 加载与默认禁用**：dsh 读取 `package.json` 的 `dsh.bundle.patch`，patch 文件为 YAML 数组；`- insert: [{ id, name, disabled: true }]` 注册一行禁用的插件，禁用行的模块不会被 import、配置不会被校验。Profile 用 `- id: <id>` 加 `disabled: false` 与 `config` 启用（`config` 整段替换）。
6. **依赖解析**：`dsh plugin add` 使用 pnpm（`nodeLinker: hoisted`、`autoInstallPeers: false`），并把 dsh 安装的依赖闭包链接到 Profile 的上级 `node_modules`。cordis、schemastery 声明为 peer 时使用 dsh 自带的唯一实例；若放进 `dependencies` 会装出第二份遮蔽它。业务包把本包声明为 peer 时同理只有一份本包实例。
7. **Session 删除**：dsh 没有删除 Session 的 API（只有 `WorkspaceRegistry.archiveSession()` 隐藏）。claude-code 以 `persistSession: false`、codex 以 `ephemeral: true` 运行，不产生本地 Session，因此删除 `sessionRetentionDays`。
8. **TypeSafe SDK**：入口为 `new TypeSafeClient({ apiKey, defaultModel, timeout, retry })` 与 `client.systemOne({ state, questions, model? }, { signal })`；问题构造函数为 `noul`、`choice`、`score`，答案字段见「ctx.jev」；默认模型 `jev-latest`；默认最多重试 2 次，`timeout` 为单次尝试超时，没有总时长预算；错误类为 `APIError` 子类（按 HTTP 状态）、`APIConnectionError`、`APITimeoutError`、`APIUserAbortError`。

## 评审记录

### 第一轮（2026-09-23）

参与角色：架构、安全、SRE、接入方开发者、测试/QA。结论：需修改。本版做了以下调整：

- 安全：Agent 默认只读，每个任务使用独立目录；新增 `untrusted()`，Agent 输出视为不可信；子进程只继承环境变量白名单；dws 通过 `execFile` 调用，参数使用 `--key=value` 形式；强制 `wss://`；统一脱敏；为帧大小、待处理消息数、排队长度设上限；约束 Web 界面的绑定地址。
- 运维：新增 `failed` 状态、`health()` 与 `agent-kit/service-failed` 事件；fatal 断开后可慢速重试；连接稳定后重置退避；新增背压与 `queue_full`；明确子进程终止规则；定期检查 dws 登录态；明确 Session 保留期、部署与回滚要求。
- 架构：四个 Service 默认禁用、单独启用；`agentTasks` 优先使用 provider 原生结构化输出；dsh/cordis 改为精确版本的 peer 依赖，`@typesafe-ai/sdk` 改为可选 peer；错误判断改为基于 `code`；补充拆包条件与 3 项待核实。
- 接入体验：新增统一的 `KitError`（含 `retryable`）；新增 `onMessage` 的并发、错误与中止语义；新增泛型 `parse` 与 `run<T>`；连接句柄增加 `state`、`close()`、`whenOpen()`；`headers` 支持传函数；钉钉支持单聊、多群、@ 和逐目标结果；新增 `dryRun` 与 `@mc/dsh-agent-kit/testing`；Jev 新增 `signal`，`timeoutMs` 明确为总时长。
- 测试：所有 Config 字段写明默认值与取值范围；测试表补齐缺口；明确 JSON 提取的边界规则；引入假时钟和覆盖率门槛；新增集成测试、fixture 契约测试和夜间端到端测试。
- 暂不采纳：备用告警通道（列为非目标，通过健康状态与事件暴露）；`withRetry` helper 与业务包脚手架（等第二个项目出现时再评估，第一版靠 `retryable` 字段支持调用方自行重试）；A2UI 卡片消息（第一版只支持文本与 Markdown）。

### 实施（2026-09-23）

- 新增 Jev 的可选钥匙串读取（`keychainService` / `keychainAccount`），与 gitflow-cli 共享 TypeSafe key。
- 按核实结论调整：agentTasks 改用桩父 Agent，不创建根 Session、不在 Web 界面审计；删除 `maxTurns`、`sessionRetentionDays` 与结果中的 `usage`；不支持工具过滤的 provider 需在 `declaredPermissions` 中声明权限上限，新增错误码 `unsupported_permissions`；webhook 身份标注为不推荐。
- 补充：dingtalk 支持 `text` 正文、调用级 `signal`，新增错误码 `send_failed`、`aborted`、`spawn_failed`；各 Config 的输入类型允许省略有默认值的字段（导出 `ConfigInput`）；Jev 问题构造函数在本包内按 SDK 线上格式重新定义，使 SDK 成为真正可选的依赖。
- 端到端：dingtalk 以 user 身份单聊发送、agentTasks 真实 claude-code 任务、Jev 真实判断均已在本地跑通（2026-09-24）。
