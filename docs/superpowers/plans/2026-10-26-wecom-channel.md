# 企业微信渠道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `ctx.wecom`（企业微信智能机器人，长连接，收发都支持），为三个渠道的消息处理函数加上 `context.reply()`，并在 admin 设置页、doctor、setup 中支持企业微信。

**Architecture:** 阶段一（Task 1–4，基础包）：先在公共约定里加入回复入口（`ChannelMessageContext`、`MessageRouterOptions.replyFor`），钉钉、飞书接入；再按飞书的结构实现 `src/wecom/`：SDK 只经 `src/wecom/sdk.ts` 的窄接口 `WecomSdk` 使用（真实实现包装 `@wecom/aibot-node-sdk`，测试用 `src/testing/fake-wecom.ts`），接收用 `MessageRouter`，未命中消息用 `UnmatchedStore`，另加「说过话的会话」记录 `ConversationStore`。阶段二（Task 5–8）：admin 注册与后端接口、通用收件人选择组件与企业微信卡片、doctor 与 setup、文档。

**Tech Stack:** TypeScript（NodeNext、strict）、cordis 4、schemastery、vitest、React 18（admin 前端）、`@wecom/aibot-node-sdk` ^1.0.7。

**Spec:** `docs/superpowers/specs/2026-10-26-wecom-channel-design.md`

## Global Constraints

- `@wecom/aibot-node-sdk` 为可选 peer 依赖，版本 `^1.0.7`；只在 Service 启动时动态加载；未安装时以 `ConfigError` 启动失败。
- loader 行 `agent-kit-wecom`，Service 名 `wecom`，子路径 `@baoyx/dsh-agent-kit/wecom`，bundle 中默认禁用。
- 企业微信配置字段：`botId`（必填）、`secretRef`（默认 `WECOM_BOT_SECRET`）、`defaultTarget`（`{ chatId }` 或 `{ userId }`）、`groupRoutes`（默认 `[]`）、`timeoutMs`（默认 15000，范围 [1000, 120000]）、`wsUrl`（可选）、`dryRun`（默认 false）。
- 目标 ID 校验：可见 ASCII（`/^[\x21-\x7e]{1,128}$/`），不以 `-` 开头；`idempotencyKey` 校验 `/^[A-Za-z0-9._:@-]{1,128}$/`。
- 内容一律按 Markdown 发送，`markdown.content` 上限 20480 字节（UTF-8），超出为 `invalid_target`。
- `idempotencyKey` 只在本进程内去重：成功后 10 分钟内同一 key 直接返回上次结果；不自动重试。
- 长连接未就绪时 `send()` 直接返回 `not_connected` 失败结果，不排队。
- `WecomErrorCode`：`invalid_target`、`auth_failed`、`not_interacted`、`rate_limited`、`not_connected`、`timeout`、`aborted`、`api_error`、`reply_unsupported`（仅公共兜底使用）。可重试：`rate_limited`、`not_connected`、`timeout`。
- 处理函数第二个参数为 `{ signal, reply }`；`reply()` 与 `send()` 一样不抛错，失败写在结果里；未提供 `replyFor` 的渠道返回 `reply_unsupported` 失败结果。
- 钉钉回复：群 `{ chatId: conversationId }`；`conversationId` 以 `cidme` 开头为单聊，回复 `{ openDingtalkId: senderId }`。飞书回复：`{ chatId: conversationId }`。企业微信回复：基于收到的帧，`replyStream(frame, streamId, content, true)`。
- 说过话的会话：最多 500 条，按最后发言时间淘汰；文件 `<profile>/.agent-kit/wecom-conversations/<sha256(botId) 前 24 位>.json`，0600 / 目录 0700；未命中记录在 `.agent-kit/wecom-unmatched/`。
- `searchRecipients`：`query` 长度 1–80，只查本地会话记录，`complete: true`。
- SDK 选项：`maxReconnectAttempts: -1`，`maxAuthFailureAttempts: 5`。被另一连接挤下线后 SDK 不会自动重连（已读 SDK 1.0.7 源码确认），按 `failed` 处理并写明原因（这一点修订 spec 中「重连中」的表述，见 Task 3）。
- doctor 不做在线凭据检查（会挤掉运行中的 Agent）；setup 的连接测试须先确认。
- 钉钉、飞书现有测试必须全部通过（新增用例可以，修改已有断言须说明理由）。
- 注释、用户可见文案与文档用中文（英文词典同步）。
- 每个任务结束时运行：根目录 `npm run typecheck && npx vitest run`；涉及 admin 时再运行 `cd admin && npm run typecheck && npx vitest run`；涉及官网时再运行 `cd website && npm run build && npx vitest run`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/common/channel.ts` | 修改 | `ChannelMessageContext`、`ChannelReplyOptions`；`ChannelMessageHandler` 第二参数改为它 |
| `src/common/inbox.ts` | 修改 | `MessageRouterOptions.replyFor`；向 handler 传 `reply`；`replyUnsupported()` |
| `src/common/reply.ts` | 新建 | `safeReply()`：把渠道 `send()` 的抛错转为失败结果 |
| `src/dingtalk/inbox.ts`、`src/dingtalk/service.ts` | 修改 | 钉钉 `replyFor` |
| `src/feishu/service.ts` | 修改 | 飞书 `replyFor` |
| `src/wecom/sdk.ts` | 新建 | 窄接口 `WecomSdk` 与真实 SDK 适配 |
| `src/wecom/config.ts` | 新建 | `WecomConfig` |
| `src/wecom/errors.ts` | 新建 | `WecomSendError`、错误码分类 |
| `src/wecom/message.ts` | 新建 | 目标校验、Markdown 内容构造 |
| `src/wecom/event.ts` | 新建 | 消息帧解析为 `WecomAtMessage` |
| `src/wecom/conversations.ts` | 新建 | `ConversationStore`：说过话的会话 |
| `src/wecom/service.ts` | 新建 | `WecomService` |
| `src/wecom/index.ts` | 新建 | 子路径导出 |
| `src/testing/fake-wecom.ts` | 新建 | 假 SDK 与 `useFakeWecomSdk` |
| `src/common/errors.ts`、`src/index.ts`、`src/testing/index.ts`、`src/notify/service.ts`、`package.json`、`patch.yml` | 修改 | 接入 |
| `admin/...` | 修改 / 新建 | 见 Task 5–7 |
| `README.md`、`website/...`、spec | 修改 | 文档 |

---

## 阶段一：基础包

### Task 1: 回复入口 `context.reply()`（公共约定 + 钉钉 + 飞书）

**Files:**
- Modify: `src/common/channel.ts:59`（`ChannelMessageHandler`）
- Modify: `src/common/inbox.ts`（`MessageRouterOptions`、handler 调用处 ~:164）
- Create: `src/common/reply.ts`
- Modify: `src/dingtalk/inbox.ts:63-77`（构造参数与 `new MessageRouter`）、`src/dingtalk/service.ts:132-144`（`new DingtalkInbox`）
- Modify: `src/feishu/service.ts`（`new MessageRouter` 处）
- Modify: `src/index.ts`
- Test: `tests/unit/message-router.test.ts`、`tests/unit/channel-reply.test.ts`（新建）

**Interfaces:**
- Produces:
  ```ts
  // src/common/channel.ts
  export interface ChannelReplyOptions extends ChannelSendCommon { at?: unknown }
  export interface ChannelMessageContext {
    signal: AbortSignal
    reply(options: ChannelReplyOptions): Promise<ChannelSendResult>
  }
  export type ChannelMessageHandler<M extends ChannelAtMessage = ChannelAtMessage> = (message: M, context: ChannelMessageContext) => void | Promise<void>
  // src/common/inbox.ts
  export type ReplyFactory<M extends ChannelAtMessage> = (message: M) => (options: ChannelReplyOptions) => Promise<ChannelSendResult>
  // MessageRouterOptions<M> 新增 replyFor?: ReplyFactory<M>
  // src/common/reply.ts
  export function safeReply(service: ServiceName, send: () => Promise<ChannelSendResult>): Promise<ChannelSendResult>
  export function replyUnsupported(service: ServiceName): Promise<ChannelSendResult>
  ```

- [ ] **Step 1: Write the failing router test**

Add to `tests/unit/message-router.test.ts` (inside `describe('MessageRouter', …)`):

```ts
  it('passes a reply function built by replyFor, defaulting the signal to the handler signal', async () => {
    const calls: Array<{ text?: string; signal?: AbortSignal; eventId: string }> = []
    const r = new MessageRouter<ChannelAtMessage>({
      channel: 'test', logger, onUnmatched: async () => {},
      replyFor: (m) => async (o) => { calls.push({ text: o.text, signal: o.signal, eventId: m.eventId }); return { results: [{ ok: true, messageId: 'r1' }] } },
    })
    let handlerSignal: AbortSignal | undefined
    let replied: unknown
    r.register({ conversationId: 'c1' }, async (_m, { signal, reply }) => { handlerSignal = signal; replied = await reply({ text: 'pong' }) })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    await until(() => replied !== undefined)
    expect(replied).toEqual({ results: [{ ok: true, messageId: 'r1' }] })
    expect(calls).toEqual([{ text: 'pong', signal: handlerSignal, eventId: 'e1' }])
  })

  it('returns a reply_unsupported failure when the channel provides no replyFor', async () => {
    const { r } = router()
    let replied: any
    r.register({ conversationId: 'c1' }, async (_m, { reply }) => { replied = await reply({ text: 'x' }) })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    await until(() => replied !== undefined)
    expect(replied.results[0]).toMatchObject({ ok: false, error: { code: 'reply_unsupported', retryable: false } })
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/message-router.test.ts`
Expected: FAIL — `reply is not a function`.

- [ ] **Step 3: Contract types and helpers**

In `src/common/channel.ts`, replace the `ChannelMessageHandler` declaration (line ~59) with:

```ts
/** `reply()` 的参数：与 `send()` 的公共参数相同，`at` 为该渠道自己的 @ 结构。 */
export interface ChannelReplyOptions extends ChannelSendCommon {
  at?: unknown
}

export interface ChannelMessageContext {
  /** 路由器的中止信号：超时、注销或服务停止时触发。 */
  signal: AbortSignal
  /** 回复这条消息；未传 `signal` 时使用上面的 signal。失败写在结果里，不抛错。 */
  reply(options: ChannelReplyOptions): Promise<ChannelSendResult>
}

export type ChannelMessageHandler<M extends ChannelAtMessage = ChannelAtMessage> = (message: M, context: ChannelMessageContext) => void | Promise<void>
```

Create `src/common/reply.ts`:

```ts
import type { ChannelSendResult } from './channel.js'
import { KitError, isKitError, type ServiceName } from './errors.js'
import { redact } from './redact.js'

/** 把渠道 `send()` 的异常转为失败结果，使 `reply()` 与 `notify` 一样不抛错。 */
export async function safeReply(service: ServiceName, send: () => Promise<ChannelSendResult>): Promise<ChannelSendResult> {
  try {
    return await send()
  } catch (e) {
    const error = isKitError(e) ? e : new KitError(service, 'send_failed', `${service} reply failed: ${redact(String((e as Error)?.message ?? e))}`, { retryable: true, cause: e })
    return { results: [{ ok: false, error }] }
  }
}

/** 渠道没有提供回复能力时的兜底结果。 */
export function replyUnsupported(service: ServiceName): Promise<ChannelSendResult> {
  return Promise.resolve({ results: [{ ok: false, error: new KitError(service, 'reply_unsupported', `${service} does not support replying to messages`, { retryable: false }) }] })
}
```

Confirm `ServiceName` and `isKitError` are exported from `src/common/errors.ts` (`grep -n "export type ServiceName\|export function isKitError" src/common/errors.ts`). `ServiceName` must accept the router's `channel` string: in `MessageRouterOptions`, keep `channel: string` and cast when calling `replyUnsupported(this.options.channel as ServiceName)`.

- [ ] **Step 4: Pass reply through the router**

In `src/common/inbox.ts`:

1. Import `type ChannelReplyOptions, type ChannelSendResult` from `'./channel.js'`, `replyUnsupported` from `'./reply.js'`, and `type ServiceName` from `'./errors.js'`.
2. Add, above `MessageRouterOptions`:

```ts
/** 由渠道提供：为一条收到的消息生成回复函数。 */
export type ReplyFactory<M extends ChannelAtMessage> = (message: M) => (options: ChannelReplyOptions) => Promise<ChannelSendResult>
```

3. Add to `MessageRouterOptions<M>`:

```ts
  /** 渠道的回复实现；未提供时 `reply()` 返回 `reply_unsupported` 失败结果。 */
  replyFor?: ReplyFactory<M>
```

4. Replace the handler call `selected.handler(message, { signal })` with:

```ts
            Promise.resolve().then(() => selected.handler(message, { signal, reply: this.replyTo(message, signal) })),
```

5. Add the method:

```ts
  private replyTo(message: M, signal: AbortSignal): (options: ChannelReplyOptions) => Promise<ChannelSendResult> {
    const send = this.options.replyFor?.(message)
    if (!send) return () => replyUnsupported(this.options.channel as ServiceName)
    return (options) => send({ ...options, signal: options.signal ?? signal })
  }
```

Run `npx vitest run tests/unit/message-router.test.ts` — the two new tests pass.

- [ ] **Step 5: Write the failing channel reply tests**

Create `tests/unit/channel-reply.test.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { FeishuService } from '../../src/feishu/service.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createFakeFeishuSdk, useFakeFeishuSdk } from '../../src/testing/fake-feishu.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

const dingtalkEvent = (id: string, group: string, sender = 'sender-1') => ({
  type: 'user_im_message_receive_at', event_id: id, message_id: `msg-${id}`, conversation_id: group, sender_open_dingtalk_id: sender, content: 'ping', timestamp: 1,
})

describe('context.reply()', () => {
  let root: TestRoot
  let dws: ReturnType<typeof createFakeDws>
  const savedEnv = { ...process.env }

  beforeEach(() => {
    root = createRoot()
    dws = createFakeDws()
    process.env.DWS_CONFIG_DIR = dws.dir
  })
  afterEach(async () => {
    await root.dispose()
    dws.cleanup()
    process.env = { ...savedEnv }
  })

  it('DingTalk replies to the group, or to the sender in a single chat', async () => {
    dws.setScenario({ eventDelayMs: 50, events: [dingtalkEvent('e1', 'cidGroup'), dingtalkEvent('e2', 'cidmeSingle', 'od-user')] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    const results: unknown[] = []
    await root.root.plugin({
      name: 'biz', inject: ['dingtalk'], apply(ctx: Context) {
        for (const conversationId of ['cidGroup', 'cidmeSingle']) {
          ctx.dingtalk.onMessage({ conversationId }, async (_m, { reply }) => { results.push(await reply({ text: 'pong' })) })
        }
      },
    })
    await until(() => results.length === 2)
    const sends = dws.calls().filter((c) => c.args[1] === '+messages-send')
    expect(sends.some((c) => c.args.some((a) => a.includes('cidGroup')))).toBe(true)
    expect(sends.some((c) => c.args.some((a) => a.includes('od-user')))).toBe(true)
    expect(results).toEqual([expect.objectContaining({ results: [expect.objectContaining({ ok: true })] }), expect.objectContaining({ results: [expect.objectContaining({ ok: true })] })])
  })

  it('DingTalk reply failures are returned, not thrown', async () => {
    dws.setScenario({ eventDelayMs: 50, events: [dingtalkEvent('e1', 'cidGroup')], send: [{ mode: 'fail', category: 'server', message: 'boom' }] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, killGraceMs: 50 })
    let replied: any
    await root.root.plugin({ name: 'biz', inject: ['dingtalk'], apply(ctx: Context) { ctx.dingtalk.onMessage({ conversationId: 'cidGroup' }, async (_m, { reply }) => { replied = await reply({ text: 'pong' }) }) } })
    await until(() => replied !== undefined)
    expect(replied.results[0]).toMatchObject({ ok: false })
  })

  it('Feishu replies to the conversation chat_id', async () => {
    process.env.FEISHU_APP_SECRET = 'secret-value'
    const fake = createFakeFeishuSdk({ botOpenId: 'ou_bot' })
    const restore = useFakeFeishuSdk(fake)
    try {
      await root.root.plugin(FeishuService, { appId: 'cli_test' })
      let replied: unknown
      root.root.get('feishu')!.onMessage({ conversationId: 'oc_1' }, async (_m, { reply }) => { replied = await reply({ text: 'pong' }) })
      fake.ready()
      await fake.emit({ sender: { sender_id: { open_id: 'ou_a' } }, message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: 'ping' }), create_time: '1' } })
      await until(() => replied !== undefined)
      expect(fake.sends.at(-1)!.data.receive_id).toBe('oc_1')
      expect(replied).toEqual({ results: [{ ok: true, messageId: expect.any(String) }] })
    } finally {
      restore()
    }
  })
})
```

Check the fake dws send-call shape before relying on `c.args[1] === '+messages-send'` (`grep -n "'+messages-send'" fixtures/fake-dws.mjs src/dingtalk/args.ts`) and that `buildSendArgs` renders `openDingtalkId` targets with the raw id somewhere in args; adjust the two `.some(...)` matchers to the real arg form if needed.

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run tests/unit/channel-reply.test.ts`
Expected: FAIL — results contain `reply_unsupported`.

- [ ] **Step 7: DingTalk and Feishu replyFor**

DingTalk: add a constructor parameter to `DingtalkInbox` after `groupRoutes`:

```ts
    private readonly replyFor?: ReplyFactory<DingtalkAtMessage>,
```

and pass it: `new MessageRouter<DingtalkAtMessage>({ channel: 'dingtalk', logger, onUnmatched, pluginRoutes: groupRoutes, replyFor })` (import `type ReplyFactory` from `'../common/inbox.js'`). In `DingtalkService`, pass a 12th argument to `new DingtalkInbox(...)`:

```ts
      (message) => (options) => safeReply('dingtalk', () => this.send({ ...options, target: replyTarget(message), at: options.at as DingtalkAt | undefined })),
```

and add near the top of `src/dingtalk/service.ts`:

```ts
/** 钉钉回复目标：`cidme` 开头的会话为单聊，回复发送者；其余为群。规则与 iproost 生产代码一致。 */
function replyTarget(message: DingtalkAtMessage): DingtalkTarget {
  return message.conversationId.startsWith('cidme') && message.senderOpenDingtalkId
    ? { openDingtalkId: message.senderOpenDingtalkId }
    : { chatId: message.conversationId }
}
```

Before relying on the `cidme` rule, check the raw dws event for a conversation-type field: `grep -rn "conversation_type\|conversationType\|single\|group_chat" src/dingtalk/inbox.ts fixtures/fake-dws.mjs`. If dws exposes an explicit type, prefer it in `parseAtMessage` and `replyTarget`, keep `cidme` as the fallback, and say so in the report.

Feishu: in `FeishuService`'s constructor, add `replyFor` to the router options:

```ts
      replyFor: (message) => (options) => safeReply('feishu', () => this.send({ ...options, target: { chatId: message.conversationId }, at: options.at as FeishuAt | undefined })),
```

Import `safeReply` from `'../common/reply.js'` in both services.

- [ ] **Step 8: Export the new types**

`src/index.ts`: add `ChannelMessageContext`, `ChannelReplyOptions` to the `export type { … } from './common/channel.js'` block.

- [ ] **Step 9: Run tests**

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: all pass, including unchanged `tests/unit/dingtalk-inbox.test.ts`, `tests/unit/dingtalk.test.ts`, `tests/unit/feishu-inbox.test.ts`.

- [ ] **Step 10: Commit**

```bash
git add src tests
git commit -m "feat(channel): context.reply() for DingTalk and Feishu message handlers"
```

---

### Task 2: 企业微信发送（SDK 接缝、假 SDK、配置、错误、内容构造、`send` / `status` / `health`）

**Files:**
- Modify: `src/common/errors.ts`（`ServiceName` 加 `'wecom'`）
- Create: `src/wecom/sdk.ts`、`src/wecom/config.ts`、`src/wecom/errors.ts`、`src/wecom/message.ts`、`src/wecom/service.ts`、`src/wecom/index.ts`
- Create: `src/testing/fake-wecom.ts`；Modify: `src/testing/index.ts`
- Modify: `package.json`（devDependency）
- Test: `tests/unit/wecom-send.test.ts`

**Interfaces:**
- Consumes: `ChannelService`、`ChannelSendCommon`、`ChannelSendResult`、`ChannelStatus`；`KitService`；`ConfigError`、`KitError`；`resolveSecretRef`；`registerSecret`、`digest`、`redact`
- Produces:
  ```ts
  // src/wecom/sdk.ts
  export interface WecomFrame { headers: { req_id: string; [k: string]: unknown }; body?: unknown; errcode?: number; errmsg?: string }
  export interface WecomSendBody { msgtype: 'markdown'; markdown: { content: string } }
  export interface WecomHandlers { onAuthenticated(): void; onDisconnected(reason: string): void; onReconnecting(attempt: number): void; onError(error: Error): void; onKicked(): void; onMessage(frame: WecomFrame): void }
  export interface WecomConnection {
    sendMessage(chatid: string, body: WecomSendBody): Promise<WecomFrame>
    replyStream(frame: WecomFrame, streamId: string, content: string): Promise<WecomFrame>
    readonly connected: boolean
    disconnect(): void
  }
  export interface WecomSdkOptions { botId: string; secret: string; wsUrl?: string; requestTimeout: number; logger: KitLogger }
  export interface WecomSdk { connect(options: WecomSdkOptions, handlers: WecomHandlers): WecomConnection }
  export type WecomSdkLoader = () => Promise<WecomSdk>
  export const loadWecomSdk: WecomSdkLoader
  export function formatSdkLog(args: unknown[]): string
  // src/wecom/config.ts
  export type WecomTarget = { chatId: string } | { userId: string }
  export interface WecomConfig { botId: string; secretRef: string; defaultTarget?: WecomTarget; groupRoutes: Array<{ conversationId: string; pluginId: string }>; timeoutMs: number; wsUrl?: string; dryRun: boolean }
  export const WecomConfig: z<ConfigInput<WecomConfig>, WecomConfig>
  export const WECOM_SECRET_REF = 'WECOM_BOT_SECRET'
  // src/wecom/errors.ts
  export type WecomErrorCode = 'invalid_target' | 'auth_failed' | 'not_interacted' | 'rate_limited' | 'not_connected' | 'timeout' | 'aborted' | 'api_error'
  export class WecomSendError extends KitError { constructor(code: WecomErrorCode, message: string, options?: KitErrorOptions) }
  export function classifyErrcode(errcode: number, errmsg: string, interacted: boolean): WecomSendError
  export function classifyThrown(e: unknown, interacted: boolean): WecomSendError
  // src/wecom/message.ts
  export interface WecomAt { userIds?: string[]; all?: boolean }
  export const MAX_CONTENT_BYTES = 20480
  export function assertWecomId(kind: string, value: unknown): string
  export function buildContent(input: { title?: string; markdown?: string; text?: string; at?: WecomAt }): string
  export function resolveTarget(target: WecomTarget | undefined): { chatid: string; conversationId: string; chatType: 'group' | 'single' }
  // src/wecom/service.ts
  export interface WecomSendOptions extends ChannelSendCommon { target?: WecomTarget; at?: WecomAt }
  export interface WecomSendResult { results: Array<{ ok: boolean; messageId?: string; error?: WecomSendError }> }
  export class WecomService extends KitService<WecomCounters> implements ChannelService<WecomTarget, WecomAt> {
    static Config; static sdkLoader: WecomSdkLoader; static keyStore: Pick<KeyStoreOptions, 'credentialsFile' | 'env'>
    send(o: WecomSendOptions): Promise<WecomSendResult>; status(): Promise<ChannelStatus>; health(): ServiceHealth<WecomCounters>
  }
  // src/testing/fake-wecom.ts
  export interface FakeWecomStep { errcode?: number; errmsg?: string; throw?: 'timeout' | 'disconnected' }
  export interface FakeWecom { sdk: WecomSdk; sends: Array<{ chatid: string; body: WecomSendBody }>; replies: Array<{ frame: WecomFrame; content: string }>; setSend(steps: FakeWecomStep[]): void; setReply(steps: FakeWecomStep[]): void; authenticate(): void; disconnect(reason?: string): void; reconnecting(): void; error(e: Error): void; kick(): void; emit(frame: WecomFrame): Promise<void>; connects(): number; disconnected(): boolean }
  export function createFakeWecomSdk(options?: { send?: FakeWecomStep[]; reply?: FakeWecomStep[] }): FakeWecom
  export function useFakeWecomSdk(fake: FakeWecom): () => void
  ```

- [ ] **Step 1: Install the SDK as a dev dependency; widen `ServiceName`**

Run: `npm install --save-dev @wecom/aibot-node-sdk@^1.0.7`

In `src/common/errors.ts`, add `'wecom'` to `ServiceName` after `'feishu'`.

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/wecom-send.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildContent, resolveTarget, MAX_CONTENT_BYTES } from '../../src/wecom/message.js'
import { classifyErrcode } from '../../src/wecom/errors.js'
import { WecomService } from '../../src/wecom/service.js'
import { createFakeWecomSdk, useFakeWecomSdk, type FakeWecom } from '../../src/testing/fake-wecom.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('wecom message building', () => {
  it('renders text and markdown as markdown, title as a bold first line, and mentions', () => {
    expect(buildContent({ text: 'hi' })).toBe('hi')
    expect(buildContent({ title: '告警', markdown: '**down**' })).toBe('**告警**\n\n**down**')
    expect(buildContent({ text: 'x', at: { userIds: ['zhangsan'], all: true } })).toBe('x <@zhangsan> <@all>')
  })

  it('validates bodies, sizes and targets', () => {
    expect(() => buildContent({})).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildContent({ text: 'a', markdown: 'b' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildContent({ text: '字'.repeat(Math.floor(MAX_CONTENT_BYTES / 3) + 1) })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(resolveTarget({ chatId: 'wrkXYZ' })).toEqual({ chatid: 'wrkXYZ', conversationId: 'wrkXYZ', chatType: 'group' })
    expect(resolveTarget({ userId: 'zhangsan' })).toEqual({ chatid: 'zhangsan', conversationId: 'zhangsan', chatType: 'single' })
    expect(() => resolveTarget(undefined)).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => resolveTarget({ chatId: 'has space' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => resolveTarget({ userId: '-x' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
  })

  it('classifies documented errcodes, using interaction history for 846607', () => {
    expect(classifyErrcode(853000, 'x', false).code).toBe('auth_failed')
    expect(classifyErrcode(93008, 'x', false).code).toBe('invalid_target')
    expect(classifyErrcode(846607, 'x', false).code).toBe('not_interacted')
    expect(classifyErrcode(846607, 'x', true)).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(classifyErrcode(45009, 'x', true)).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(classifyErrcode(123456, 'x', true)).toMatchObject({ code: 'api_error', retryable: false })
  })
})

describe('WecomService send', () => {
  let root: TestRoot
  let fake: FakeWecom
  let restore: () => void
  const savedEnv = { ...process.env }
  const config = { botId: 'bot1', defaultTarget: { chatId: 'wrkGroup' } }

  beforeEach(() => {
    root = createRoot()
    process.env.WECOM_BOT_SECRET = 'secret-value'
    fake = createFakeWecomSdk()
    restore = useFakeWecomSdk(fake)
  })
  afterEach(async () => {
    await root.dispose()
    restore()
    process.env = { ...savedEnv }
  })

  it('returns not_connected before authentication and sends markdown once connected', async () => {
    await root.root.plugin(WecomService, config)
    const wecom = root.root.get('wecom')!
    expect((await wecom.send({ text: 'hello' })).results[0]).toMatchObject({ ok: false, error: { code: 'not_connected', retryable: true } })
    fake.authenticate()
    expect((await wecom.send({ text: 'hello' })).results).toEqual([{ ok: true, messageId: expect.any(String) }])
    expect(fake.sends.at(-1)).toEqual({ chatid: 'wrkGroup', body: { msgtype: 'markdown', markdown: { content: 'hello' } } })
  })

  it('dedupes by idempotencyKey within the process and does not retry', async () => {
    await root.root.plugin(WecomService, config)
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    const first = await wecom.send({ text: 'x', idempotencyKey: 'k1' })
    const second = await wecom.send({ text: 'x', idempotencyKey: 'k1' })
    expect(second).toEqual(first)
    expect(fake.sends).toHaveLength(1)
    fake.setSend([{ errcode: 45009, errmsg: 'freq' }, {}])
    expect((await wecom.send({ text: 'y', idempotencyKey: 'k2' })).results[0]).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
    expect(fake.sends).toHaveLength(2)
  })

  it('maps a 846607 to an unknown conversation as not_interacted', async () => {
    await root.root.plugin(WecomService, config)
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    fake.setSend([{ errcode: 846607, errmsg: 'limited' }])
    expect((await wecom.send({ text: 'x', target: { chatId: 'wrkNew' } })).results[0]).toMatchObject({ ok: false, error: { code: 'not_interacted' } })
    expect(wecom.health()).toMatchObject({ status: 'degraded' })
  })

  it('times out and aborts without retrying', async () => {
    await root.root.plugin(WecomService, { ...config, timeoutMs: 1000 })
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    fake.setSend([{ throw: 'timeout' }])
    expect((await wecom.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } })
    const aborted = new AbortController()
    aborted.abort()
    expect((await wecom.send({ text: 'x', signal: aborted.signal })).results[0]).toMatchObject({ ok: false, error: { code: 'aborted', retryable: false } })
  })

  it('does not call the SDK in dryRun and reports bot status', async () => {
    await root.root.plugin(WecomService, { ...config, dryRun: true })
    const wecom = root.root.get('wecom')!
    expect((await wecom.send({ text: 'x' })).results).toEqual([{ ok: true }])
    expect(fake.sends).toHaveLength(0)
    expect(await wecom.status()).toMatchObject({ channel: 'wecom', identity: 'bot', online: false, account: 'bot1' })
    expect('login' in wecom).toBe(false)
  })

  it('fails to start without a secret or a botId', async () => {
    delete process.env.WECOM_BOT_SECRET
    WecomService.keyStore = { credentialsFile: '/nonexistent/credentials.yaml' }
    try {
      await expect(root.root.plugin(WecomService, config)).rejects.toThrow(/WECOM_BOT_SECRET is not set/)
      await expect(root.root.plugin(WecomService, {} as never)).rejects.toThrow(/botId/)
    } finally {
      WecomService.keyStore = {}
    }
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/wecom-send.test.ts`
Expected: FAIL — `Failed to load url ../../src/wecom/message.js`.

- [ ] **Step 4: `src/wecom/sdk.ts`**

```ts
import { ConfigError } from '../common/errors.js'
import type { KitLogger } from '../common/logger.js'

/** 长连接帧；回复与主动发送失败时 SDK 以带 `errcode` 的帧 reject。 */
export interface WecomFrame {
  cmd?: string
  headers: { req_id: string; [key: string]: unknown }
  body?: unknown
  errcode?: number
  errmsg?: string
}

export interface WecomSendBody {
  msgtype: 'markdown'
  markdown: { content: string }
}

export interface WecomHandlers {
  onAuthenticated(): void
  onDisconnected(reason: string): void
  onReconnecting(attempt: number): void
  /** 认证失败重试用尽等终态错误。 */
  onError(error: Error): void
  /** 被另一条连接挤下线；SDK 不会再自动重连。 */
  onKicked(): void
  /** 消息帧（`aibot_msg_callback`）；必须同步返回。 */
  onMessage(frame: WecomFrame): void
}

export interface WecomConnection {
  sendMessage(chatid: string, body: WecomSendBody): Promise<WecomFrame>
  /** 基于收到的帧一次性回复（流式消息直接 finish）。 */
  replyStream(frame: WecomFrame, streamId: string, content: string): Promise<WecomFrame>
  readonly connected: boolean
  disconnect(): void
}

export interface WecomSdkOptions {
  botId: string
  secret: string
  wsUrl?: string
  requestTimeout: number
  logger: KitLogger
}

export interface WecomSdk {
  connect(options: WecomSdkOptions, handlers: WecomHandlers): WecomConnection
}

export type WecomSdkLoader = () => Promise<WecomSdk>

/** 只取 SDK 日志参数中的安全字段，不序列化整个对象（帧里有消息正文）。 */
export function formatSdkLog(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === 'string') return arg
    if (arg === null || typeof arg !== 'object') return String(arg)
    const e = arg as { message?: unknown; errcode?: unknown; errmsg?: unknown }
    const fields: string[] = []
    if (typeof e.message === 'string') fields.push(e.message)
    if (typeof e.errcode === 'number') fields.push(`errcode=${e.errcode}`)
    if (typeof e.errmsg === 'string') fields.push(`errmsg=${e.errmsg}`)
    return fields.length ? fields.join(' ') : '[object]'
  }).join(' ')
}

/** 默认从 @wecom/aibot-node-sdk 加载（可选 peer，只在启用 wecom 时加载）。 */
export const loadWecomSdk: WecomSdkLoader = async () => {
  let sdk: typeof import('@wecom/aibot-node-sdk')
  try {
    sdk = await import('@wecom/aibot-node-sdk')
  } catch (e) {
    throw new ConfigError('wecom', '@wecom/aibot-node-sdk is not installed; it is required when the wecom service is enabled', { cause: (e as Error).message })
  }
  return {
    connect({ botId, secret, wsUrl, requestTimeout, logger }, handlers) {
      const bridge = {
        debug: (m: string, ...a: unknown[]) => logger.debug('wecom sdk', { message: formatSdkLog([m, ...a]) }),
        info: (m: string, ...a: unknown[]) => logger.debug('wecom sdk', { message: formatSdkLog([m, ...a]) }),
        warn: (m: string, ...a: unknown[]) => logger.warn('wecom sdk', { message: formatSdkLog([m, ...a]) }),
        error: (m: string, ...a: unknown[]) => logger.error('wecom sdk', { message: formatSdkLog([m, ...a]) }),
      }
      const client = new sdk.WSClient({
        botId,
        secret,
        ...(wsUrl ? { wsUrl } : {}),
        requestTimeout,
        maxReconnectAttempts: -1,
        maxAuthFailureAttempts: 5,
        logger: bridge,
      })
      client.on('authenticated', handlers.onAuthenticated)
      client.on('disconnected', handlers.onDisconnected)
      client.on('reconnecting', handlers.onReconnecting)
      client.on('error', handlers.onError)
      client.on('event.disconnected_event', () => handlers.onKicked())
      client.on('message', (frame) => handlers.onMessage(frame as unknown as WecomFrame))
      client.connect()
      return {
        sendMessage: (chatid, body) => client.sendMessage(chatid, body) as Promise<WecomFrame>,
        replyStream: (frame, streamId, content) => client.replyStream(frame as never, streamId, content, true) as Promise<WecomFrame>,
        get connected() { return client.isConnected },
        disconnect: () => client.disconnect(),
      }
    },
  }
}
```

Verify each member against `node_modules/@wecom/aibot-node-sdk/dist/client.d.ts` and `dist/types/*.d.ts` (`WSClient` constructor options, `on(...)` event names including `event.disconnected_event`, `sendMessage`, `replyStream`, `isConnected`, `disconnect`, logger interface `debug/info/warn/error(message, ...args)`). If a name or shape differs, fix it **here only** — the `WecomSdk` interface and the service stay as specified. If `sendMessage` needs an explicit chat type (the docs recommend `chat_type: 1` single / `2` group), extend `WecomSendBody` handling in this adapter only, passing it through from the service via a third `chatType` argument added to `WecomConnection.sendMessage`; then also update the fake and the service call.

- [ ] **Step 5: `src/wecom/config.ts`**

```ts
import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'

export const WECOM_SECRET_REF = 'WECOM_BOT_SECRET'

export type WecomTarget = { chatId: string } | { userId: string }

export interface WecomConfig {
  botId: string
  /** Secret 的密钥引用：先读同名环境变量，再读 dsh 凭据文件。 */
  secretRef: string
  defaultTarget?: WecomTarget
  /** 会话 ID（群 chatid 或单聊 userid）到业务插件 ID 的一对一路由。 */
  groupRoutes: Array<{ conversationId: string; pluginId: string }>
  timeoutMs: number
  wsUrl?: string
  dryRun: boolean
}

const int = () => z.natural().step(1)

const Target = z.union([
  z.object({ chatId: z.string().required() }),
  z.object({ userId: z.string().required() }),
])

export const WecomConfig: z<ConfigInput<WecomConfig>, WecomConfig> = z.object({
  botId: z.string().required().description('企业微信智能机器人的 BotID'),
  secretRef: z.string().default(WECOM_SECRET_REF).description('Secret 的密钥引用：先读同名环境变量，再读 dsh 凭据文件'),
  defaultTarget: Target.description('省略 target 时使用；群为 chatId，单聊为 userId'),
  groupRoutes: z.array(z.object({ conversationId: z.string().required(), pluginId: z.string().required() })).default([]).description('会话 ID（群 chatid 或单聊 userid）到业务插件 ID 的一对一路由；可在 Agent Kit 设置页配置'),
  timeoutMs: int().min(1000).max(120_000).default(15_000).description('单次请求超时（毫秒）'),
  wsUrl: z.string().description('私有部署企业的长连接地址；默认使用企业微信官方地址'),
  dryRun: z.boolean().default(false).description('只记日志，不调用企业微信'),
}) as z<ConfigInput<WecomConfig>, WecomConfig>
```

- [ ] **Step 6: `src/wecom/errors.ts`**

```ts
import { KitError, type KitErrorOptions } from '../common/errors.js'

export type WecomErrorCode = 'invalid_target' | 'auth_failed' | 'not_interacted' | 'rate_limited' | 'not_connected' | 'timeout' | 'aborted' | 'api_error'

const RETRYABLE: ReadonlySet<WecomErrorCode> = new Set(['rate_limited', 'not_connected', 'timeout'])

export class WecomSendError extends KitError {
  declare readonly code: WecomErrorCode

  constructor(code: WecomErrorCode, message: string, options: KitErrorOptions = {}) {
    super('wecom', code, message, { retryable: options.retryable ?? RETRYABLE.has(code), ...options })
    this.name = 'WecomSendError'
  }
}

/**
 * 企业微信全局错误码 → 分类（https://developer.work.weixin.qq.com/document/path/90313，已核实）。
 * 846607「发送消息命中限制」既可能是会话未与机器人互动，也可能是超出频率；用本地会话记录区分。
 */
const ERRCODES: Record<number, WecomErrorCode> = {
  853000: 'auth_failed', // 无效的 bot_id 或者 secret
  40001: 'auth_failed', // 不合法的 secret 参数
  40091: 'auth_failed', // secret 不合法
  846601: 'auth_failed', // 机器人未开启长连接模式
  846609: 'auth_failed', // 机器人未订阅
  40003: 'invalid_target', // 无效的 UserID
  60111: 'invalid_target', // UserID 不存在
  40050: 'invalid_target', // chatid 不存在
  86001: 'invalid_target', // 参数 chatid 不合法
  86003: 'invalid_target', // 参数 chatid 不存在
  93006: 'invalid_target', // 不合法的群 ID
  93008: 'invalid_target', // 不在群里
  45002: 'invalid_target', // 消息内容大小超过限制
  44004: 'invalid_target', // 内容为空
  93017: 'invalid_target', // 请求内容不能为空
  82004: 'invalid_target', // 不合法的消息内容
  40058: 'invalid_target', // 不合法的参数
  45009: 'rate_limited', // 接口调用超过限制
  45033: 'rate_limited', // 接口并发调用超过限制
  [-1]: 'rate_limited', // 系统繁忙（官方建议重试）
  846604: 'api_error', // req_id 已过期（超过 24 小时的回复）
  846605: 'api_error', // 不合法的 req_id
  846606: 'api_error', // 不允许重复回复
}

export function classifyErrcode(errcode: number, errmsg: string, interacted: boolean): WecomSendError {
  if (errcode === 846607) {
    return interacted
      ? new WecomSendError('rate_limited', `wecom send limited (846607): ${errmsg}`, { details: { errcode } })
      : new WecomSendError('not_interacted', '该会话还没有人给机器人发过消息，无法主动发送；先在群里 @ 机器人一次（846607）', { details: { errcode } })
  }
  const code = ERRCODES[errcode] ?? 'api_error'
  return new WecomSendError(code, `wecom error ${errcode}: ${errmsg}`, { details: { errcode } })
}

/** SDK reject 的值：带 errcode 的帧，或超时 / 连接断开的 Error。 */
export function classifyThrown(e: unknown, interacted: boolean): WecomSendError {
  if (e instanceof WecomSendError) return e
  const frame = e as { errcode?: unknown; errmsg?: unknown; message?: unknown }
  if (typeof frame?.errcode === 'number' && frame.errcode !== 0) return classifyErrcode(frame.errcode, String(frame.errmsg ?? ''), interacted)
  const message = String(frame?.message ?? e)
  if (/timeout/i.test(message)) return new WecomSendError('timeout', `wecom request timed out: ${message}`, { cause: e })
  if (/not connected|disconnect|cancelled|closed/i.test(message)) return new WecomSendError('not_connected', `wecom connection unavailable: ${message}`, { cause: e })
  return new WecomSendError('api_error', `wecom request failed: ${message}`, { cause: e })
}
```

Check the SDK's actual reject messages for "not connected" before relying on the regex: `grep -n "reject(new Error" node_modules/@wecom/aibot-node-sdk/dist/index.esm.js | head -20`; adjust the patterns to the real texts.

- [ ] **Step 7: `src/wecom/message.ts`**

```ts
import type { WecomTarget } from './config.js'
import { WecomSendError } from './errors.js'

export interface WecomAt {
  /** 要 @ 的成员 userid。 */
  userIds?: string[]
  all?: boolean
}

/** `markdown.content` 上限（UTF-8 字节，官方文档）。 */
export const MAX_CONTENT_BYTES = 20480

const ID = /^[\x21-\x7e]{1,128}$/

export function assertWecomId(kind: string, value: unknown): string {
  if (typeof value !== 'string' || value.startsWith('-') || !ID.test(value)) {
    throw new WecomSendError('invalid_target', `invalid ${kind}`, { details: { kind } })
  }
  return value
}

/** 群为 chatid；单聊的 chatid 是对方 userid。 */
export function resolveTarget(target: WecomTarget | undefined): { chatid: string; conversationId: string; chatType: 'group' | 'single' } {
  if (!target) throw new WecomSendError('invalid_target', 'target is required')
  if ('chatId' in target) {
    const id = assertWecomId('chatId', target.chatId)
    return { chatid: id, conversationId: id, chatType: 'group' }
  }
  const id = assertWecomId('userId', target.userId)
  return { chatid: id, conversationId: id, chatType: 'single' }
}

/** 主动发送与回复都只发 Markdown；`text` 原样作为 Markdown 内容，`title` 为加粗首行。 */
export function buildContent(input: { title?: string; markdown?: string; text?: string; at?: WecomAt }): string {
  if (input.markdown !== undefined && input.text !== undefined) throw new WecomSendError('invalid_target', 'markdown and text are mutually exclusive')
  if (input.markdown === undefined && input.text === undefined) throw new WecomSendError('invalid_target', 'either markdown or text is required')
  const body = (input.markdown ?? input.text)!
  const mentions = [...(input.at?.userIds ?? []).map((id) => assertWecomId('userId', id)), ...(input.at?.all ? ['all'] : [])].map((id) => `<@${id}>`).join(' ')
  const head = input.title ? `**${input.title}**\n\n` : ''
  const content = `${head}${body}${mentions ? ` ${mentions}` : ''}`
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) throw new WecomSendError('invalid_target', `content exceeds ${MAX_CONTENT_BYTES} bytes`)
  return content
}
```

Verify the mention syntax for smart-bot Markdown against the official "markdown-v2" format document linked from https://developer.work.weixin.qq.com/document/path/101463. If `<@userid>` is not the documented syntax, change the one `map` line and the test expectation together, and note it in the report.

- [ ] **Step 8: Fake SDK `src/testing/fake-wecom.ts`**

```ts
import { WecomService } from '../wecom/service.js'
import type { WecomConnection, WecomFrame, WecomHandlers, WecomSdk, WecomSendBody } from '../wecom/sdk.js'

export interface FakeWecomStep {
  errcode?: number
  errmsg?: string
  throw?: 'timeout' | 'disconnected'
}

export interface FakeWecom {
  sdk: WecomSdk
  sends: Array<{ chatid: string; body: WecomSendBody }>
  replies: Array<{ frame: WecomFrame; streamId: string; content: string }>
  /** 按调用次序取，用完重复最后一个；默认成功。 */
  setSend(steps: FakeWecomStep[]): void
  setReply(steps: FakeWecomStep[]): void
  authenticate(): void
  disconnect(reason?: string): void
  reconnecting(): void
  error(error: Error): void
  kick(): void
  /** 推送一帧消息并让路由器有机会投递。 */
  emit(frame: WecomFrame): Promise<void>
  connects(): number
  disconnected(): boolean
}

function stepper(initial: FakeWecomStep[]) {
  let steps = initial
  let calls = 0
  return {
    set(next: FakeWecomStep[]) { steps = next; calls = 0 },
    next(): FakeWecomStep { const s = steps.length ? steps[Math.min(calls, steps.length - 1)]! : {}; calls++; return s },
  }
}

async function settle(step: FakeWecomStep, reqId: string): Promise<WecomFrame> {
  if (step.throw === 'timeout') throw new Error(`Reply ack timeout (10000ms) for reqId: ${reqId}`)
  if (step.throw === 'disconnected') throw new Error(`Connection closed, reply for reqId: ${reqId} cancelled`)
  if (step.errcode) throw { headers: { req_id: reqId }, errcode: step.errcode, errmsg: step.errmsg ?? 'error' }
  return { headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }
}

export function createFakeWecomSdk(options: { send?: FakeWecomStep[]; reply?: FakeWecomStep[] } = {}): FakeWecom {
  const send = stepper(options.send ?? [])
  const reply = stepper(options.reply ?? [])
  const sends: FakeWecom['sends'] = []
  const replies: FakeWecom['replies'] = []
  let handlers: WecomHandlers | undefined
  let connected = false
  let closed = false
  let connects = 0
  let seq = 0
  const need = () => {
    if (!handlers) throw new Error('fake wecom: connect has not been called')
    return handlers
  }
  return {
    sdk: {
      connect(_options, h): WecomConnection {
        handlers = h
        closed = false
        connects++
        return {
          sendMessage: (chatid, body) => { sends.push({ chatid, body }); return settle(send.next(), `send_${++seq}`) },
          replyStream: (frame, streamId, content) => { replies.push({ frame, streamId, content }); return settle(reply.next(), frame.headers.req_id) },
          get connected() { return connected },
          disconnect: () => { closed = true; connected = false },
        }
      },
    },
    sends,
    replies,
    setSend: (s) => send.set(s),
    setReply: (s) => reply.set(s),
    authenticate: () => { connected = true; need().onAuthenticated() },
    disconnect: (reason = 'network') => { connected = false; need().onDisconnected(reason) },
    reconnecting: () => need().onReconnecting(1),
    error: (e) => { connected = false; need().onError(e) },
    kick: () => { connected = false; need().onKicked(); need().onDisconnected('New connection established, server disconnected this connection') },
    emit: async (frame) => {
      need().onMessage(frame)
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    },
    connects: () => connects,
    disconnected: () => closed,
  }
}

/** 让 `WecomService` 使用假 SDK；返回恢复函数。 */
export function useFakeWecomSdk(fake: FakeWecom): () => void {
  const previous = WecomService.sdkLoader
  WecomService.sdkLoader = async () => fake.sdk
  return () => { WecomService.sdkLoader = previous }
}
```

Add to `src/testing/index.ts`:

```ts
export { createFakeWecomSdk, useFakeWecomSdk, type FakeWecom, type FakeWecomStep } from './fake-wecom.js'
```

- [ ] **Step 9: `WecomService` (send, status, health; receiving in Task 3)**

Create `src/wecom/service.ts`. Mirror the structure of `src/feishu/service.ts` (secret resolution in `[Service.init]`, `registerSecret`, `stopping` getter, counters, `recordSuccess` / `recordFailure`) with this content:

```ts
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ChannelSendCommon, ChannelService, ChannelStatus } from '../common/channel.js'
import { ConfigError } from '../common/errors.js'
import { digest, registerSecret } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import { resolveSecretRef, type KeyStoreOptions } from '../secrets/index.js'
import { WecomConfig, type WecomTarget } from './config.js'
import { WecomSendError, classifyThrown } from './errors.js'
import { buildContent, resolveTarget, type WecomAt } from './message.js'
import { loadWecomSdk, type WecomConnection, type WecomSdkLoader } from './sdk.js'

export interface WecomSendOptions extends ChannelSendCommon {
  target?: WecomTarget
  at?: WecomAt
}

export interface WecomSendResult {
  results: Array<{ ok: boolean; messageId?: string; error?: WecomSendError }>
}

export interface WecomCounters {
  success: number
  failure: number
  lastFailureAt: number | null
  lastErrorCode: string | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    wecom: WecomService
  }
}

const DEDUPE_MS = 10 * 60_000

/**
 * 企业微信智能机器人：长连接收发。企业微信没有服务端去重字段，`idempotencyKey` 只在本进程内去重，
 * 且不自动重试（超时时无法判断是否已送达）。SDK 只经 {@link WecomSdk} 使用；`sdkLoader` 是测试替换入口。
 */
export class WecomService extends KitService<WecomCounters> implements ChannelService<WecomTarget, WecomAt> {
  static Config = WecomConfig
  /** 测试钩子：替换 SDK 的加载方式。 */
  static sdkLoader: WecomSdkLoader = loadWecomSdk
  /** 测试钩子：覆盖密钥解析的凭据文件路径 / 环境变量。 */
  static keyStore: Pick<KeyStoreOptions, 'credentialsFile' | 'env'> = {}
  readonly config: WecomConfig
  protected connection?: WecomConnection
  protected secret?: string
  protected authenticated = false
  protected readonly controller = new AbortController()
  private lastSuccessAt: number | null = null
  private readonly sent = new Map<string, { at: number; result: WecomSendResult }>()
  private readonly counters: WecomCounters = { success: 0, failure: 0, lastFailureAt: null, lastErrorCode: null }

  constructor(ctx: Context, config: WecomConfig) {
    super(ctx, 'wecom')
    this.config = config
    if (!config.botId?.trim()) throw new ConfigError('wecom', 'botId is required', { field: 'botId' })
    if (config.defaultTarget) resolveTarget(config.defaultTarget)
    ctx.effect(() => () => this.controller.abort(), 'wecom.abortInFlight')
  }

  async [Service.init](): Promise<void> {
    const credentials = (this.ctx as unknown as { get(name: string): KeyStoreOptions['credentials'] }).get('credentials')
    const resolved = await resolveSecretRef(this.config.secretRef, { ...WecomService.keyStore, credentials })
    if (!resolved) throw new ConfigError('wecom', `${this.config.secretRef} is not set and was not found in the dsh credentials store`, { field: 'secretRef' })
    this.secret = resolved.value
    this.ctx.effect(() => registerSecret(resolved.value), 'wecom.secret')
    this.logger.info('secret resolved', { ref: this.config.secretRef, source: resolved.source })
    const sdk = await WecomService.sdkLoader()
    if (this.config.dryRun || this.stopping) return
    this.startConnection(sdk)
  }

  /** 与飞书相同：init 期间被卸载时，Cordis 先清空 fiber.uid，init 结束后才 abort。 */
  private get stopping(): boolean {
    return this.controller.signal.aborted || this.ctx.fiber.uid === null
  }

  /** Task 3 扩展：接收、会话记录、生命周期。这里只维护认证状态。 */
  protected startConnection(sdk: Awaited<ReturnType<WecomSdkLoader>>): void {
    const connection = sdk.connect(
      { botId: this.config.botId, secret: this.secret!, ...(this.config.wsUrl ? { wsUrl: this.config.wsUrl } : {}), requestTimeout: this.config.timeoutMs, logger: this.logger },
      {
        onAuthenticated: () => { this.authenticated = true },
        onDisconnected: () => { this.authenticated = false },
        onReconnecting: () => { this.authenticated = false },
        onError: () => { this.authenticated = false },
        onKicked: () => { this.authenticated = false },
        onMessage: () => {},
      },
    )
    this.connection = connection
    this.ctx.effect(() => () => connection.disconnect(), 'wecom.connection')
  }

  /** Task 3 用会话记录判断 846607；这里没有记录，一律视为未互动。 */
  protected hasInteracted(_conversationId: string): boolean {
    return false
  }

  /**
   * 主动发送。目标会话须有人先给机器人发过消息（否则 `not_interacted`）；`timeout` 不代表未送达。
   * `idempotencyKey` 在本进程内 10 分钟去重，进程重启后失效。
   */
  async send(options: WecomSendOptions): Promise<WecomSendResult> {
    const target = resolveTarget(options.target ?? this.config.defaultTarget)
    const content = buildContent({ title: options.title, markdown: options.markdown, text: options.text, at: options.at })
    if (options.idempotencyKey !== undefined && !/^[A-Za-z0-9._:@-]{1,128}$/.test(options.idempotencyKey)) {
      throw new WecomSendError('invalid_target', 'invalid idempotencyKey', { details: { kind: 'idempotencyKey' } })
    }
    this.pruneSent()
    const previous = options.idempotencyKey !== undefined ? this.sent.get(options.idempotencyKey) : undefined
    if (previous) return previous.result
    if (this.config.dryRun) {
      this.logger.info('wecom send (dry-run)', { traceId: options.traceId, body: digest(content) })
      this.recordSuccess()
      return { results: [{ ok: true }] }
    }
    this.logger.info('wecom send', { traceId: options.traceId, chatType: target.chatType, body: digest(content) })
    const outcome = await this.sendOnce(target, content, options.signal)
    if (outcome instanceof WecomSendError) {
      this.recordFailure(outcome.code)
      this.logger.warn('wecom send failed', { traceId: options.traceId, code: outcome.code })
      return { results: [{ ok: false, error: outcome }] }
    }
    this.recordSuccess()
    const result: WecomSendResult = { results: [{ ok: true, messageId: outcome }] }
    if (options.idempotencyKey !== undefined) this.sent.set(options.idempotencyKey, { at: Date.now(), result })
    return result
  }

  private pruneSent(): void {
    const cutoff = Date.now() - DEDUPE_MS
    for (const [key, entry] of this.sent) if (entry.at < cutoff) this.sent.delete(key)
  }

  /** 成功返回请求 ID（作 messageId），失败返回分类后的错误。 */
  private async sendOnce(target: ReturnType<typeof resolveTarget>, content: string, signal?: AbortSignal): Promise<string | WecomSendError> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = AbortSignal.any([timeout, this.controller.signal, ...(signal ? [signal] : [])])
    if (combined.aborted) return timeout.aborted ? new WecomSendError('timeout', `wecom send timed out after ${this.config.timeoutMs}ms`) : new WecomSendError('aborted', 'wecom send aborted')
    if (!this.connection || !this.authenticated) return new WecomSendError('not_connected', 'wecom long connection is not ready')
    try {
      const frame = await Promise.race([
        this.connection.sendMessage(target.chatid, { msgtype: 'markdown', markdown: { content } }),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(timeout.aborted ? new WecomSendError('timeout', `wecom send timed out after ${this.config.timeoutMs}ms`) : new WecomSendError('aborted', 'wecom send aborted'))
          if (combined.aborted) onAbort()
          else combined.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      return frame.headers.req_id
    } catch (e) {
      return classifyThrown(e, this.hasInteracted(target.conversationId))
    }
  }

  async status(): Promise<ChannelStatus> {
    return {
      channel: 'wecom',
      identity: 'bot',
      online: this.authenticated,
      account: this.config.botId,
      detail: this.authenticated ? 'long connection ready' : this.failure ?? 'not connected',
      checkedAt: Date.now(),
    }
  }

  protected recordSuccess(): void {
    this.counters.success++
    this.lastSuccessAt = Date.now()
  }

  protected recordFailure(code: string): void {
    this.counters.failure++
    this.counters.lastFailureAt = Date.now()
    this.counters.lastErrorCode = code
  }

  health(): ServiceHealth<WecomCounters> {
    const counters = { ...this.counters }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : `bot: ${this.config.botId}`, counters }
  }
}

export default WecomService
```

Create `src/wecom/index.ts`:

```ts
export { WecomService as default, WecomService, type WecomCounters, type WecomSendOptions, type WecomSendResult } from './service.js'
export { WecomConfig, WECOM_SECRET_REF, type WecomTarget } from './config.js'
export { WecomSendError, type WecomErrorCode } from './errors.js'
export { buildContent, MAX_CONTENT_BYTES, type WecomAt } from './message.js'
export type { WecomSdk, WecomConnection, WecomFrame, WecomHandlers, WecomSdkLoader } from './sdk.js'
```

- [ ] **Step 10: Run tests**

Run: `npx vitest run tests/unit/wecom-send.test.ts`, then `npm run typecheck && npx vitest run`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/common/errors.ts src/wecom src/testing tests/unit/wecom-send.test.ts
git commit -m "feat(wecom): smart-bot sending through the WeCom SDK with a fake SDK for tests"
```

---

### Task 3: 企业微信接收、回复、会话记录与生命周期

**Files:**
- Create: `src/wecom/event.ts`、`src/wecom/conversations.ts`
- Modify: `src/wecom/service.ts`、`src/wecom/index.ts`
- Modify: `docs/superpowers/specs/2026-10-26-wecom-channel-design.md`（挤下线为 `failed`）
- Test: `tests/unit/wecom-inbox.test.ts`

**Interfaces:**
- Consumes: `MessageRouter`、`ReplyFactory`（Task 1）、`UnmatchedStore`、`unmatchedFileKey`；`WecomConnection`、`FakeWecom`（Task 2）；`safeReply`（Task 1）
- Produces:
  ```ts
  // src/wecom/event.ts
  export interface WecomAtMessage extends ChannelAtMessage { chatType: 'group' | 'single'; messageType: string; quote?: string }
  export function parseWecomFrame(frame: unknown): { message: WecomAtMessage; frame: WecomFrame } | undefined
  // src/wecom/conversations.ts
  export interface WecomConversation { conversationId: string; chatType: 'group' | 'single'; lastSenderId?: string; lastMessageAt: number }
  export const MAX_CONVERSATIONS = 500
  export class ConversationStore { constructor(file: string | undefined, onError: (e: unknown) => void); record(c: Omit<WecomConversation, 'lastMessageAt'> & { at?: number }): Promise<void>; has(conversationId: string): Promise<boolean>; list(): Promise<WecomConversation[]> }
  // WecomService additions: onMessage / onPluginMessage / unmatchedMessages / searchRecipients (ChannelInbox<WecomAtMessage, ChannelUnmatchedMessage, WecomTarget>)
  // WecomCounters gains inbox: MessageRouterCounts & { listener: 'idle' | 'ready' | 'reconnecting' | 'failed'; routes: number }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/wecom-inbox.test.ts`:

```ts
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationStore, MAX_CONVERSATIONS } from '../../src/wecom/conversations.js'
import { parseWecomFrame, type WecomAtMessage } from '../../src/wecom/event.js'
import { WecomService } from '../../src/wecom/service.js'
import { createFakeWecomSdk, useFakeWecomSdk, type FakeWecom } from '../../src/testing/fake-wecom.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

const frame = (id: string, body: Record<string, unknown>) => ({ cmd: 'aibot_msg_callback', headers: { req_id: `req-${id}` }, body: { msgid: id, aibotid: 'bot1', from: { userid: 'zhangsan' }, create_time: 1700000000, ...body } })
const groupText = (id: string, chatid: string, content: string) => frame(id, { chatid, chattype: 'group', msgtype: 'text', text: { content } })
const singleText = (id: string, content: string) => frame(id, { chattype: 'single', msgtype: 'text', text: { content } })

describe('parseWecomFrame', () => {
  it('maps group and single text messages, stripping the leading @ in groups and keeping newlines', () => {
    expect(parseWecomFrame(groupText('m1', 'wrkG', '@告警机器人 第一行\n第二行'))?.message).toEqual({
      eventId: 'm1', messageId: 'm1', conversationId: 'wrkG', chatType: 'group', senderId: 'zhangsan', content: '第一行\n第二行', messageType: 'text', timestamp: 1700000000000,
    })
    expect(parseWecomFrame(singleText('m2', '你好'))?.message).toMatchObject({ conversationId: 'zhangsan', chatType: 'single', content: '你好' })
  })

  it('extracts mixed text, voice transcripts and quotes; other types are empty', () => {
    expect(parseWecomFrame(frame('m3', { chattype: 'single', msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: 'a' } }, { msgtype: 'image', image: { url: 'u' } }, { msgtype: 'text', text: { content: 'b' } }] } }))?.message.content).toBe('a\nb')
    expect(parseWecomFrame(frame('m4', { chattype: 'single', msgtype: 'voice', voice: { content: '语音转写' } }))?.message.content).toBe('语音转写')
    expect(parseWecomFrame(frame('m5', { chattype: 'single', msgtype: 'text', text: { content: '回复' }, quote: { msgtype: 'text', text: { content: '原文' } } }))?.message.quote).toBe('原文')
    expect(parseWecomFrame(frame('m6', { chattype: 'single', msgtype: 'image', image: { url: 'u' } }))?.message).toMatchObject({ content: '', messageType: 'image' })
  })

  it('rejects malformed frames', () => {
    expect(parseWecomFrame(null)).toBeUndefined()
    expect(parseWecomFrame({ headers: { req_id: 'r' }, body: { msgtype: 'text' } })).toBeUndefined()
    expect(parseWecomFrame(frame('m7', { chattype: 'group', msgtype: 'text', text: { content: 'x' } }))).toBeUndefined() // 群消息缺 chatid
  })
})

describe('ConversationStore', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wecom-conv-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records, updates, evicts the oldest beyond the cap, and persists privately', async () => {
    const file = join(dir, 'c', 'conv.json')
    const store = new ConversationStore(file, () => {})
    for (let i = 0; i < MAX_CONVERSATIONS + 3; i++) await store.record({ conversationId: `c${i}`, chatType: 'group', at: i })
    await store.record({ conversationId: 'c0', chatType: 'group', lastSenderId: 'u', at: 10_000 })
    const items = await new ConversationStore(file, () => {}).list()
    expect(items).toHaveLength(MAX_CONVERSATIONS)
    expect(items[0]).toMatchObject({ conversationId: 'c0', lastSenderId: 'u' })
    expect(items.some((c) => c.conversationId === 'c1')).toBe(false)
    expect(await store.has('c0')).toBe(true)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('WecomService inbox', () => {
  let root: TestRoot
  let fake: FakeWecom
  let restore: () => void
  let dir: string
  const savedEnv = { ...process.env }

  beforeEach(() => {
    root = createRoot()
    dir = mkdtempSync(join(tmpdir(), 'wecom-'))
    root.root.baseUrl = pathToFileURL(`${dir}/`).href
    process.env.WECOM_BOT_SECRET = 'secret-value'
    fake = createFakeWecomSdk()
    restore = useFakeWecomSdk(fake)
  })
  afterEach(async () => {
    await root.dispose()
    restore()
    rmSync(dir, { recursive: true, force: true })
    process.env = { ...savedEnv }
  })

  it('queues until authenticated, routes by conversation, and replies through the inbound frame', async () => {
    await root.root.plugin(WecomService, { botId: 'bot1' })
    const got: WecomAtMessage[] = []
    let replied: unknown
    await root.root.plugin({ name: 'biz', inject: ['wecom'], apply(ctx: Context) {
      ctx.wecom.onMessage({ conversationId: 'wrkG' }, async (m, { reply }) => { got.push(m); replied = await reply({ text: 'pong' }) })
    } })
    await fake.emit(groupText('m1', 'wrkG', '@bot ping'))
    expect(got).toHaveLength(0)
    fake.authenticate()
    await until(() => replied !== undefined)
    expect(got[0]).toMatchObject({ content: 'ping', chatType: 'group' })
    expect(fake.replies).toEqual([{ frame: expect.objectContaining({ headers: { req_id: 'req-m1' } }), streamId: expect.any(String), content: 'pong' }])
    expect(replied).toEqual({ results: [{ ok: true, messageId: 'req-m1' }] })
  })

  it('records talked-to conversations, finds them in searchRecipients, and uses them to classify 846607', async () => {
    await root.root.plugin(WecomService, { botId: 'bot1' })
    const wecom = root.root.get('wecom')!
    fake.authenticate()
    await fake.emit(groupText('m1', 'wrkOps', 'hi'))
    await fake.emit(singleText('m2', 'hi'))
    await until(async () => (await wecom.searchRecipients('user', 'zhang')).candidates.length === 1)
    expect(await wecom.searchRecipients('group', 'Ops')).toEqual({ candidates: [{ name: 'wrkOps', target: { chatId: 'wrkOps' } }], complete: true })
    expect(await wecom.searchRecipients('user', 'zhang')).toEqual({ candidates: [{ name: 'zhangsan', target: { userId: 'zhangsan' } }], complete: true })
    fake.setSend([{ errcode: 846607, errmsg: 'limited' }])
    expect((await wecom.send({ text: 'x', target: { chatId: 'wrkOps' } })).results[0]).toMatchObject({ error: { code: 'rate_limited' } })
    expect((await wecom.send({ text: 'x', target: { chatId: 'wrkNever' } })).results[0]).toMatchObject({ error: { code: 'not_interacted' } })
    await expect(wecom.searchRecipients('group', '')).rejects.toThrow(/1–80/)
  })

  it('delivers configured conversations to plugins and records unmatched messages', async () => {
    await root.root.plugin(WecomService, { botId: 'bot1', groupRoutes: [{ conversationId: 'wrkG', pluginId: 'orders' }] })
    const wecom = root.root.get('wecom')!
    const got: string[] = []
    wecom.onPluginMessage('orders', (m) => { got.push(m.eventId) })
    fake.authenticate()
    await fake.emit(groupText('m1', 'wrkG', 'a'))
    await fake.emit(groupText('m2', 'wrkOther', '没人处理'))
    await until(async () => got.length === 1 && (await wecom.unmatchedMessages()).length === 1)
    expect(await wecom.unmatchedMessages()).toMatchObject([{ eventId: 'm2', conversationId: 'wrkOther', senderId: 'zhangsan', preview: '没人处理' }])
  })

  it('maps lifecycle: starting degraded, reconnecting degraded, auth error failed, kicked failed with a clear reason', async () => {
    const fork = await root.root.plugin(WecomService, { botId: 'bot1' })
    const wecom = root.root.get('wecom')!
    expect(wecom.health()).toMatchObject({ status: 'degraded', detail: expect.stringContaining('starting') })
    const sub = wecom.onMessage({ conversationId: 'wrkG' }, () => {})
    fake.authenticate()
    await sub.ready
    expect(wecom.health().status).toBe('ok')
    fake.reconnecting()
    expect(wecom.health()).toMatchObject({ status: 'degraded', detail: expect.stringContaining('reconnecting') })
    fake.authenticate()
    fake.kick()
    expect(wecom.health()).toMatchObject({ status: 'failed', detail: expect.stringContaining('另一个进程') })
    expect(root.failures.some((f) => f.service === 'wecom')).toBe(true)
    await fork.dispose()
    expect(fake.disconnected()).toBe(true)
  })

  it('rejects pending ready on auth failure and on unload', async () => {
    const fork = await root.root.plugin(WecomService, { botId: 'bot1' })
    const wecom = root.root.get('wecom')!
    const first = wecom.onMessage({ conversationId: 'a' }, () => {})
    fake.error(new Error('Max auth failure attempts reached'))
    await expect(first.ready).rejects.toThrow(/auth/i)
    expect(wecom.health().status).toBe('failed')
    await fork.dispose()
  })

  it('refuses duplicate routes and listening in dryRun', async () => {
    await expect(root.root.plugin(WecomService, { botId: 'bot1', groupRoutes: [{ conversationId: 'x', pluginId: 'a' }, { conversationId: 'x', pluginId: 'b' }] })).rejects.toThrow(/duplicate group route/)
    await root.root.plugin(WecomService, { botId: 'bot1', dryRun: true })
    expect(() => root.root.get('wecom')!.onMessage({ conversationId: 'x' }, () => {})).toThrow(/dryRun/)
  })
})
```

Before writing `parseWecomFrame`, check the leading-mention format in group text: the SDK README or a real frame (`grep -rn "@" node_modules/@wecom/aibot-node-sdk/README.md | head`). The test assumes `@<机器人名> ` (one `@` token followed by whitespace) at the start; if the real format differs (e.g. `<@botid>`), change the stripping rule and the test input together and note it in the report.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/wecom-inbox.test.ts`
Expected: FAIL — `Failed to load url ../../src/wecom/conversations.js`.

- [ ] **Step 3: `src/wecom/event.ts`**

```ts
import type { ChannelAtMessage } from '../common/channel.js'
import type { WecomFrame } from './sdk.js'

/** 群内 @ 机器人或单聊机器人的消息。正文是外部输入，业务插件必须自行校验；userid 可能是加密 ID，不要假设格式。 */
export interface WecomAtMessage extends ChannelAtMessage {
  chatType: 'group' | 'single'
  messageType: string
  /** 被引用消息的文字。 */
  quote?: string
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function textOf(body: Record<string, unknown>, type: unknown): string {
  if (type === 'text') return String(obj(body.text)?.content ?? '')
  if (type === 'voice') return String(obj(body.voice)?.content ?? '')
  if (type === 'mixed') {
    const items = obj(body.mixed)?.msg_item
    return (Array.isArray(items) ? items : []).flatMap((item) => {
      const i = obj(item)
      return i?.msgtype === 'text' && typeof obj(i.text)?.content === 'string' ? [obj(i.text)!.content as string] : []
    }).join('\n')
  }
  return ''
}

function tidy(text: string): string {
  return text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').trim()
}

/** 解析消息帧；结构不合法时返回 undefined。返回原始帧供回复使用。 */
export function parseWecomFrame(input: unknown): { message: WecomAtMessage; frame: WecomFrame } | undefined {
  const frame = obj(input)
  const headers = obj(frame?.headers)
  const body = obj(frame?.body)
  if (!frame || !headers || typeof headers.req_id !== 'string' || !body) return undefined
  const msgid = str(body.msgid)
  const sender = str(obj(body.from)?.userid)
  const messageType = str(body.msgtype)
  const chatType = body.chattype === 'group' ? 'group' : body.chattype === 'single' ? 'single' : undefined
  if (!msgid || !sender || !messageType || !chatType) return undefined
  const chatid = str(body.chatid)
  if (chatType === 'group' && !chatid) return undefined
  let content = textOf(body, messageType)
  // 群消息开头是 @机器人；只去掉开头这一个
  if (chatType === 'group') content = content.replace(/^\s*@\S+\s*/, '')
  const quoteBody = obj(body.quote)
  const quote = quoteBody ? tidy(textOf(quoteBody, quoteBody.msgtype)) : ''
  const created = Number(body.create_time)
  const message: WecomAtMessage = {
    eventId: msgid,
    messageId: msgid,
    conversationId: chatType === 'group' ? chatid! : sender,
    chatType,
    senderId: sender,
    content: tidy(content),
    messageType,
    ...(quote ? { quote } : {}),
    ...(Number.isFinite(created) && created > 0 ? { timestamp: created < 1e12 ? created * 1000 : created } : {}),
  }
  return { message, frame: frame as unknown as WecomFrame }
}
```

- [ ] **Step 4: `src/wecom/conversations.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { restrictWindowsAcl } from '../secrets/credentials-file.js'

/** 与机器人说过话的会话：只有这些会话能被主动发送。 */
export interface WecomConversation {
  conversationId: string
  chatType: 'group' | 'single'
  lastSenderId?: string
  lastMessageAt: number
}

export const MAX_CONVERSATIONS = 500

function valid(v: unknown): v is WecomConversation {
  const r = v as Record<string, unknown> | null
  return !!r && typeof r === 'object' && typeof r.conversationId === 'string' && !!r.conversationId &&
    (r.chatType === 'group' || r.chatType === 'single') && typeof r.lastMessageAt === 'number' && Number.isFinite(r.lastMessageAt) &&
    (r.lastSenderId === undefined || typeof r.lastSenderId === 'string')
}

/** 最多 500 条、按最后发言时间淘汰；文件 0600，写法与 UnmatchedStore 相同。 */
export class ConversationStore {
  private items = new Map<string, WecomConversation>()
  private loaded?: Promise<void>
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string | undefined,
    private readonly onError: (error: unknown) => void,
  ) {}

  private load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      if (!this.file) return
      try {
        const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(parsed)) throw new Error('invalid wecom conversation file')
        for (const item of parsed.filter(valid)) this.items.set(item.conversationId, item)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error)
      }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve()
    const snapshot = JSON.stringify([...this.items.values()])
    const write = this.writing.catch(() => {}).then(async () => {
      await writeFileAtomic(this.file!, snapshot, { mode: 0o600, dirMode: 0o700 })
      if (process.platform === 'win32') await restrictWindowsAcl(this.file!, { onWarning: this.onError })
    })
    this.writing = write
    return write
  }

  async record(entry: Omit<WecomConversation, 'lastMessageAt'> & { at?: number }): Promise<void> {
    await this.load()
    const { at, ...rest } = entry
    this.items.set(rest.conversationId, { ...this.items.get(rest.conversationId), ...rest, lastMessageAt: at ?? Date.now() })
    if (this.items.size > MAX_CONVERSATIONS) {
      const oldest = [...this.items.values()].sort((a, b) => a.lastMessageAt - b.lastMessageAt).slice(0, this.items.size - MAX_CONVERSATIONS)
      for (const item of oldest) this.items.delete(item.conversationId)
    }
    await this.persist()
  }

  async has(conversationId: string): Promise<boolean> {
    await this.load()
    return this.items.has(conversationId)
  }

  /** 最近发言的在前。 */
  async list(): Promise<WecomConversation[]> {
    await this.load()
    await this.writing.catch(() => {})
    return [...this.items.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt).map((item) => ({ ...item }))
  }
}
```

Note the persistence test checks the file is readable by a second store after records; `record` persists every call, so this holds.

- [ ] **Step 5: Extend `WecomService`**

In `src/wecom/service.ts`, follow `src/feishu/service.ts` lines ~60–260 for the inbox and lifecycle structure (router, unmatched store, ready waiters, `subscribe`, `stopping`), with these WeCom specifics:

1. Imports: `dirname, join` from `'node:path'`, `fileURLToPath` from `'node:url'`; `ChannelInbox, ChannelMessageHandler, ChannelMessageRoute, ChannelMessageSubscription, ChannelRecipientKind, ChannelRecipientSearchResult` from `'../common/channel.js'`; `MessageRouter, type MessageRouterCounts` from `'../common/inbox.js'`; `UnmatchedStore, unmatchedFileKey, type ChannelUnmatchedMessage` from `'../common/unmatched.js'`; `safeReply` from `'../common/reply.js'`; `redact` from `'../common/redact.js'`; `parseWecomFrame, type WecomAtMessage` from `'./event.js'`; `ConversationStore` from `'./conversations.js'`; `type WecomFrame` from `'./sdk.js'`.
2. Class declaration adds `ChannelInbox<WecomAtMessage, ChannelUnmatchedMessage, WecomTarget>`.
3. `WecomCounters` gains `inbox: MessageRouterCounts & { listener: 'idle' | 'ready' | 'reconnecting' | 'failed'; routes: number }`; the private counters field becomes `Omit<WecomCounters, 'inbox'>`.
4. Fields:

```ts
  private readonly router: MessageRouter<WecomAtMessage>
  private readonly unmatched: UnmatchedStore
  private readonly conversations: ConversationStore
  /** 收到的帧，按消息 ID 保存以便回复（24 小时窗口；只保留最近 1000 个）。 */
  private readonly frames = new Map<string, WecomFrame>()
  private listener: 'idle' | 'ready' | 'reconnecting' | 'failed' = 'idle'
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
```

5. Constructor, after the `defaultTarget` check: validate `groupRoutes` exactly as `FeishuService` does (same error messages with `'wecom'`), then:

```ts
    const baseUrl = (ctx as Context & { baseUrl?: string }).baseUrl
    const base = baseUrl ? join(dirname(fileURLToPath(new URL('./cordis.yml', baseUrl))), '.agent-kit') : undefined
    const key = unmatchedFileKey(config.botId)
    this.unmatched = new UnmatchedStore(base ? join(base, 'wecom-unmatched', `${key}.json`) : undefined, async () => undefined, (error) => this.logger.warn('wecom unmatched store unavailable', { error: redact(String(error)) }))
    this.conversations = new ConversationStore(base ? join(base, 'wecom-conversations', `${key}.json`) : undefined, (error) => this.logger.warn('wecom conversation store unavailable', { error: redact(String(error)) }))
    this.router = new MessageRouter<WecomAtMessage>({
      channel: 'wecom', logger: this.logger, onUnmatched: (m) => this.unmatched.add(m), pluginRoutes: groupRoutes,
      replyFor: (message) => (options) => safeReply('wecom', () => this.replyTo(message, options.markdown ?? options.text, options)),
    })
```

6. Replace `startConnection` handlers:

```ts
      {
        onAuthenticated: () => {
          this.authenticated = true
          this.listener = 'ready'
          this.clearFailed()
          this.router.setReady(true)
          const waiters = this.readyWaiters
          this.readyWaiters = []
          for (const w of waiters) w.resolve()
        },
        onDisconnected: (reason) => {
          this.authenticated = false
          this.router.setReady(false)
          if (this.listener !== 'failed') this.listener = 'reconnecting'
          this.logger.warn('wecom long connection disconnected', { reason: redact(reason) })
        },
        onReconnecting: () => {
          this.authenticated = false
          this.listener = 'reconnecting'
          this.router.setReady(false)
        },
        onError: (error) => this.fail(`wecom long connection failed: ${redact(error.message)}`, error),
        // SDK 被挤下线后不会自动重连
        onKicked: () => this.fail('另一个进程用同一个机器人建立了连接，本连接已被企业微信断开；一个机器人只能接一个 Profile'),
        onMessage: (raw) => {
          const parsed = parseWecomFrame(raw)
          if (!parsed) {
            this.router.drop()
            this.logger.warn('invalid wecom frame dropped')
            return
          }
          this.rememberFrame(parsed.message.eventId, parsed.frame)
          void this.conversations.record({ conversationId: parsed.message.conversationId, chatType: parsed.message.chatType, ...(parsed.message.senderId ? { lastSenderId: parsed.message.senderId } : {}) }).catch(() => {})
          this.router.accept(parsed.message)
        },
      },
```

and the effect:

```ts
    this.ctx.effect(() => () => {
      this.rejectWaiters(new Error('wecom service stopped'))
      connection.disconnect()
      this.router.reset()
      this.authenticated = false
      this.listener = 'idle'
    }, 'wecom.connection')
```

7. Helpers:

```ts
  private fail(detail: string, error?: unknown): void {
    this.authenticated = false
    this.listener = 'failed'
    this.router.setReady(false)
    this.markFailed(detail, error)
    this.rejectWaiters(new Error(detail))
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const w of waiters) w.reject(error)
  }

  private readyPromise(): Promise<void> {
    if (this.listener === 'ready') return Promise.resolve()
    const promise = this.listener === 'failed' || this.failure
      ? Promise.reject(new Error(this.failure ?? 'wecom long connection failed'))
      : new Promise<void>((resolve, reject) => { this.readyWaiters.push({ resolve, reject }) })
    promise.catch(() => {})
    return promise
  }

  private rememberFrame(messageId: string, frame: WecomFrame): void {
    this.frames.set(messageId, frame)
    if (this.frames.size > 1000) this.frames.delete(this.frames.keys().next().value!)
  }

  /** 基于收到的帧回复；不受「对方须先发过消息」限制。 */
  private async replyTo(message: WecomAtMessage, body: string | undefined, options: ChannelSendCommon & { at?: unknown }): Promise<WecomSendResult> {
    const content = buildContent({ title: options.title, ...(options.markdown !== undefined ? { markdown: options.markdown } : { text: body }), at: options.at as WecomAt | undefined })
    const frame = this.frames.get(message.eventId)
    if (!frame) return { results: [{ ok: false, error: new WecomSendError('api_error', 'the inbound frame for this message is no longer available') }] }
    if (this.config.dryRun) return { results: [{ ok: true }] }
    if (!this.connection || !this.authenticated) return { results: [{ ok: false, error: new WecomSendError('not_connected', 'wecom long connection is not ready') }] }
    if (options.signal?.aborted) return { results: [{ ok: false, error: new WecomSendError('aborted', 'wecom reply aborted') }] }
    try {
      await this.connection.replyStream(frame, `reply-${message.eventId}-${Date.now().toString(36)}`, content)
      this.recordSuccess()
      return { results: [{ ok: true, messageId: frame.headers.req_id }] }
    } catch (e) {
      const error = classifyThrown(e, true)
      this.recordFailure(error.code)
      return { results: [{ ok: false, error }] }
    }
  }
```

   Simplify the `buildContent` call if TypeScript complains about the conditional spread: pass `{ title: options.title, markdown: options.markdown, text: options.markdown === undefined ? options.text : undefined, at: options.at as WecomAt | undefined }`.

8. Override `hasInteracted` is no longer synchronous-friendly; change `sendOnce` to compute `const interacted = await this.conversations.has(target.conversationId)` inside the `catch` and pass it to `classifyThrown`, and delete the Task 2 `hasInteracted` stub.
9. Inbox methods (same shape as Feishu):

```ts
  onMessage(route: ChannelMessageRoute<WecomAtMessage>, handler: ChannelMessageHandler<WecomAtMessage>): ChannelMessageSubscription {
    return this.subscribe(this.router.register(route, handler), 'wecom.onMessage')
  }

  onPluginMessage(pluginId: string, handler: ChannelMessageHandler<WecomAtMessage>): ChannelMessageSubscription {
    return this.subscribe(this.router.registerPlugin(pluginId, handler), 'wecom.onPluginMessage')
  }

  private subscribe(dispose: () => void, label: string): ChannelMessageSubscription {
    if (this.config.dryRun) {
      dispose()
      throw new ConfigError('wecom', 'cannot listen for messages in dryRun mode', { field: 'dryRun' })
    }
    const subscription: ChannelMessageSubscription = { ready: this.readyPromise(), close: async () => dispose() }
    try {
      this.ctx.effect(() => () => dispose(), label)
    } catch (error) {
      dispose()
      throw error
    }
    return subscription
  }

  unmatchedMessages(): Promise<ChannelUnmatchedMessage[]> {
    return this.unmatched.list()
  }

  /** 只在本地「说过话的会话」中查找；企业微信没有群搜索接口。 */
  async searchRecipients(kind: ChannelRecipientKind, query: string): Promise<ChannelRecipientSearchResult<WecomTarget>> {
    if (kind !== 'group' && kind !== 'user') throw new TypeError('recipient kind must be group or user')
    const term = query?.trim()
    if (!term || term.length > 80) throw new TypeError('recipient search query must be 1–80 characters')
    const chatType = kind === 'group' ? 'group' : 'single'
    const candidates = (await this.conversations.list())
      .filter((c) => c.chatType === chatType && (c.conversationId.includes(term) || c.lastSenderId?.includes(term)))
      .map((c) => ({ name: c.conversationId, target: chatType === 'group' ? { chatId: c.conversationId } : { userId: c.conversationId } }))
    return { candidates, complete: true }
  }
```

10. `health()`:

```ts
  health(): ServiceHealth<WecomCounters> {
    const counters: WecomCounters = { ...this.counters, inbox: { listener: this.listener, routes: this.router.size, ...this.router.counters() } }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (!this.config.dryRun && this.listener === 'idle') return { status: 'degraded', detail: 'wecom long connection starting', counters }
    if (this.listener === 'reconnecting') return { status: 'degraded', detail: 'wecom long connection reconnecting', counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : `bot: ${this.config.botId}; @ inbox listening (${counters.inbox.routes} route(s))`, counters }
  }
```

11. Export `parseWecomFrame`, `type WecomAtMessage`, `ConversationStore`, `type WecomConversation` from `src/wecom/index.ts`.

- [ ] **Step 6: Record the kick behavior in the spec**

In `docs/superpowers/specs/2026-10-26-wecom-channel-design.md`, 「长连接生命周期」 table, change the `disconnected`、`reconnecting` row so it reads as before, and add a row:

```
| 被挤下线（`event.disconnected_event`） | 健康状态 `failed`，详情写明「另一个进程用同一机器人建立了连接」；SDK 1.0.7 此时不会自动重连（已读源码确认），需重载或停掉另一个进程 |
```

and remove the sentence 「断开原因表明被另一连接挤掉时，健康详情写明……」 from the bullet list below it (it is now covered by the row).

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/unit/wecom-inbox.test.ts tests/unit/wecom-send.test.ts`, then `npm run typecheck && npx vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/wecom tests/unit/wecom-inbox.test.ts docs/superpowers/specs/2026-10-26-wecom-channel-design.md
git commit -m "feat(wecom): receive @ and single-chat messages, reply via the inbound frame, remember talked-to conversations"
```

---

### Task 4: 接入 bundle、notify 与公开导出

**Files:**
- Modify: `src/common/channel.ts`（`CHANNEL_NAMES`）、`src/notify/service.ts`（`NotifyTargets`、`NotifyAts`）
- Modify: `package.json`（`exports`、`peerDependencies`、`peerDependenciesMeta`）、`patch.yml`、`src/index.ts`
- Modify: `tests/unit/channel-contract.test.ts`、`tests/unit/notify.test.ts`、`tests/integration/dsh-loader.test.ts`
- Test: `tests/unit/notify.test.ts`

**Interfaces:**
- Produces: `CHANNEL_NAMES = ['dingtalk', 'feishu', 'wecom']`；`NotifyTargets.wecom?: WecomTarget | 'default'`；`NotifyAts.wecom?: WecomAt`；loader 行 `agent-kit-wecom`；子路径 `@baoyx/dsh-agent-kit/wecom`。

- [ ] **Step 1: Write the failing notify test**

Add to `tests/unit/notify.test.ts` (imports: `WecomService` from `'../../src/wecom/service.js'`, `createFakeWecomSdk, useFakeWecomSdk` from `'../../src/testing/fake-wecom.js'`):

```ts
  it('sends to WeCom alongside DingTalk and reports it as a bot channel', async () => {
    process.env.WECOM_BOT_SECRET = 'secret-value'
    const fake = createFakeWecomSdk()
    const restore = useFakeWecomSdk(fake)
    try {
      await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
      await root.root.plugin(WecomService, { botId: 'bot1', defaultTarget: { chatId: 'wrkG' } })
      await root.root.plugin(NotifyService, { channel: 'dingtalk' })
      fake.authenticate()
      const notify = root.root.get('notify')!
      const r = await notify.send({ text: 'hello', targets: { dingtalk: 'default', wecom: 'default' } })
      expect(r.deliveries.map((d) => [d.channel, d.results[0]!.ok])).toEqual([['dingtalk', true], ['wecom', true]])
      expect(fake.sends.at(-1)!.chatid).toBe('wrkG')
      await expect(notify.login('wecom')).rejects.toMatchObject({ code: 'login_unsupported' })
      expect((await notify.status()).channels.wecom).toMatchObject({ running: true, identity: 'bot' })
    } finally {
      restore()
    }
  })
```

The existing test that uses `wecom` as the "unknown channel" (`rejects unknown channels`) must switch to another name, e.g. `targets: { email: { address: 'x' } } as never` — update it in this step.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/notify.test.ts`
Expected: FAIL with `invalid_channel`.

- [ ] **Step 3: Implement**

1. `src/common/channel.ts`: `CHANNEL_NAMES = ['dingtalk', 'feishu', 'wecom']`.
2. `src/notify/service.ts`: type-only imports `type WecomTarget` from `'../wecom/config.js'` and `type WecomAt` from `'../wecom/message.js'`; add `wecom?: WecomTarget | typeof DEFAULT_TARGET` to `NotifyTargets` and `wecom?: WecomAt` to `NotifyAts`.
3. `tests/unit/channel-contract.test.ts`: expect `['dingtalk', 'feishu', 'wecom']`.
4. `package.json`: `exports["./wecom"] = { "types": "./lib/wecom/index.d.ts", "default": "./lib/wecom/index.js" }` after `./feishu`; peer `"@wecom/aibot-node-sdk": "^1.0.7"` and `peerDependenciesMeta["@wecom/aibot-node-sdk"] = { "optional": true }`.
5. `patch.yml`: after `agent-kit-feishu`:
   ```yaml
       - id: agent-kit-wecom
         name: '@baoyx/dsh-agent-kit/wecom'
         disabled: true
   ```
6. `src/index.ts`: export `WecomService, WecomConfig, WecomSendError, WECOM_SECRET_REF, buildContent as buildWecomContent, parseWecomFrame, type WecomAt, type WecomAtMessage, type WecomCounters, type WecomErrorCode, type WecomSendOptions, type WecomSendResult, type WecomTarget` from `'./wecom/index.js'` (alias `buildContent` to avoid a generic root-level name).
7. `tests/integration/dsh-loader.test.ts`: add `'wecom'` to the "registers every service disabled by default" service list and `['agent-kit-wecom', '@baoyx/dsh-agent-kit/wecom', true]` after the Feishu row in the id list.
8. Run `npm install --package-lock-only` so the lockfile records the new optional peer.

- [ ] **Step 4: Run tests and build; check admin**

Run: `npm run typecheck && npm run build && npx vitest run && ls lib/wecom/index.js`, then `cd admin && npm run typecheck && npx vitest run`.
Expected: all pass. If admin breaks only because `CHANNEL_NAMES` gained `wecom` (e.g. exhaustive `Record<NotifyChannel, …>` in `setup.ts` or a notify select in setup tests), make the minimal fix here: in `admin/src/cli/setup.ts` `channelRows`, set `wecom: undefined` → keep, and script any new select prompt in setup tests to answer `dingtalk`; note every admin file touched.

- [ ] **Step 5: Commit**

```bash
git add src package.json package-lock.json patch.yml tests admin
git commit -m "feat(wecom): register the agent-kit-wecom row and route notify to WeCom"
```

---

## 阶段二：admin 与文档

### Task 5: admin 后端注册企业微信行、Secret 与按渠道接口

**Files:**
- Modify: `admin/vitest.config.ts:11`（别名加 `wecom`）
- Modify: `admin/src/profile/kit-entries.ts`、`admin/src/client/remote.ts`（`KitId`、`AdminChannel`）
- Modify: `admin/src/admin/service.ts`（Secret、`registeredRef`、`CHANNEL_SERVICES`、`CHANNEL_TITLES`）
- Modify: `admin/src/cli/messages.ts`（`KIT_TITLES`、`NOTIFY_CHANNEL_TITLES`）、`admin/src/checks/notify.ts`（`TITLES`）
- Modify: tests that list kit ids or build full `entries` (find with `grep -rn "'agent-kit-feishu'" admin/tests`)
- Test: `admin/tests/integration/admin.test.ts`

**Interfaces:**
- Consumes: `WecomConfig`、`WECOM_SECRET_REF`（`@baoyx/dsh-agent-kit/wecom`）
- Produces: `KitId` 含 `'agent-kit-wecom'`（位于 `'agent-kit-feishu'` 之后）；`AdminChannel = 'dingtalk' | 'feishu' | 'wecom'`；企业微信行 status 带 `secrets: [{ label: 'Secret', ref, configured, source? }]`。

- [ ] **Step 1: Write the failing tests**

In `admin/tests/integration/admin.test.ts`, next to the Feishu secret tests (`grep -n "App Secret" admin/tests/integration/admin.test.ts`), add:

```ts
  it('shows the WeCom Secret on its row, accepts it and a custom secretRef, and serves the wecom channel endpoints', async () => {
    const admin = await setup()
    const s = await admin.status()
    expect(s.services.find((x) => x.id === 'agent-kit-wecom')).toMatchObject({ title: '企业微信', secrets: [{ label: 'Secret', ref: 'WECOM_BOT_SECRET', configured: false }] })
    expect(await admin.setSecret('credentials', 'v', 'WECOM_BOT_SECRET')).toEqual({ configured: true, source: 'credentials' })
    const { version } = await admin.status()
    await admin.saveService('agent-kit-wecom', false, { botId: 'bot1', secretRef: 'MY_WECOM_SECRET' }, version)
    expect(await admin.setSecret('credentials', 'v', 'MY_WECOM_SECRET')).toEqual({ configured: true, source: 'credentials' })
    expect(await admin.channelUnmatched('wecom')).toEqual([])
    await expect(admin.channelSearchRecipients('wecom', 'group', 'ab')).rejects.toThrow(/WeCom service is not running/)
  })
```

Use the file's existing `setup()` helper; if the Feishu tests save config differently (look at the custom `appSecretRef` test), follow that pattern.

- [ ] **Step 2: Run to verify it fails**

Run: `cd admin && npx vitest run tests/integration/admin.test.ts`
Expected: FAIL — no `agent-kit-wecom` row.

- [ ] **Step 3: Implement**

1. `admin/vitest.config.ts`: alias group `(ws|dingtalk|feishu|wecom|notify|agent-tasks|jev|secrets|testing)`.
2. `admin/src/profile/kit-entries.ts`: import `WecomConfig` from `'@baoyx/dsh-agent-kit/wecom'`; `KitId` adds `'agent-kit-wecom'` after `'agent-kit-feishu'`; `KIT_ENTRIES` adds after the Feishu entry:
   ```ts
     { id: 'agent-kit-wecom', service: 'wecom', module: '@baoyx/dsh-agent-kit/wecom', title: '企业微信', validate: validator(WecomConfig as unknown as Schema) },
   ```
3. `admin/src/client/remote.ts`: `KitId` and `AdminChannel` add `'agent-kit-wecom'` / `'wecom'`.
4. `admin/src/admin/service.ts`:
   ```ts
   /** 企业微信行的 Secret 引用。 */
   function wecomSecretRef(config: Record<string, unknown> | undefined): string {
     return ((config ?? {}) as { secretRef?: string }).secretRef ?? WECOM_SECRET_REF
   }
   ```
   `CHANNEL_SERVICES = ['dingtalk', 'feishu', 'wecom'] as const`; `CHANNEL_TITLES` adds `wecom: 'WeCom'`; in `status()` add `wecomSecrets` next to `feishuSecrets` with label `'Secret'` and attach it to the `agent-kit-wecom` row; in `registeredRef` also accept `ref === wecomSecretRef(kit['agent-kit-wecom'].config)`. Import `WECOM_SECRET_REF` from `'@baoyx/dsh-agent-kit/wecom'`.
5. `admin/src/cli/messages.ts`: `KIT_TITLES['agent-kit-wecom'] = '企业微信智能机器人（收发消息）'`; `NOTIFY_CHANNEL_TITLES.wecom = '企业微信'`. `admin/src/checks/notify.ts`: `TITLES.wecom = '企业微信'`.
6. Update test helpers and id lists: add `'agent-kit-wecom': off` to every full `entries` object and `'agent-kit-wecom'` after `'agent-kit-feishu'` in every kit-id list; add `'wecom'` after `'feishu'` in `admin/tests/integration/dsh-loader.test.ts`'s service list.

- [ ] **Step 4: Run tests**

Run: `cd admin && npm run typecheck && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add admin
git commit -m "feat(admin): register the WeCom row, its Secret, and the wecom channel endpoints"
```

---

### Task 6: admin 前端：通用收件人选择组件与企业微信卡片

**Files:**
- Modify: `admin/src/client/forms.tsx`（`DingtalkTargetInput` 与 `FeishuTargetInput` 合并为 `ChannelTargetInput`；`WecomForm`；`wecom-target`）
- Modify: `admin/src/admin/entry.ts`、`admin/src/client/remote.ts`（`EntryFieldKind` 加 `'wecom-target'`）
- Modify: `admin/src/client/service-card.tsx`、`admin/src/client/settings-page.tsx`、`admin/src/client/locale.ts`
- Test: `admin/tests/unit/client-page.test.tsx`

**Interfaces:**
- Consumes: `AdminChannel` 含 `'wecom'`（Task 5）；`api.channelSearchRecipients`
- Produces:
  ```tsx
  interface TargetChannel { channel: AdminChannel; kinds: Array<{ kind: 'group' | 'user'; search: boolean; manualKey?: string; manualLabelKey?: string; hintKey?: string }>; minQuery: number; selectedKeys: string[] }
  function ChannelTargetInput(props: { spec: TargetChannel; id: string; value: unknown; onChange(v: unknown): void; disabled: boolean; api?: AdminApi; t: T }): JSX.Element
  const TARGET_SPECS: Record<'dingtalk-target' | 'feishu-target' | 'wecom-target', TargetChannel>
  // FORMS['agent-kit-wecom'] = WecomForm（botId 文本、wsUrl 文本）
  ```

- [ ] **Step 1: Write the failing tests**

Add to `admin/tests/unit/client-page.test.tsx`:

```tsx
  it('shows the WeCom card with its form, routes, unmatched panel and Secret', async () => {
    const s = status()
    s.services.splice(3, 0, { id: 'agent-kit-wecom', title: '企业微信', enabled: true, phase: 'active', health: { status: 'ok', detail: 'bot: bot1' }, config: { botId: 'bot1', groupRoutes: [] }, secrets: [{ label: 'Secret', ref: 'WECOM_BOT_SECRET', configured: false }] })
    const api = fakeApi(s)
    render(<SettingsPage api={api} t={t} />)
    const card = await screen.findByRole('region', { name: '企业微信' })
    expect(within(card).getByLabelText(zh['wecom.botId']!)).toHaveProperty('value', 'bot1')
    expect(within(card).getByLabelText(zh['wecom.wsUrl']!)).toBeTruthy()
    expect(within(card).getByRole('region', { name: zh['routes.title']! })).toBeTruthy()
    expect(within(card).getByText(/WECOM_BOT_SECRET/)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: zh['unmatched.refresh']! }))
    await waitFor(() => expect(api.channelUnmatched).toHaveBeenCalledWith('wecom'))
  })
```

and, next to the existing `feishu-target` field test (find it with `grep -n "feishu-target" admin/tests/unit/client-page.test.tsx`), a `wecom-target` test modeled on it: a registered entry with `fields: [{ path: 'forwardTo', label: '转发目标', kind: 'wecom-target' }]`; `api.channelSearchRecipients` returns `{ candidates: [{ name: 'wrkOps', target: { chatId: 'wrkOps' } }], complete: true }`; typing `w` (one character is allowed for WeCom) and clicking search calls `channelSearchRecipients('wecom', 'group', 'w')`; clicking the candidate stores `{ chatId: 'wrkOps' }`; switching kind to user and entering `zhangsan` manually stores `{ userId: 'zhangsan' }`. Keep the existing DingTalk and Feishu target tests unchanged — they are the regression guard for the shared component.

- [ ] **Step 2: Run to verify it fails**

Run: `cd admin && npx vitest run tests/unit/client-page.test.tsx`
Expected: FAIL — no `wecom.botId` key / no `wecom-target`.

- [ ] **Step 3: Generic target picker**

In `admin/src/client/forms.tsx`, replace `DingtalkTargetInput` and `FeishuTargetInput` with one component driven by a spec. Read both existing components first; the generic version must render the same elements, labels and behavior for DingTalk and Feishu (their tests must pass unchanged):

```tsx
interface TargetKindSpec {
  kind: 'group' | 'user'
  /** 是否可按关键词搜索；否则只能手动填写。 */
  search: boolean
  /** 手动填写时写入的字段名，如 `openId`、`userId`、`chatId`。 */
  manualKey?: string
  manualPlaceholderKey?: string
  hintKey?: string
}

interface TargetSpec {
  channel: AdminChannel
  kinds: TargetKindSpec[]
  /** 搜索关键词最短长度。 */
  minQuery: number
  /** 已选值可能出现的字段（按顺序取第一个），以及哪些字段算「群」。 */
  selectedKeys: string[]
  groupKeys: string[]
}

const TARGET_SPECS: Record<'dingtalk-target' | 'feishu-target' | 'wecom-target', TargetSpec> = {
  'dingtalk-target': { channel: 'dingtalk', kinds: [{ kind: 'group', search: true }, { kind: 'user', search: true }], minQuery: 2, selectedKeys: ['chatId', 'userId', 'openDingtalkId', 'chatIds'], groupKeys: ['chatId', 'chatIds'] },
  'feishu-target': { channel: 'feishu', kinds: [{ kind: 'group', search: true }, { kind: 'user', search: false, manualKey: 'openId', manualPlaceholderKey: 'recipient.openId', hintKey: 'recipient.feishuUserHint' }], minQuery: 2, selectedKeys: ['chatId', 'openId'], groupKeys: ['chatId'] },
  'wecom-target': { channel: 'wecom', kinds: [{ kind: 'group', search: true, manualKey: 'chatId', manualPlaceholderKey: 'recipient.wecomChatId' }, { kind: 'user', search: true, manualKey: 'userId', manualPlaceholderKey: 'recipient.wecomUserId' }], minQuery: 1, selectedKeys: ['chatId', 'userId'], groupKeys: ['chatId'] },
}
```

`ChannelTargetInput({ spec, id, value, onChange, disabled, api, t })`:
- kind selector as today (`recipient.kind`, `recipient.group`, `recipient.user`); initial kind = `user` when the current value has a non-group selected key, else `group`;
- if the active kind has `search`, show the query input (placeholder `recipient.groupQuery` / `recipient.userQuery`, or for WeCom `recipient.wecomQuery`) and the search button, enabled when `query.trim().length >= spec.minQuery`; call `api.channelSearchRecipients(spec.channel, kind, query.trim())`;
- if the active kind has `manualKey`, show a manual input (placeholder from `manualPlaceholderKey`) with a `recipient.select` button that sets `{ [manualKey]: value.trim() }`; for WeCom both search and manual are shown;
- `hintKey` renders as `<small>`;
- the selected / clear / candidates / incomplete / error blocks exactly as today, using `spec.selectedKeys` and `spec.groupKeys`.

`EntryInput` maps `case 'dingtalk-target': case 'feishu-target': case 'wecom-target': return <ChannelTargetInput spec={TARGET_SPECS[field.kind]} … />`.

Add `'wecom-target'` to `EntryFieldKind` in `admin/src/admin/entry.ts` (and its doc comment: `` `wecom-target` 是企业微信群（`{ chatId }`）或单聊用户（`{ userId }`），只能从说过话的会话中选或手动填写 ``) and to `EntryField.kind` in `admin/src/client/remote.ts`; if `assertEntry` validates kinds against a list, add it there too.

- [ ] **Step 4: WeCom form, card wiring and locale**

1. `forms.tsx`:
   ```tsx
   /** 企业微信智能机器人：BotID 与可选的私有部署长连接地址；Secret 走卡片下方的密钥面板。 */
   function WecomForm(p: FormProps) {
     return (
       <>
         {text(p, 'botId', p.t('wecom.botId'))}
         {text(p, 'wsUrl', p.t('wecom.wsUrl'))}
       </>
     )
   }
   ```
   and `FORMS['agent-kit-wecom'] = WecomForm`.
2. `service-card.tsx`: the `ChannelRoutesPanel` condition includes `agent-kit-wecom` with `channel="wecom"` (map id → channel with a small `{ 'agent-kit-dingtalk': 'dingtalk', 'agent-kit-feishu': 'feishu', 'agent-kit-wecom': 'wecom' }` record instead of nested ternaries).
3. `settings-page.tsx`: add `{s.id === 'agent-kit-wecom' && s.enabled && status.writable && <ChannelUnmatchedPanel channel="wecom" api={api} t={t} />}`.
4. `locale.ts` (zh / en, keep key parity): `wecom.botId`: `'BotID'` / `'BotID'`; `wecom.wsUrl`: `'长连接地址（私有部署才需要）'` / `'Long-connection URL (private deployment only)'`; `recipient.wecomQuery`: `'会话 ID 或最近发言人'` / `'Conversation ID or last sender'`; `recipient.wecomChatId`: `'群 chatid'` / `'Group chatid'`; `recipient.wecomUserId`: `'成员 userid'` / `'Member userid'`; `service.agent-kit-wecom`: `'企业微信'` / `'WeCom'`.

- [ ] **Step 5: Run tests and build**

Run: `cd admin && npm run typecheck && npx vitest run && npm run build`
Expected: all pass, including the unchanged DingTalk / Feishu target tests, the locale parity test and `client-build.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add admin
git commit -m "feat(admin): shared channel target picker, WeCom card and wecom-target fields"
```

---

### Task 7: doctor 与 setup 支持企业微信

**Files:**
- Create: `admin/src/wecom-probe.ts`、`admin/src/checks/wecom.ts`
- Modify: `admin/src/checks/run.ts`、`admin/src/cli/setup.ts`、`admin/src/cli/messages.ts`
- Test: `admin/tests/unit/checks.test.ts`、`admin/tests/unit/cli-setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // admin/src/wecom-probe.ts
  export interface WecomProbeResult { ok: boolean; detail: string }
  export type WecomProbe = (input: { botId: string; secret: string; wsUrl?: string; timeoutMs?: number }) => Promise<WecomProbeResult>
  export const probeWecom: WecomProbe   // 动态加载 SDK，连接，等 authenticated / error（默认 10 秒），随即 disconnect
  // SetupDeps 新增 wecomProbe?: WecomProbe
  ```

- [ ] **Step 1: Write the failing tests**

In `admin/tests/unit/checks.test.ts`:

```ts
describe('wecom checks', () => {
  const wecom = (config: Record<string, unknown>) => snapshot({ 'agent-kit-wecom': { enabled: true, config } })

  it('reports SDK, botId and secret source, and explains why there is no online check', async () => {
    const report = await runChecks(ctx({ snapshot: wecom({ botId: 'bot1' }), resolveModule: (name) => name === '@wecom/aibot-node-sdk', env: { WECOM_BOT_SECRET: 's' } }))
    expect(byId(report, 'agent-kit-wecom.sdk')).toMatchObject({ status: 'pass' })
    expect(byId(report, 'agent-kit-wecom.botId')).toMatchObject({ status: 'pass' })
    expect(byId(report, 'agent-kit-wecom.secret')).toMatchObject({ status: 'pass', detail: expect.stringContaining('环境变量') })
    expect(byId(report, 'agent-kit-wecom.connection')).toMatchObject({ status: 'skip', detail: expect.stringContaining('设置页') })
  })

  it('fails with install and configuration fixes', async () => {
    const report = await runChecks(ctx({ snapshot: wecom({}), resolveModule: () => false, env: {} }))
    expect(byId(report, 'agent-kit-wecom.sdk')).toMatchObject({ status: 'fail', fix: expect.stringContaining('add @wecom/aibot-node-sdk') })
    expect(byId(report, 'agent-kit-wecom.botId')).toMatchObject({ status: 'fail' })
    expect(byId(report, 'agent-kit-wecom.secret')).toMatchObject({ status: 'fail' })
  })
})
```

(Use the same helpers and `keyStore` handling as the existing Feishu checks tests.)

In `admin/tests/unit/cli-setup.test.ts`, add a test following the Feishu setup test: select `agent-kit-wecom` and `agent-kit-notify`; answer BotID `bot1`, Secret `s3cret`; confirm the connection test after its warning; default notify channel `wecom`; `deps.wecomProbe` returns `{ ok: true, detail: '认证成功' }` and records that it was called with `{ botId: 'bot1', secret: 's3cret' }`; `deps.keyStore` points at a temp credentials file. Assert the written `cordis.patch.yml` enables `agent-kit-wecom` with `botId: bot1` and `agent-kit-notify` with `channel: wecom`, that `resolveSecretRef('WECOM_BOT_SECRET', keyStore)` returns `s3cret`, and that the output contains the probe detail. Add a second test where the user declines the connection test and assert `wecomProbe` was not called.

- [ ] **Step 2: Run to verify it fails**

Run: `cd admin && npx vitest run tests/unit/checks.test.ts tests/unit/cli-setup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Probe**

Create `admin/src/wecom-probe.ts`:

```ts
/** 企业微信连接测试：建立一次长连接，认证成功或失败后立即断开。会把同一机器人的其他连接挤下线，调用方必须先征得确认。 */
export interface WecomProbeResult {
  ok: boolean
  detail: string
}

export type WecomProbe = (input: { botId: string; secret: string; wsUrl?: string; timeoutMs?: number }) => Promise<WecomProbeResult>

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

export const probeWecom: WecomProbe = async ({ botId, secret, wsUrl, timeoutMs = 10_000 }) => {
  let sdk: typeof import('@wecom/aibot-node-sdk')
  try {
    sdk = await import('@wecom/aibot-node-sdk')
  } catch {
    return { ok: false, detail: '未安装 @wecom/aibot-node-sdk' }
  }
  const client = new sdk.WSClient({ botId, secret, ...(wsUrl ? { wsUrl } : {}), maxReconnectAttempts: 0, maxAuthFailureAttempts: 0, logger: quiet })
  try {
    return await new Promise<WecomProbeResult>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, detail: `${timeoutMs / 1000} 秒内没有完成认证` }), timeoutMs)
      client.on('authenticated', () => { clearTimeout(timer); resolve({ ok: true, detail: '认证成功' }) })
      client.on('error', (e: Error) => { clearTimeout(timer); resolve({ ok: false, detail: `认证失败：${e.message}` }) })
      client.connect()
    })
  } finally {
    client.disconnect()
  }
}
```

Admin must be able to import `@wecom/aibot-node-sdk` types: add it to admin's `devDependencies` only if `cd admin && npm run typecheck` cannot resolve it through the root `node_modules` (it normally can, as for the Feishu SDK); check `maxReconnectAttempts: 0` / `maxAuthFailureAttempts: 0` mean "no retries" in the SDK source (`grep -n "maxReconnectAttempts\|maxAuthFailureAttempts" node_modules/@wecom/aibot-node-sdk/dist/index.esm.js`), otherwise use the smallest values that stop retrying.

- [ ] **Step 4: doctor**

Create `admin/src/checks/wecom.ts`:

```ts
import { WECOM_SECRET_REF } from '@baoyx/dsh-agent-kit/wecom'
import { describeSecretRef } from '@baoyx/dsh-agent-kit/secrets'
import type { Check, CheckResult } from './types.js'

type WecomCheckConfig = { botId?: string; secretRef?: string }

const SOURCE: Record<string, string> = { env: '环境变量', credentials: 'dsh 凭据文件' }

/** 不做在线凭据检查：同一机器人只能有一条长连接，doctor 建连会把运行中的 Agent 挤下线。 */
export const wecomChecks: Check = async (ctx) => {
  const scope = 'agent-kit-wecom' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as WecomCheckConfig
  const ref = config.secretRef ?? WECOM_SECRET_REF
  const sdk = ctx.resolveModule('@wecom/aibot-node-sdk')
  const secret = await describeSecretRef(ref, { ...ctx.keyStore, env: ctx.env })
  const results: CheckResult[] = [
    { id: `${scope}.sdk`, scope, title: '@wecom/aibot-node-sdk 已安装', status: sdk ? 'pass' : 'fail', detail: sdk ? '已安装' : '未安装', ...(sdk ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @wecom/aibot-node-sdk` }) },
    { id: `${scope}.botId`, scope, title: '企业微信 BotID', status: config.botId ? 'pass' : 'fail', detail: config.botId ?? '未填写', ...(config.botId ? {} : { fix: '在设置页或 setup 中填写 BotID' }) },
    { id: `${scope}.secret`, scope, title: `企业微信 Secret（${ref}）`, status: secret.configured ? 'pass' : 'fail', detail: secret.configured ? `已配置（来源：${SOURCE[secret.source!] ?? secret.source}）` : '未配置', ...(secret.configured ? {} : { fix: `在设置页保存 Secret，或设置环境变量 ${ref}` }) },
    { id: `${scope}.connection`, scope, title: '企业微信长连接', status: 'skip', detail: '不在线检查：同一机器人只能有一条长连接，检查会把运行中的 Agent 挤下线。请在设置页查看连接状态，或用 setup 的连接测试' },
  ]
  return results
}
```

Register `'agent-kit-wecom': wecomChecks` in `SERVICE_CHECKS` (`admin/src/checks/run.ts`).

- [ ] **Step 5: setup**

1. `SetupDeps` adds `wecomProbe?: WecomProbe`.
2. Messages (`admin/src/cli/messages.ts`, new `// ---- wecom ----` section):
   ```ts
   export const WECOM_BOT_ID_MESSAGE = '企业微信智能机器人 BotID（管理后台 → 智能机器人 → API 模式）'
   export const WECOM_SECRET_MESSAGE = '企业微信机器人 Secret（只写入 dsh 凭据文件）'
   export function wecomSecretFoundMessage(ref: string, source: string): string {
     return `已找到 ${ref}（来源：${source}），继续使用？`
   }
   export const WECOM_PROBE_CONFIRM = '现在测试连接？如果使用该机器人的 Agent 正在运行，测试会让它短暂断开（企业微信只允许一条长连接）'
   export const WECOM_SDK_MISSING = (profile: string) => `未安装 @wecom/aibot-node-sdk，启用企业微信前请运行：dsh plugin --profile ${profile} add @wecom/aibot-node-sdk\n`
   export const WECOM_SETUP_HINT = '请确认企业微信管理后台已为机器人开启 API 模式并选择长连接。主动发消息前，需要先有人在该会话里给机器人发过消息。\n'
   ```
3. `configureWecom(p, current, keyStore, io, deps, ctx, profileName)`: SDK hint if missing; `botId` input; Secret reuse-or-enter as `configureFeishu` does (ref from `current.secretRef` or `WECOM_SECRET_REF`); `if (await p.confirm(msg.WECOM_PROBE_CONFIRM, false))` then call `(deps.wecomProbe ?? probeWecom)({ botId, secret, wsUrl: current.wsUrl })` and print `r.detail`; print `WECOM_SETUP_HINT`; return `{ ...current, botId }`.
4. `runSetup`: `ids` adds `'agent-kit-wecom'` after `'agent-kit-feishu'`; `channelRows.wecom = 'agent-kit-wecom'`; dispatch `: id === 'agent-kit-wecom' ? await configureWecom(p, current, keyStore, io, deps, ctx, profile.name)`.

- [ ] **Step 6: Run tests**

Run: `cd admin && npm run typecheck && npx vitest run`
Expected: all pass. Existing setup tests that pick the default notify channel by position may need their scripted answer kept explicit (`dingtalk`); do not change what they assert.

- [ ] **Step 7: Commit**

```bash
git add admin
git commit -m "feat(admin): WeCom doctor checks and setup with an opt-in connection test"
```

---

### Task 8: 文档与官网

**Files:**
- Modify: `README.md`、`admin/README.md`
- Create: `website/src/pages/docs/wecom.mdx`
- Modify: `website/src/data/services.ts`、`website/src/data/config-tables.ts`、`website/src/data/changelog.ts`、`website/src/pages/docs/notify.mdx`、`website/src/pages/compatibility.astro`
- Modify: `website/tests/config-tables.test.ts`

- [ ] **Step 1: Failing website test**

In `website/tests/config-tables.test.ts`: import `WecomConfig` from `'../../src/wecom/config'`, add `['wecom', WecomConfig]` to `it.each`, append `['柒', 'wecom']` to the numerals list, and add `wecom: 'src/wecom/errors.ts'` to the error-code sources.

Run: `cd website && npx vitest run` — Expected: FAIL.

- [ ] **Step 2: Website**

1. `website/src/data/services.ts`: add `'wecom'` to `ServiceId` and an entry modeled on the `feishu` entry: `numeral: '柒'`, `verb: '收发'`, `name: '企业微信'`, `context: 'ctx.wecom'`, `slug: 'wecom'`, `kitId: 'agent-kit-wecom'`; summary `'企业微信智能机器人：以 Markdown 发送消息，长连接接收群内 @ 机器人与单聊消息，按会话分发；可直接回复收到的消息。'`; notes covering: optional `@wecom/aibot-node-sdk ^1.0.7`; `secretRef`（默认 `WECOM_BOT_SECRET`）; 主动发送前需对方先给机器人发过消息，每会话每分钟 30 条、每小时 1000 条; 一个机器人只能有一条长连接，被挤下线后不会自动重连; `idempotencyKey` 只在本进程内去重、不自动重试; `doctor` 不在线检查. `errors`: one row per `WecomErrorCode` with retryability from the Global Constraints, plus `INVALID_CONFIG`.
2. `website/src/data/config-tables.ts`: `wecom: WecomConfig as unknown as SchemaNode`.
3. `website/src/pages/docs/wecom.mdx`: follow `feishu.mdx`'s structure — 接口（`send` 示例、`onMessage` 带 `reply` 示例、`onPluginMessage`、`searchRecipients`）、消息字段表（spec 中的 `WecomAtMessage` 表）、主动发送的前提与频率限制、部署（一个机器人一个 Profile、被挤下线后需要重载）、`<Notice>` 说明 userid 可能是加密 ID。
4. `website/src/pages/docs/notify.mdx`: add `wecom` to the multi-channel example (`targets: { dingtalk: 'default', wecom: { chatId: 'wrk…' } }`) and mention `not_interacted`.
5. `website/src/pages/compatibility.astro`: add `'@wecom/aibot-node-sdk': '企业微信'` to `OPTIONAL_FOR`.
6. `website/src/data/changelog.ts`, 0.3.0 items, add:
   - `'新增 ctx.wecom：企业微信智能机器人（长连接），进程内使用 @wecom/aibot-node-sdk（可选依赖）；以 Markdown 发送，接收群内 @ 机器人与单聊消息并按会话分发，记录与机器人说过话的会话作为主动发送目标。'`
   - `'消息处理函数的第二个参数新增 reply()：钉钉、飞书发回原会话，企业微信基于收到的消息回复。'`
   - `'admin：设置页新增企业微信卡片，收件人选择组件改为三个渠道共用；doctor 检查 SDK、BotID 与 Secret（不在线检查，避免挤掉运行中的连接），setup 提供需确认的连接测试。'`

Run: `cd website && npm run build && npx vitest run` — Expected: PASS.

- [ ] **Step 3: README**

In `README.md`:
1. 功能表加 `ctx.wecom` 一行（同 summary）；Service 数量从六个改为七个，导入子路径加 `/wecom`；loader 行列表加 `agent-kit-wecom`。
2. 环境要求加：`- 使用 ctx.wecom：安装 @wecom/aibot-node-sdk（^1.0.7）；在企业微信管理后台为智能机器人开启 API 模式并选择长连接；Secret 用 secretRef 引用（默认 WECOM_BOT_SECRET）。主动发送前需对方先给机器人发过消息。`
3. 「渠道约定」：处理函数签名改为 `(message, { signal, reply })`，说明三个渠道的回复方式（钉钉单聊规则、飞书 chat_id、企业微信基于收到的帧）。
4. 新增「企业微信」一节：配置示例、`onMessage` + `reply` 示例、消息字段、说过话的会话与 `not_interacted`、`idempotencyKey` 只在本进程去重、一个机器人一个 Profile 且被挤下线后需重载、userid 可能是加密 ID。
5. 配置表加 `wecom` 行。

`admin/README.md`：功能列表加企业微信卡片、doctor（不在线检查的原因）与 setup 的连接测试。

Leftover check: `grep -n "六个 Service\|六个 loader" README.md admin/README.md website/src -r` prints nothing.

- [ ] **Step 4: Run everything**

```bash
npm run typecheck && npx vitest run && npm run build
cd admin && npm run typecheck && npx vitest run && npm run build
cd ../website && npm run build && npx vitest run
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md admin/README.md website
git commit -m "docs: WeCom channel and context.reply()"
```

---

## Self-Review Notes

- Spec coverage: §1 回复入口 → Task 1；§2 接入、配置、发送、错误码 → Task 2 / 4；接收、会话记录、生命周期、状态、搜索 → Task 3；§3 admin 注册与接口 → Task 5，卡片与通用选择组件 → Task 6，doctor / setup → Task 7；§4 错误处理 → Task 1–3；测试 → 各任务；交付与文档 → Task 8。
- Spec revision made explicit: being kicked by another connection is terminal in SDK 1.0.7 → `failed`（Task 3 Step 6）。
- Ambiguity resolved: errcode 846607 is classified with the local conversation record — known conversation → `rate_limited`, unknown → `not_interacted`。
- Names used across tasks: `ChannelMessageContext`、`ChannelReplyOptions`、`ReplyFactory`、`safeReply`、`replyUnsupported`、`WecomSdk`、`WecomConnection`、`WecomFrame`、`WecomHandlers`、`WecomService.sdkLoader`、`WecomService.keyStore`、`createFakeWecomSdk`、`useFakeWecomSdk`、`WecomTarget`、`WecomAt`、`WecomAtMessage`、`parseWecomFrame`、`ConversationStore`、`MAX_CONVERSATIONS`、`buildContent`、`resolveTarget`、`MAX_CONTENT_BYTES`、`WecomSendError`、`classifyErrcode`、`classifyThrown`、`WECOM_SECRET_REF`、`TARGET_SPECS`、`ChannelTargetInput`、`probeWecom`、`WecomProbe`。
