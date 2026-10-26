# 企业微信渠道设计

- 日期：2026-10-26
- 状态：设计已确认，待实施
- 前置文档：[2026-10-21-channel-contract-notify-design.md](2026-10-21-channel-contract-notify-design.md)、[2026-10-21-feishu-channel-design.md](2026-10-21-feishu-channel-design.md)（均已合并）

## 背景

渠道公共约定（`ChannelService`、`ChannelInbox`、`MessageRouter`、`UnmatchedStore`）和飞书渠道已经合并。本设计接入企业微信，能力与钉钉、飞书对齐：发送通知，接收群内 @ 机器人与单聊机器人的消息并分发给业务插件。同时补上飞书那轮推迟的两项：处理函数的回复入口，以及 admin 中通用的收件人选择组件。

已确定的决策：

| 项 | 决定 |
|---|---|
| 身份 | 企业微信「智能机器人」（BotID + Secret），长连接，不需要公网地址 |
| 接入方式 | 进程内使用 `@wecom/aibot-node-sdk`（可选 peer 依赖，`^1.0.7`），经窄接口 `WecomSdk` 隔离（与飞书相同的结构） |
| 回复入口 | 三个渠道的处理函数第二个参数统一为 `{ signal, reply }` |
| 主动发送目标 | 记录「说过话的会话」，设置页与 `searchRecipients` 从中选择；未互动的会话报 `not_interacted` |
| admin | 与飞书对齐；收件人选择组件抽为通用组件 |

SDK 能力（1.0.7 已核实）：
- `WSClient({ botId, secret, logger, maxReconnectAttempts, maxAuthFailureAttempts, heartbeatInterval, requestTimeout, wsUrl })`，`connect()` / `disconnect()`；
- 事件：`authenticated`、`disconnected(reason)`、`reconnecting(attempt)`、`error`、`message` 等；
- 回复：`reply(frame, body)`、`replyStream(frame, streamId, content, finish)`，基于收到的帧（`req_id`），收到消息后 24 小时内有效；
- 主动发送：`sendMessage(chatid, body)`，只支持 Markdown、模板卡片和媒体；单聊的 `chatid` 为用户 userid；
- 限制：主动发送要求对方先给机器人发过消息；每个会话每分钟 30 条、每小时 1000 条（回复也计入）；同一机器人同时只能有一条长连接，新连接会挤掉旧连接；没有群搜索与群信息接口。

## 目标

- 业务插件通过 `ctx.wecom` 发送消息、按会话注册 @ 消息处理器，用法与钉钉、飞书一致。
- 业务插件在三个渠道上都能用 `context.reply()` 回复收到的消息。
- `ctx.notify` 可以把企业微信作为默认渠道，或在 `targets` 中与其他渠道一起发送。
- 运维在 admin 设置页、`doctor`、`setup` 中完成企业微信配置。

## 非目标

- 流式回复（边生成边回复）对业务开放；模板卡片；媒体收发与文件下载解密。
- `enter_chat` 欢迎语、模板卡片事件、反馈事件。
- Webhook 回调模式；一个 Profile 接入多个机器人。
- 服务端去重（企业微信没有对应字段）与自动重试。

## 设计

### 1. 公共约定新增回复入口（`src/common/channel.ts`、`src/common/inbox.ts`）

```ts
interface ChannelMessageContext {
  signal: AbortSignal
  /** 回复这条消息；未传 signal 时使用 handler 的 signal。失败写在结果里，不抛错。 */
  reply(options: ChannelSendCommon & { at?: unknown }): Promise<ChannelSendResult>
}
type ChannelMessageHandler<M> = (message: M, context: ChannelMessageContext) => void | Promise<void>
```

- 对已有业务插件只是多了一个字段，读取 `{ signal }` 的代码不受影响。
- `MessageRouterOptions` 新增可选的 `replyFor(message: M): (options) => Promise<ChannelSendResult>`，由渠道提供；路由器把它放进 context。未提供时 `reply` 返回一条失败结果，错误码 `reply_unsupported`（`KitError`，服务名为该渠道）。
- 各渠道的实现：

| 渠道 | 回复方式 |
|---|---|
| 钉钉 | 经 `send()` 发回原会话：群聊 `{ chatId: conversationId }`；单聊（`conversationId` 以 `cidme` 开头）`{ openDingtalkId: senderId }`。此规则取自 iproost 生产代码，实施时对照 dws 事件字段核实 |
| 飞书 | 经 `send()` 发到 `{ chatId: conversationId }`（单聊 `chat_id` 同样可作接收方） |
| 企业微信 | 基于收到的帧回复：生成流 ID，`replyStream(frame, streamId, content, true)` 一次发完；不占主动发送的前提条件 |

- `ChannelAtMessage` 公共字段、`onMessage` / `onPluginMessage` 签名不变。

### 2. 企业微信 Service（`src/wecom/`）

**接入**

- loader 行 `agent-kit-wecom`，Service 名 `wecom`（`ctx.wecom`），导入子路径 `@baoyx/dsh-agent-kit/wecom`；bundle 中默认禁用。
- `ServiceName`、`CHANNEL_NAMES` 加入 `'wecom'`；`NotifyTargets`、`NotifyAts` 加入 `wecom`。
- SDK 只在 `src/wecom/sdk.ts` 中动态加载；未安装时以 `ConfigError` 启动失败。`WecomService.sdkLoader` 为测试替换入口。

**配置**

| 字段 | 说明 |
|---|---|
| `botId` | 必填 |
| `secretRef` | 密钥引用，默认 `WECOM_BOT_SECRET`；先读环境变量，再读 dsh 凭据文件 |
| `defaultTarget` | `{ chatId }`（群）或 `{ userId }`（单聊） |
| `groupRoutes` | `{ conversationId, pluginId }[]`，默认 `[]`；会话 ID 不得重复 |
| `timeoutMs` | 单次请求超时，默认 15000，范围 [1000, 120000] |
| `wsUrl` | 可选；私有部署企业的长连接地址 |
| `dryRun` | 默认 false |

**发送 `send(options)`**

- 目标：`{ chatId }` 发群，`{ userId }` 发单聊。ID 校验：可见 ASCII，长度 1–128，不含空白，不以 `-` 开头；不合法返回 `invalid_target`。
- 内容：一律按 Markdown 发送（`markdown` 原样，`text` 原样作为 Markdown 内容）；有 `title` 时作为加粗首行（`**title**` + 空行）。正文长度上限按官方文档在实施时确定，超出返回 `invalid_target`。
- `at`：`{ userIds?: string[]; all?: boolean }`，渲染写法实施时对照官方文档核实。
- `idempotencyKey`：本进程内去重。同一 key 成功发送后 10 分钟内再次调用直接返回上次结果，不重复发送；进程重启后失效（写入文档）。校验 `/^[A-Za-z0-9._:@-]{1,128}$/`。
- 不自动重试：超时无法判断是否已送达，且没有服务端去重。
- `dryRun`：不调用 SDK，返回成功结果并记日志。
- 长连接未就绪时直接返回 `not_connected` 失败结果，不排队。
- 错误类型 `WecomSendError`（`KitError` 子类）：

| 码 | 含义 | 可重试 |
|---|---|---|
| `invalid_target` | 目标或内容不合法 | 否 |
| `auth_failed` | botId / secret 错误 | 否 |
| `not_interacted` | 会话尚未与机器人互动，不能主动发送；提示先在群里 @ 机器人一次 | 否 |
| `rate_limited` | 超过每会话频率限制 | 是 |
| `not_connected` | 长连接未就绪（如重连中） | 是 |
| `timeout` | 超过 `timeoutMs` | 是 |
| `aborted` | 调用方取消或服务关闭 | 否 |
| `api_error` | 其他错误（含超过 24 小时的回复） | 否 |

企业微信错误码数字到上表的映射在实施时对照官方文档逐条核实并写入测试。

**接收**

- Service 启动时 `connect()`，监听 `message` 事件；即使没有业务路由也保持监听。
- 事件处理函数只解析并调用 `MessageRouter.accept()`，随即返回。
- 消息类型 `WecomAtMessage extends ChannelAtMessage`：

| 字段 | 来源 |
|---|---|
| `eventId`、`messageId` | `msgid` |
| `conversationId` | 群聊为 `chatid`；单聊为 `from.userid` |
| `chatType` | `'group' \| 'single'` |
| `senderId` | `from.userid` |
| `content` | 纯文本，见下 |
| `messageType` | 原始 `msgtype` |
| `quote` | 被引用消息的文字（有则带） |
| `timestamp` | `create_time` 换算为毫秒 |

- `content`：`text` 取 `text.content`，群消息去掉开头 @ 机器人的部分（格式实施时用真实帧核实）；`mixed` 拼接其中文字段；`voice` 取转写文字；其他类型为空字符串。保留换行。
- 机器人创建者不是企业超级管理员时，`from.userid` 为加密 ID；文档提醒业务插件不要假设 ID 格式。
- 结构不合法的帧丢弃并计数。

**说过话的会话**

- 每条消息到达时记录：会话 ID、`chatType`、最后发言人、最后发言时间。最多 500 条，超出按最后发言时间淘汰最旧的。
- 存放 `<profile>/.agent-kit/wecom-conversations/<sha256(botId) 前 24 位>.json`，文件 0600、目录 0700，Windows 收紧 ACL；写入方式与 `UnmatchedStore` 相同。
- 未命中消息另用 `UnmatchedStore` 保存于 `.agent-kit/wecom-unmatched/`；企业微信无法查询群名，只记录会话 ID。
- `searchRecipients(kind, query)`：`group` 只在群会话中、`user` 只在单聊会话中，按会话 ID 与最后发言人做部分匹配；`query` 长度 1–80；不调用企业微信接口，`complete` 为 `true`。结果 `target` 为 `{ chatId }` 或 `{ userId }`。

**长连接生命周期**

| SDK 事件 | 处理 |
|---|---|
| `authenticated` | `router.setReady(true)`，清除失败状态，唤醒等待中的订阅 |
| `disconnected`、`reconnecting` | `router.setReady(false)`；健康状态 `degraded`，详情「重连中」 |
| `error`（认证失败重试用尽） | `router.setReady(false)`；健康状态 `failed`，触发 `agent-kit/service-failed`，拒绝等待中的订阅 |
| 被挤下线（`event.disconnected_event`） | 健康状态 `failed`，详情写明「另一个进程用同一机器人建立了连接」；SDK 1.0.7 此时不会自动重连（已读源码确认），需重载或停掉另一个进程 |
| Service 卸载 | `disconnect()`，`router.reset()`，拒绝等待中的订阅 |

- `maxReconnectAttempts: -1`（无限重连），`maxAuthFailureAttempts: 5`。
- 文档写明一个机器人只接一个 Profile。
- 订阅的 `ready` 在长连接认证成功时完成，在失败或卸载时拒绝（与飞书相同）。
- 首次认证前健康状态为 `degraded`，详情「starting」。

**状态**

- `status()`：`identity: 'bot'`；`online` 为已认证；`account` 为 `botId`。
- 不实现 `login()` / `logout()`。

### 3. admin 支持

- 注册 `agent-kit-wecom`（标题「企业微信」）；`KitId`、保留 id、`AdminChannel`、`channelUnmatched` / `channelSearchRecipients` 支持 `'wecom'`。
- 设置页卡片：表单字段 `botId`、可选 `wsUrl`；Secret 走现有行密钥面板（只写凭据文件，引用名为 `secretRef`）；会话路由面板、未命中消息面板、连接状态。
- 通用收件人选择组件：把 `DingtalkTargetInput`、`FeishuTargetInput` 合并为 `ChannelTargetInput`，按渠道传入支持的类型（群 / 个人）、是否可搜索、手动填写的字段与提示。钉钉、飞书的行为与显示不变。新增字段类型 `wecom-target`：从说过话的会话中选择，或手动填写。
- doctor（`checks/wecom.ts`）：SDK 已安装（修复建议 `dsh plugin --profile <名称> add @wecom/aibot-node-sdk`）、`botId` 已填写、Secret 可读取（只报告来源）。不做在线凭据检查：同一机器人只能有一条长连接，doctor 建连会挤掉运行中的 Agent；检查详情说明这一点，并提示在设置页查看连接状态。
- setup（`configureWecom`）：输入 `botId`、以密码方式输入 Secret 写入凭据文件；可选连接测试，执行前提示「Agent 正在运行时会被短暂挤下线」，确认后才建立一次连接并在认证成功或失败后立即断开。默认通知渠道选择增加「企业微信」。

### 4. 错误处理

- 发送与回复失败均为 `WecomSendError`，带 `code` 与 `retryable`；经 `notify` 时进入对应渠道的结果；`reply()` 与 `send()` 一样不抛错。
- 未安装 SDK、缺少 `botId`、读不到 Secret：以 `ConfigError` 启动失败，消息包含修复方式。
- Secret 读取后调用 `registerSecret`；SDK 日志接入 `KitLogger`，只取安全字段（与飞书相同的处理方式）。
- 业务 handler 错误与超时由 `MessageRouter` 计数并记日志，日志只记正文摘要。

## 测试

- 假 SDK：`src/testing/fake-wecom.ts` 的 `createFakeWecomSdk()` 可推送消息帧，触发 `authenticated` / `disconnected` / `reconnecting` / `error`，记录回复与主动发送，并按调用顺序返回成功或指定错误。`@baoyx/dsh-agent-kit/testing` 导出 `useFakeWecomSdk(fake)`。
- 基础包：
  - 发送：目标校验、Markdown 与标题、@、本进程去重、错误码映射（含 `not_interacted`）、`not_connected`、`dryRun`；
  - 接收：text / mixed / voice / 其他类型解析、单聊会话 ID、开头 @ 去除、会话路由与插件路由、未命中记录、说过话的会话的记录与淘汰、`searchRecipients`；
  - 回复：三个渠道的 `context.reply()`（钉钉、飞书为新增用例），以及缺少 `replyFor` 时的 `reply_unsupported`；
  - 生命周期：就绪前排队、重连 `degraded`、认证失败 `failed`、被挤掉时的详情、卸载时断开、`ready` 的完成与拒绝；
  - `notify`：钉钉、飞书、企业微信同时发送。
- 回归：钉钉、飞书现有测试全部通过。
- admin：通用目标选择组件（三个渠道）、企业微信卡片、doctor 与 setup 的企业微信用例。
- 真实企业微信：如有测试机器人，实施完成后手动走查收发、回复、断网重连与 setup 连接测试；没有则在交付说明中写明「仅用假 SDK 验证」。

## 交付

- 一份实现计划，分两个阶段：阶段一为基础包（回复入口、企业微信 Service、`notify`、测试工具），阶段二为 admin 与文档。完成后开一个 PR，CI 通过后合并。
- 版本仍为 0.3.0（尚未发布）；0.3.0 的 changelog 补充企业微信与回复入口条目。
- 文档：README 功能表、环境要求、企业微信配置与部署说明、渠道约定中的 `reply`；官网新增企业微信页面，更新 notify、兼容性页面与 changelog。
