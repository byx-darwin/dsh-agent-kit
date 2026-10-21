# 飞书渠道设计

- 日期：2026-10-21
- 状态：设计已确认，待实施
- 前置文档：[2026-10-21-channel-contract-notify-design.md](2026-10-21-channel-contract-notify-design.md)（渠道公共约定与 notify 改造，已合并）
- 后续文档：企业微信渠道（第 3 份），待编写

## 背景

第 1 份设计定义了渠道公共约定（`ChannelService`、`ChannelAtMessage`、`MessageRouter`），并让 `notify` 支持按调用指定渠道。本设计在此基础上接入飞书，能力与钉钉对齐：发送通知，并接收群内 @ 机器人与私聊机器人的消息，分发给业务插件。

已确定的决策：

| 项 | 决定 |
|---|---|
| 身份 | 机器人（自建应用）。飞书 `im.message.receive_v1` 只推送给开启机器人能力的应用，没有 user 身份接收群消息的官方途径 |
| 接入方式 | 进程内使用 `@larksuiteoapi/node-sdk`（可选 peer 依赖，`^1.76.0`）：`Client` 发送，`WSClient` 长连接接收 |
| 接收范围 | 群内 @ 机器人 + 私聊机器人；不申请「群内所有消息」敏感权限 |
| 默认目标标记 | `notify` 的 `targets[channel]` 可为 `'default'`，表示发往该渠道但使用其配置的默认目标 |
| admin | 与钉钉完整对齐；把钉钉专用的路由、未命中面板改为通用组件 |
| 复用方式 | 抽出通用部件（`ChannelInbox`、`UnmatchedStore`），飞书与以后的企业微信共用 |

SDK 能力（1.76.0 已核实）：`WSClient` 提供 `onReady`、`onError`、`onReconnecting`、`onReconnected` 回调，以及 `getConnectionStatus()`、`close()`；`domain` 可切换飞书与 Lark。长连接约束：事件处理函数须在 3 秒内返回，否则飞书重推；同一应用有多个长连接时，每条消息只随机推给其中一个。

## 目标

- 业务插件通过 `ctx.feishu` 发送消息、按会话注册 @ 消息处理器，与钉钉的用法一致。
- `ctx.notify` 可以把飞书作为默认渠道，或在 `targets` 中与钉钉一起发送。
- 运维在 admin 设置页、`doctor`、`setup` 中完成飞书配置，与钉钉体验一致。
- 抽出的通用部件使企业微信只需实现「连接 → 消息」与发送两层。

## 非目标

- 卡片按钮等交互回调；发送图片、文件；撤回、编辑消息；话题内回复。
- 用户身份；Webhook 回调方式；商店应用（ISV）与多租户。
- 一个 Profile 接入多个飞书应用。
- 企业微信。

## 设计

### 1. 补全公共约定（`src/common/`）

**接收侧接口 `ChannelInbox<M>`（`channel.ts`）**

```ts
interface ChannelInbox<M extends ChannelAtMessage> {
  onMessage(route: ChannelMessageRoute<M>, handler: ChannelMessageHandler<M>): ChannelMessageSubscription
  onPluginMessage(pluginId: string, handler: ChannelMessageHandler<M>): ChannelMessageSubscription
  unmatchedMessages(): Promise<ChannelUnmatchedMessage[]>
  searchRecipients(kind: 'group' | 'user', query: string): Promise<ChannelRecipientSearchResult>
}
```

钉钉声明 `implements ChannelInbox<DingtalkAtMessage>`；飞书同样实现。

**通用未命中消息存储（新建 `src/common/unmatched.ts`）**

- 把 `DingtalkUnmatchedStore` 改为通用的 `UnmatchedStore`。行为不变：最多 200 条、预览前 240 字、文件权限 0600、Windows 收紧 ACL、按账号分文件、异步补会话名（名称缓存 10 分钟，失败 1 分钟后重试）。
- 公共记录类型 `ChannelUnmatchedMessage`：`eventId`、`messageId?`、`conversationId`、`conversationName?`、`senderId?`、`preview`、`receivedAt`、`timestamp?`。
- 兼容：`DingtalkUnmatchedMessage` 在公共字段之外保留 `groupName` 与 `senderOpenDingtalkId`（值分别与 `conversationName`、`senderId` 相同）；磁盘上已有的钉钉记录（只有旧字段）读取时补出新字段。
- 每个渠道一个目录 `.agent-kit/<channel>-unmatched/`；钉钉沿用现有的 `dingtalk-unmatched/`，无需迁移。
- 账号键：钉钉为 dws profile 的 SHA-256 前 24 位（不变）；飞书为 `appId` 的 SHA-256 前 24 位。

**路由配置**

三个渠道都使用 `groupRoutes: Array<{ conversationId, pluginId }>`，不改名；注释写明也适用于单聊会话。

**收件人搜索公共类型**

`ChannelRecipientSearchResult = { candidates: Array<{ name: string; target: unknown }>; complete: boolean }`，各渠道收窄 `target` 类型；`DingtalkRecipientSearchResult` 改为其别名（`target` 为 `DingtalkRecipientTarget`）。

**`'default'` 目标标记（`src/notify/`）**

- `NotifyTargets` 每个渠道的值为 `<渠道目标> | 'default'`。
- 值为 `'default'` 时该渠道参与发送，传给渠道的 `target` 为 `undefined`，由渠道使用 `defaultTarget`。
- 判断「指定了哪些渠道」时，`'default'` 与具体目标同等计入；`undefined` 不计入（与现在一致）。

### 2. 飞书 Service（`src/feishu/`）

**接入**

- loader 行 `agent-kit-feishu`，Service 名 `feishu`（`ctx.feishu`），导入子路径 `@baoyx/dsh-agent-kit/feishu`；bundle 中默认禁用。
- `ServiceName` 加入 `'feishu'`；`CHANNEL_NAMES` 加入 `'feishu'`；`NotifyTargets`、`NotifyAts` 加入 `feishu`。
- SDK 只在 Service 启动时动态加载（集中在 `src/feishu/sdk.ts`）；未安装时以 `ConfigError` 启动失败，提示安装命令。

**配置**

| 字段 | 说明 |
|---|---|
| `appId` | 必填 |
| `appSecretRef` | 密钥引用，默认 `FEISHU_APP_SECRET`；先读环境变量，再读 dsh 凭据文件 |
| `domain` | `feishu`（默认）或 `lark` |
| `defaultTarget` | `{ chatId }` 或 `{ openId }` |
| `groupRoutes` | `{ conversationId, pluginId }[]`，默认 `[]`；会话 ID 不得重复 |
| `timeoutMs` | 单次发送超时，默认 15000，范围 [1000, 120000] |
| `retry.maxAttempts` | 默认 2，范围 [0, 5]；只在传入 `idempotencyKey` 时重试 |
| `dryRun` | 默认 false |

**发送 `send(options)`**

- 目标：`{ chatId }` → `receive_id_type: 'chat_id'`；`{ openId }` → `'open_id'`。ID 先做格式校验（字母、数字、`_`、`-`，长度上限 128，不得以 `-` 开头），不合法返回 `invalid_target`。
- `at`：`{ openIds?: string[]; all?: boolean }`。
- 纯文本：`msg_type: 'text'`；@ 追加在正文末尾，写法 `<at user_id="ou_xxx"></at>`，@ 所有人为 `user_id="all"`。
- Markdown：`msg_type: 'interactive'`，卡片 body 为一个 markdown 元素，有 `title` 时作为卡片标题；@ 写法为 `<at id=ou_xxx></at>`、`<at id=all></at>`。
- `idempotencyKey` 映射为请求的 `uuid` 字段（飞书 1 小时内去重）；校验字符集 `[A-Za-z0-9._:@-]`，长度上限 50。
- 成功结果 `messageId` 为返回的 `message_id`。
- `dryRun`：不调用 API，返回成功结果并记日志。
- 错误类型 `FeishuSendError`（`KitError` 子类），错误码：

| 码 | 含义 | 可重试 |
|---|---|---|
| `invalid_target` | 目标格式不合法或飞书判定接收方无效 | 否 |
| `auth_failed` | 凭据错误或 tenant token 失效 | 否 |
| `permission_denied` | 缺少权限，或机器人不在群里 | 否 |
| `rate_limited` | 触发频率限制 | 是 |
| `timeout` | 超过 `timeoutMs` | 是 |
| `network` | 网络错误 | 是 |
| `api_error` | 其他飞书错误；HTTP 5xx 时可重试 | 视情况 |

飞书具体错误码数字到上表的映射在实现时对照官方文档逐条核实，并写入测试。

**接收**

- Service 启动时创建 `WSClient` 并订阅 `im.message.receive_v1`；即使没有业务路由也保持监听，用于记录未命中消息。
- 事件处理函数只解析并调用 `MessageRouter.accept()`，随即返回（满足 3 秒限制）。
- 消息类型 `FeishuAtMessage extends ChannelAtMessage`：

| 字段 | 来源 |
|---|---|
| `eventId`、`messageId` | `message.message_id` |
| `conversationId` | `message.chat_id` |
| `chatType` | `'p2p' \| 'group'` |
| `senderId` | `sender.sender_id.open_id` |
| `content` | 纯文本，见下 |
| `messageType` | 飞书原始消息类型 |
| `mentions` | `Array<{ openId: string; name: string }>` |
| `timestamp` | `create_time` 转为毫秒数字 |

- `content`：`text` 消息中 `@_user_N` 占位符替换为 `@姓名`，开头 @ 本机器人的那一个去掉；`post` 只拼接文字段落；其他类型为空字符串。
- 结构不合法的事件丢弃并计数（`MessageRouter.drop()`）。

**连接生命周期**

| SDK 回调 | 处理 |
|---|---|
| `onReady`、`onReconnected` | `router.setReady(true)`；清除失败状态 |
| `onReconnecting` | `router.setReady(false)`；健康状态 `degraded`，详情「重连中」 |
| `onError` | `router.setReady(false)`；健康状态 `failed`，触发 `agent-kit/service-failed` |
| Service 卸载 | `wsClient.close()`，`router.reset()` |

SDK 日志接入 `KitLogger`，经脱敏，默认级别 warn。

**状态与搜索**

- `status()`：`identity: 'bot'`；`online` 为长连接已就绪；`account` 为机器人名称（启动时查询机器人信息接口一次）。
- 不实现 `login()` / `logout()`。
- `searchRecipients('group', query)`：调用「搜索群」接口（机器人身份，只返回机器人所在的群），结果 `target` 为 `{ chatId }`；`query` 长度 2–80。
- `searchRecipients('user', …)`：不支持，抛出 `TypeError('feishu bot cannot search users; enter an open_id')`。
- 未命中记录的会话名通过「获取群信息」接口异步补全。

**健康状态**

- `failed`：长连接 `onError`，或启动时凭据校验失败。
- `degraded`：重连中，或最近一次发送失败晚于最近一次成功。
- `ok`：其余情况；详情包含机器人名称与路由数。
- 计数器：发送成功、失败、最近错误码，以及 `MessageRouter` 的收件计数。

**部署说明（写入文档）**

- 同一飞书应用的多个长连接只会有一个收到某条消息，因此一个飞书应用只接一个 Profile。
- 飞书开发者后台需要：开启机器人能力；事件订阅方式选长连接并订阅「接收消息 v2.0」；开通权限 `im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:message.p2p_msg:readonly`。

### 3. admin 支持

**注册**

- `KIT_ENTRIES` 加入 `agent-kit-feishu`（标题「飞书」）；`KitId` 与保留 id 同步。

**设置页**

- 飞书卡片表单：`appId`、`domain`（「飞书 / Lark」）。`defaultTarget`、`dryRun` 不在卡片上显示（与钉钉一致）。
- App Secret 走现有的行密钥面板（与 Laya Key 相同），只写入 dsh 凭据文件，引用名为配置的 `appSecretRef`。
- 连接状态取自 `health()`。

**通用面板**

- `DingtalkRoutesPanel` → `ChannelRoutesPanel`，`DingtalkUnmatchedPanel` → `ChannelUnmatchedPanel`，通过 `channel` 参数区分；钉钉显示效果不变。
- 文案 key `dingtalk.routes.*` → `routes.*`（中英文同步），未命中面板同理。
- 后端新增 `channelUnmatched(channel)`、`channelSearchRecipients(channel, kind, query)`；前端改用新接口。`dingtalkUnmatched`、`dingtalkSearchRecipients` 保留一个版本，内部转调新接口。
- 业务字段新增类型 `feishu-target`：按群名搜索机器人所在的群（存 `{ chatId }`），或手动填写 open_id（存 `{ openId }`）。

**doctor（`checks/feishu.ts`）**

| 检查 | 失败时的修复建议 |
|---|---|
| SDK 已安装 | `dsh plugin --profile <名称> add @larksuiteoapi/node-sdk` |
| `appId` 已填写 | 在设置页或 setup 中填写 |
| App Secret 可读取（只报告来源） | 设置页保存，或设置环境变量 |
| 凭据有效：带超时获取 `tenant_access_token`，再查询机器人信息（确认机器人能力并取得名称） | 核对 App ID / Secret，开启机器人能力 |

权限与事件订阅无法从外部验证，检查详情中列出需要开通的三项权限。`notify` 默认渠道检查天然支持飞书。

**setup（`configureFeishu`）**

- 依次输入 App ID、选择域名、以密码方式输入 App Secret 并写入凭据文件；随后执行与 doctor 相同的凭据检查；可选向一个群 ID 发送测试消息。
- 未安装 SDK 时只显示安装命令，不自动安装。
- 默认通知渠道选择出现「钉钉 / 飞书」两项。

### 4. 错误处理

- 发送失败为 `FeishuSendError`，带 `code` 与 `retryable`；经 `notify` 时进入 `deliveries[i].results[j].error`。
- 未安装 SDK、缺少 `appId`、读不到 App Secret：以 `ConfigError` 启动失败，消息包含修复方式。
- App Secret 读取后调用 `registerSecret`，日志自动脱敏。
- 业务 handler 错误与超时由 `MessageRouter` 计数并记日志，日志只记正文摘要。

## 测试

- **假 SDK**：`src/testing/fake-feishu.ts` 的 `createFakeFeishuSdk()` 提供假的 `Client`（记录 `message.create` 参数，按调用顺序返回成功或指定错误；模拟搜索群、获取群信息、机器人信息）与假的 `WSClient`（可推送 `im.message.receive_v1`，可触发四个生命周期回调，记录 `close()`）。`@baoyx/dsh-agent-kit/testing` 导出 `useFakeFeishuSdk(fake)` 替换 `src/feishu/sdk.ts` 的加载函数。
- **基础包**：
  - 发送：文本、Markdown 卡片、@ 人与 @ 所有人、`uuid`、错误码映射、仅在有 `idempotencyKey` 时重试、`dryRun`、目标校验；
  - 接收：text / post / 其他类型解析、@ 占位符替换、结构不合法的事件丢弃、处理函数立即返回、会话路由与插件路由、未命中记录与会话名补全；
  - 生命周期：就绪前排队、就绪后投递，重连 `degraded`，失败 `failed` 并触发 `service-failed`，卸载时 `close()`；
  - `notify`：钉钉与飞书同时发送、`'default'` 标记、飞书 `login_unsupported`。
- **钉钉回归**：`UnmatchedStore` 通用化后，钉钉现有测试全部通过，且旧格式记录文件可读。
- **admin**：doctor、setup 的飞书用例；通用面板组件测试；新接口与保留的旧接口。
- **真实飞书**：如有测试应用，实施完成后手动走查收发、断网重连与 doctor；没有则在交付说明中写明「仅用假 SDK 验证」。

## 交付

- 一份实现计划，分两个阶段：阶段一为基础包（公共部件、飞书 Service、`notify`、测试工具），阶段二为 admin。两个阶段完成后开一个 PR。
- 版本仍为 0.3.0（尚未发布）；0.3.0 的 changelog 补充飞书条目。
- 文档：README 功能表与环境要求加入飞书，新增飞书配置与部署说明；`notify` 小节补充钉钉默认目标 + 飞书指定群的示例；官网新增飞书页面并更新 notify 页面与 changelog。第 1 份设计遗留的「notify 只经钉钉发送」类描述一并修正。
