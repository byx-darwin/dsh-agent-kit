# 渠道公共约定与 notify 多渠道改造设计

- 日期：2026-10-21
- 状态：设计已确认，待实施
- 前置文档：[2026-09-23-dsh-agent-kit-design.md](2026-09-23-dsh-agent-kit-design.md)
- 后续文档：飞书渠道（第 2 份）、企业微信渠道（第 3 份），待编写

## 背景

计划新增飞书和企业微信两个通信渠道，能力与钉钉对齐：既能发送通知，也能接收群内 @ 消息并分发给业务插件。整体拆为三份设计、三轮实现：

1. 渠道公共约定 + `notify` 改造（本文档）：不新增渠道，只调整钉钉与 `notify`。
2. 飞书渠道：进程内使用 `@larksuiteoapi/node-sdk`，机器人身份。
3. 企业微信渠道：进程内使用 `@wecom/aibot-node-sdk`（智能机器人长连接），机器人身份。

已确定的跨文档决策：

| 项 | 决定 |
|---|---|
| 能力 | 新渠道收发都要支持 |
| 身份 | 新渠道使用机器人身份；钉钉保持 user 身份不变 |
| 接入方式 | 新渠道在进程内使用官方 SDK，SDK 作为可选 peer 依赖 |
| `notify` | 调用方在 `targets` 中指定渠道则按指定发送，否则发往配置的默认渠道；删除 `use()` |
| 接收接口 | 各渠道各自提供，但路由签名与消息公共字段一致；不做跨渠道统一入口 |

身份选择的依据：飞书 `im.message.receive_v1` 只推送给开启机器人能力的应用，不支持以 user 身份订阅；企业微信只有智能机器人能接收群内 @ 消息。两者都没有 user 身份接收群消息的官方途径。

## 目标

- 定义所有渠道共同遵守的发送、状态、接收约定，后续渠道只需实现「连接 → 消息」这一层。
- 从钉钉收件逻辑中抽出与渠道无关的消息路由器，供后续渠道复用。
- `notify` 支持按调用指定一个或多个渠道，未指定时发往默认渠道。

## 非目标

- 不接入飞书、企业微信；`CHANNEL_NAMES` 仍只有 `dingtalk`。
- 不做跨渠道统一收件入口。
- 不修改钉钉已有的字段与方法，只新增 `senderId`。
- 不修改设置页界面。
- 不提供「全部渠道群发」「故障转移」等发送策略。

## 设计

### 1. 渠道公共约定（`src/common/channel.ts`）

**渠道名称**

- `ChannelName = 'dingtalk' | 'feishu' | 'wecom'`，类型先预留。
- `CHANNEL_NAMES` 只列出已实现的渠道，本轮为 `['dingtalk']`；后续渠道实现时再加入，避免配置中出现不可用的渠道。

**发送接口 `ChannelService`**

每个渠道服务实现：

- `send(options)`：公共参数为 `title`、`markdown` 或 `text`、`idempotencyKey`、`traceId`、`signal`，另加渠道自己的 `target` 与 `at`。返回 `{ results: Array<{ ok: boolean; messageId?: string; error?: KitError }> }`，逐目标给出结果。
- `status(): Promise<ChannelStatus>`：是否在线、发送身份、账号。
- `health()`：同其他 Service。
- `login?()` / `logout?()`：可选。钉钉 user 身份实现；机器人渠道无需登录，不实现。

**接收消息公共字段 `ChannelAtMessage`**

| 字段 | 说明 |
|---|---|
| `eventId` | 去重键 |
| `messageId?` | 渠道消息 ID |
| `conversationId` | 会话 ID；飞书 `chat_id`、企业微信 `chatid` 映射到此字段 |
| `senderId?` | 发送者 ID |
| `content` | 正文，属外部输入，业务插件必须自行校验 |
| `timestamp?` | 毫秒时间戳 |

- `DingtalkAtMessage` 改为继承 `ChannelAtMessage`，只新增 `senderId`（值与 `senderOpenDingtalkId` 相同），其余字段不变。
- 公共字段沿用钉钉现有命名 `conversationId`，钉钉无需改名。

**接收方法**

各渠道统一提供：

- `onMessage(route, handler)`：`route` 为 `{ conversationId, match?, priority? }`。
- `onPluginMessage(pluginId, handler)`：配合配置中的「会话 → 插件」路由。
- `unmatchedMessages()`：未命中任何路由的消息记录。

类型以泛型形式定义在公共模块（`ChannelMessageRoute<M>`、`ChannelMessageHandler<M>`、`ChannelMessageSubscription`），钉钉现有类型名改为这些泛型的别名，导出名不变。

**公共消息路由器（`src/common/inbox.ts`）**

把 `src/dingtalk/inbox.ts` 中与渠道无关的逻辑抽成 `MessageRouter`：

- 路由匹配：按 `conversationId`、`match`、`priority`，同优先级按注册顺序；
- 插件路由与未命中记录；
- 按 `eventId` 去重（最近 2048 条）；
- 有界队列（256 条）与队满丢弃；
- handler 超时（30 秒）与错误计数；
- 统计信息（received、dispatched、unmatched、duplicate、dropped、handlerErrors）。

钉钉只保留「`dws event +listen-im` 子进程 → 解析 NDJSON → 交给 `MessageRouter`」这一层，包括启动、ready 判定、退出与重启。此步为纯重构，钉钉行为不变。

### 2. `notify` 改造

**配置**

- 字段名保持 `channel`，含义改为默认渠道；现有 `cordis.patch.yml` 无需修改。
- 取值从 `z.const('dingtalk')` 改为 `CHANNEL_NAMES` 中的任一值，默认 `dingtalk`。
- 各渠道的默认目标仍由各渠道配置提供（如钉钉 `defaultTarget`），`notify` 不重复保存。

**发送 `send(options)`**

- `targets` 中出现了哪些渠道，就只发这些渠道，各自使用自己的 `targets[channel]` 与 `at[channel]`，并行发送。
- `targets` 缺省或为空对象时，发往默认渠道，目标为该渠道的 `defaultTarget`。
- 指定的渠道未运行时，该渠道记为一条失败结果（`channel_unavailable`），其他渠道照常发送，整个调用不抛错。
- 仅发默认渠道且默认渠道未运行时，抛出 `channel_unavailable`，与现在一致。
- 返回值由 `{ channel, results }` 改为 `{ deliveries: Array<{ channel, results }> }`，顺序与发送的渠道顺序一致。
- `idempotencyKey` 原样传给每个渠道，由各渠道自行去重。

**删除与调整**

- 删除 `use()` 及运行时覆盖，`status()` 返回值不再有 `source`。
- `status()` 返回 `{ defaultChannel, channels }`，每个渠道给出是否运行及登录状态。
- `login(channel)` / `logout(channel)` 必须指定渠道；渠道未实现登录时抛出 `login_unsupported`。
- 继续不 inject 渠道服务，发送时用 `ctx.get()` 获取，启停渠道不会连带卸载 `notify` 及依赖它的业务插件。
- 配置变更仍在 `internal/update` 钩子中原地生效，不重载本服务。

**健康状态**

- 按默认渠道判断：默认渠道未运行或已失败为 `failed`；最近一次投递失败为 `degraded`；否则为 `ok`。
- 成功、失败计数按每个渠道的每次投递累计。

### 3. admin 包配套

- `doctor`：`checks/notify.ts` 改为检查默认渠道对应的行是否启用；运行时 `targets` 中指定的其他渠道不在检查范围内。
- `setup`：`configureNotify` 改为选择默认渠道，选项来自 `NOTIFY_CHANNELS`；只有一个选项时自动选中，不提问。保留「默认渠道的行未启用」提示；文案从「通知固定发往钉钉」改为「默认渠道」。
- 设置页：本轮不改。通知卡片继续隐藏，「会话 → 插件」路由与未命中消息面板仍只有钉钉，到第 2、3 份设计再按渠道扩展。

### 4. 错误处理

- 错误仍为 `KitError`，带 `code` 与 `retryable`。
- `NotifyErrorCode` 新增 `login_unsupported`（不可重试）与 `send_failed`（可重试，渠道 `send()` 抛出非 `KitError` 异常时包装使用），保留 `channel_unavailable`、`invalid_channel`。
- 直接抛错的情况只有两种：未指定渠道且默认渠道未运行；`targets` 中出现未知渠道名（`invalid_channel`）。
- 渠道 `send()` 抛出异常（而不是返回失败结果）时，`notify` 将其转为该渠道的失败结果，不影响其他渠道。
- `MessageRouter` 中 handler 抛错或超时：记日志、计数，不影响其他消息；日志只记正文摘要。

### 5. 版本与迁移

- 根包与 admin 包升到 **0.3.0**，同时避开本地未发布的 0.2.1。
- README 增加 0.3.0 迁移说明：
  - `notify.send()` 返回值改为 `{ deliveries }`；
  - 删除 `notify.use()`；
  - `notify.status()` 返回 `{ defaultChannel, channels }`，不再有 `channel`、`source`；
  - `notify.login()` / `logout()` 必须传入渠道；
  - 渠道发送失败（如钉钉 `DingtalkSendError`）不再从 `notify.send()` 抛出，改为出现在对应 `deliveries[i].results[j].error` 中；
- 已知使用方 iproost 不读取 `send()` 返回值、不调用 `use()`，读取的钉钉消息字段全部保留，预计无需修改代码。
- 是否在飞书接入后再一起发布，实施完成后再定。

## 测试

- `MessageRouter` 单元测试：优先级、`match`、去重、队满丢弃、handler 超时、插件路由、未命中记录。主要从现有钉钉收件测试迁移。
- 钉钉现有收件测试不修改，必须全部通过，作为重构行为不变的依据。
- `notify` 单元测试：
  - 不指定渠道，发往默认渠道；
  - 指定一个或多个渠道并行发送；
  - 指定渠道未运行，仅该渠道失败；
  - 默认渠道未运行，抛错；
  - 未知渠道名，抛 `invalid_channel`；
  - 渠道 `send()` 抛异常，转为该渠道失败结果；
  - `status()` 结构；
  - 不支持登录的渠道调用 `login()`，抛 `login_unsupported`。

  多渠道用例使用测试内注册的假渠道服务。
- admin：`doctor`、`setup` 用例按新文案和默认渠道逻辑更新。

## 文档

- README：
  - 「功能」表中 `ctx.notify` 改为「默认渠道，可按调用指定渠道」；
  - 新增「渠道约定」一节，说明 `ChannelService`、`ChannelAtMessage` 与三个接收方法；
  - 新增 0.3.0 迁移说明。
- 官网：changelog 增加 0.3.0；`website/` 下 notify 相关文档同步。
