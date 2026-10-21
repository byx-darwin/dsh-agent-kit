# 渠道公共约定与 notify 多渠道改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定义所有渠道共用的发送与接收约定，把钉钉收件中与渠道无关的路由逻辑抽成 `MessageRouter`，并让 `ctx.notify` 支持按调用指定渠道、未指定时发往默认渠道。

**Architecture:** 在 `src/common/channel.ts` 中加入 `ChannelService`、`ChannelAtMessage` 与路由泛型类型；新增 `src/common/inbox.ts` 的 `MessageRouter`（去重、有界队列、优先级路由、插件路由、handler 超时）。`DingtalkInbox` 只保留 `dws` 子进程生命周期，把解析出的消息交给 `MessageRouter`。`notify` 用新的 `deliver()` 并行投递到各渠道，单个渠道的失败只体现在该渠道的结果中。

**Tech Stack:** TypeScript（NodeNext、strict）、cordis 4、schemastery、vitest。

**Spec:** `docs/superpowers/specs/2026-10-21-channel-contract-notify-design.md`

## Global Constraints

- 钉钉现有字段与方法只增不改；`DingtalkAtMessage` 只新增 `senderId`。
- `tests/unit/dingtalk-inbox.test.ts` 与 `tests/unit/dingtalk.test.ts` 不得修改，必须全部通过。
- `CHANNEL_NAMES` 本轮仍为 `['dingtalk']`；`ChannelName` 类型为 `'dingtalk' | 'feishu' | 'wecom'`。
- notify 配置字段名保持 `channel`（含义为默认渠道）。
- `NotifyErrorCode` 为 `'channel_unavailable' | 'invalid_channel' | 'login_unsupported' | 'send_failed'`。`send_failed` 用于渠道 `send()` 抛出非 `KitError` 异常时的包装（规格补充，见 Task 3）。
- `notify.send()` 只在两种情况下直接抛错：未指定渠道且默认渠道未运行（`channel_unavailable`）；`targets` 中出现未知渠道名（`invalid_channel`）。其余失败都进入 `deliveries[i].results[j].error`。
- `MessageRouter` 上限：去重 2048 条、队列 256 条、handler 超时 30 000 ms，与现有钉钉实现一致。
- 根包与 admin 包版本升到 `0.3.0`；admin 的 peer 依赖 `@baoyx/dsh-agent-kit` 改为 `^0.3.0`。
- 注释与文档用中文，与现有代码一致。
- 每个任务结束时运行：根目录 `npm run typecheck && npx vitest run`；涉及 admin 时再运行 `cd admin && npm run typecheck && npx vitest run`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/common/channel.ts` | 修改 | 渠道名、`ChannelStatus`、`LoginSession`（已有），新增 `ChannelService`、`ChannelSendCommon`、`ChannelSendResult`、`ChannelAtMessage`、`ChannelMessageRoute`、`ChannelMessageHandler`、`ChannelMessageSubscription` |
| `src/common/inbox.ts` | 新建 | `MessageRouter`：与渠道无关的路由、去重、队列、超时 |
| `src/dingtalk/inbox.ts` | 修改 | 只保留 dws 子进程生命周期与 NDJSON 解析，路由交给 `MessageRouter`；类型改为公共泛型的别名；`parseAtMessage` 增加 `senderId` |
| `src/dingtalk/service.ts` | 修改 | 声明 `implements ChannelService<DingtalkTarget, DingtalkAt>` |
| `src/notify/errors.ts` | 新建 | `NotifyError`、`NotifyErrorCode`（从 service.ts 移出，避免与 deliver.ts 循环引用） |
| `src/notify/deliver.ts` | 新建 | `deliver()` 并行投递与失败隔离、`channelUnavailable()`、`requireLogin()` / `requireLogout()` |
| `src/notify/config.ts` | 修改 | `channel` 取值改为 `CHANNEL_NAMES` 之一 |
| `src/notify/service.ts` | 修改 | 新的 `send()`、`status()`、`login()`、`logout()`、`health()`；删除 `use()` |
| `src/notify/index.ts`、`src/index.ts` | 修改 | 导出新类型 |
| `tests/unit/channel-contract.test.ts` | 新建 | 类型约定与 `senderId` |
| `tests/unit/message-router.test.ts` | 新建 | `MessageRouter` 行为 |
| `tests/unit/notify-deliver.test.ts` | 新建 | `deliver()`、`requireLogin()` |
| `tests/unit/notify.test.ts` | 重写 | `NotifyService` 端到端（假 dws） |
| `admin/src/checks/notify.ts`、`admin/src/cli/setup.ts`、`admin/src/cli/messages.ts` | 修改 | 默认渠道文案与选择 |
| `admin/tests/unit/checks.test.ts` | 修改 | 新标题 |
| `README.md`、`website/src/pages/docs/notify.mdx`、`website/src/data/services.ts`、`website/src/data/changelog.ts` | 修改 | 文档与 0.3.0 迁移说明 |
| `package.json`、`admin/package.json`、`package-lock.json` | 修改 | 版本 0.3.0 |

---

### Task 1: 渠道公共约定类型与钉钉 `senderId`

**Files:**
- Modify: `src/common/channel.ts`
- Modify: `src/dingtalk/inbox.ts:7-33`（类型定义）、`src/dingtalk/inbox.ts:55-77`（`parseAtMessage`）
- Modify: `src/dingtalk/service.ts:76`（类声明）
- Modify: `src/index.ts`
- Test: `tests/unit/channel-contract.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（`src/common/channel.ts`）:
  ```ts
  export type ChannelName = 'dingtalk' | 'feishu' | 'wecom'
  export const CHANNEL_NAMES: readonly ChannelName[] // = ['dingtalk']
  export interface ChannelSendCommon { title?: string; markdown?: string; text?: string; idempotencyKey?: string; traceId?: string; signal?: AbortSignal }
  export interface ChannelSendResult { results: Array<{ ok: boolean; messageId?: string; error?: KitError }> }
  export interface ChannelService<Target = unknown, At = unknown> {
    send(options: ChannelSendCommon & { target?: Target; at?: At }): Promise<ChannelSendResult>
    status(): Promise<ChannelStatus>
    health(): { status: HealthStatus; detail: string }
    login?(options?: { signal?: AbortSignal }): Promise<LoginSession>
    logout?(): Promise<ChannelStatus>
  }
  export interface ChannelAtMessage { eventId: string; messageId?: string; conversationId: string; senderId?: string; content: string; timestamp?: number }
  export interface ChannelMessageRoute<M extends ChannelAtMessage = ChannelAtMessage> { conversationId: string; match?: (message: M) => boolean; priority?: number }
  export type ChannelMessageHandler<M extends ChannelAtMessage = ChannelAtMessage> = (message: M, context: { signal: AbortSignal }) => void | Promise<void>
  export interface ChannelMessageSubscription { ready: Promise<void>; close(): Promise<void> }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/channel-contract.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest'
import { CHANNEL_NAMES, type ChannelAtMessage, type ChannelMessageRoute, type ChannelService } from '../../src/common/channel.js'
import { parseAtMessage, type DingtalkAtMessage, type DingtalkMessageRoute } from '../../src/dingtalk/inbox.js'
import type { DingtalkService } from '../../src/dingtalk/service.js'
import type { DingtalkAt, DingtalkTarget } from '../../src/dingtalk/args.js'

describe('channel contract', () => {
  it('lists only implemented channels', () => {
    expect(CHANNEL_NAMES).toEqual(['dingtalk'])
  })

  it('DingtalkService satisfies ChannelService and its message types extend the shared ones', () => {
    expectTypeOf<DingtalkService>().toMatchTypeOf<ChannelService<DingtalkTarget, DingtalkAt>>()
    expectTypeOf<DingtalkAtMessage>().toMatchTypeOf<ChannelAtMessage>()
    expectTypeOf<DingtalkMessageRoute>().toEqualTypeOf<ChannelMessageRoute<DingtalkAtMessage>>()
  })

  it('maps the DingTalk sender to the shared senderId without dropping the original field', () => {
    const line = JSON.stringify({ type: 'user_im_message_receive_at', event_id: 'e1', conversation_id: 'cidA', sender_open_dingtalk_id: 'sender-1', content: 'hi' })
    expect(parseAtMessage(line)).toMatchObject({ senderOpenDingtalkId: 'sender-1', senderId: 'sender-1' })
    const anonymous = JSON.stringify({ type: 'user_im_message_receive_at', event_id: 'e2', conversation_id: 'cidA', content: 'hi' })
    expect(parseAtMessage(anonymous)).not.toHaveProperty('senderId')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/channel-contract.test.ts && npm run typecheck`
Expected: vitest FAIL on `senderId` (`toMatchObject` mismatch); typecheck FAIL with `Module '"../../src/common/channel.js"' has no exported member 'ChannelService'`.

- [ ] **Step 3: Add the contract types**

In `src/common/channel.ts`, replace the first three lines:

```ts
/** 通知渠道：钉钉（dws）。 */
export type ChannelName = 'dingtalk'
export const CHANNEL_NAMES: readonly ChannelName[] = ['dingtalk']
```

with:

```ts
import type { KitError } from './errors.js'
import type { HealthStatus } from './service.js'

/** 渠道名称；类型为后续渠道预留，`CHANNEL_NAMES` 只列出已实现的渠道。 */
export type ChannelName = 'dingtalk' | 'feishu' | 'wecom'
export const CHANNEL_NAMES: readonly ChannelName[] = ['dingtalk']

/** 各渠道 `send()` 共有的参数；目标与 @ 由各渠道自己定义。 */
export interface ChannelSendCommon {
  title?: string
  /** Markdown 正文，与 `text` 二选一。 */
  markdown?: string
  text?: string
  idempotencyKey?: string
  traceId?: string
  signal?: AbortSignal
}

/** 逐目标的发送结果。 */
export interface ChannelSendResult {
  results: Array<{ ok: boolean; messageId?: string; error?: KitError }>
}

/**
 * 每个渠道 Service 都实现的约定，`notify` 只通过它转发。
 * `login` / `logout` 可选：只有需要登录的身份（如钉钉 user）才实现，机器人渠道不实现。
 */
export interface ChannelService<Target = unknown, At = unknown> {
  send(options: ChannelSendCommon & { target?: Target; at?: At }): Promise<ChannelSendResult>
  status(): Promise<ChannelStatus>
  health(): { status: HealthStatus; detail: string }
  login?(options?: { signal?: AbortSignal }): Promise<LoginSession>
  logout?(): Promise<ChannelStatus>
}

/** 各渠道群内 @ 消息的公共字段。正文是外部输入，业务插件必须自行校验。 */
export interface ChannelAtMessage {
  /** 去重键。 */
  eventId: string
  messageId?: string
  /** 会话 ID；不要用群名作持久路由键。 */
  conversationId: string
  senderId?: string
  content: string
  timestamp?: number
}

export interface ChannelMessageRoute<M extends ChannelAtMessage = ChannelAtMessage> {
  conversationId: string
  /** 同会话细分规则；省略表示匹配会话内所有 @ 消息。 */
  match?: (message: M) => boolean
  /** 数值大的规则优先；同优先级按注册顺序。默认 0。 */
  priority?: number
}

export type ChannelMessageHandler<M extends ChannelAtMessage = ChannelAtMessage> = (message: M, context: { signal: AbortSignal }) => void | Promise<void>

export interface ChannelMessageSubscription {
  /** 监听就绪后完成；监听启动失败时拒绝。 */
  ready: Promise<void>
  /** 手动注销；调用方插件卸载时也会自动注销。 */
  close(): Promise<void>
}
```

Check `src/common/service.ts` does not import `channel.ts` (to avoid a cycle): `grep -n "channel" src/common/service.ts` should print nothing.

- [ ] **Step 4: Make the DingTalk types aliases and add `senderId`**

In `src/dingtalk/inbox.ts`, replace lines 7–33 (from `/** 来自当前 dws user 的群内 @ 消息` through the end of `interface DingtalkMessageSubscription`) with:

```ts
/** 来自当前 dws user 的群内 @ 消息。正文是外部输入，业务插件必须自行校验。 */
export interface DingtalkAtMessage extends ChannelAtMessage {
  senderOpenDingtalkId?: string
}

export type DingtalkMessageRoute = ChannelMessageRoute<DingtalkAtMessage>
export type DingtalkMessageHandler = ChannelMessageHandler<DingtalkAtMessage>
export type DingtalkMessageSubscription = ChannelMessageSubscription
```

and add to the imports at the top of the file:

```ts
import type { ChannelAtMessage, ChannelMessageHandler, ChannelMessageRoute, ChannelMessageSubscription } from '../common/channel.js'
```

In `parseAtMessage`, replace the `senderOpenDingtalkId` spread line:

```ts
    ...(typeof data.sender_open_dingtalk_id === 'string' && data.sender_open_dingtalk_id ? { senderOpenDingtalkId: data.sender_open_dingtalk_id } : {}),
```

with:

```ts
    ...(typeof data.sender_open_dingtalk_id === 'string' && data.sender_open_dingtalk_id
      ? { senderOpenDingtalkId: data.sender_open_dingtalk_id, senderId: data.sender_open_dingtalk_id }
      : {}),
```

- [ ] **Step 5: Declare the contract on `DingtalkService`**

In `src/dingtalk/service.ts` line 76, change:

```ts
export class DingtalkService extends KitService<DingtalkCounters> {
```

to:

```ts
export class DingtalkService extends KitService<DingtalkCounters> implements ChannelService<DingtalkTarget, DingtalkAt> {
```

and add `ChannelService` to the existing import from `'../common/channel.js'` (the file already imports `ChannelStatus` / `LoginSession` from there; check with `grep -n "common/channel" src/dingtalk/service.ts`), and make sure `DingtalkAt` and `DingtalkTarget` are imported from `'./args.js'` (add `type DingtalkAt, type DingtalkTarget` to that import if missing).

- [ ] **Step 6: Export the new types from the root entry**

In `src/index.ts`, add after the `export type { HealthStatus, ... } from './common/service.js'` line:

```ts
export type {
  ChannelAtMessage,
  ChannelMessageHandler,
  ChannelMessageRoute,
  ChannelMessageSubscription,
  ChannelSendCommon,
  ChannelSendResult,
  ChannelService,
} from './common/channel.js'
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck passes; all tests pass, including the unchanged `tests/unit/dingtalk-inbox.test.ts` and the new `tests/unit/channel-contract.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/common/channel.ts src/dingtalk/inbox.ts src/dingtalk/service.ts src/index.ts tests/unit/channel-contract.test.ts
git commit -m "feat(channel): shared channel contract types and DingTalk senderId"
```

---

### Task 2: 抽出 `MessageRouter`

**Files:**
- Create: `src/common/inbox.ts`
- Modify: `src/dingtalk/inbox.ts`（`DingtalkInbox` 类与常量）
- Test: `tests/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `ChannelAtMessage`、`ChannelMessageRoute<M>`、`ChannelMessageHandler<M>`（Task 1）；`KitLogger`（`src/common/logger.ts`）；`redact`（`src/common/redact.ts`）
- Produces（`src/common/inbox.ts`）:
  ```ts
  export const MAX_QUEUE = 256
  export const MAX_SEEN = 2048
  export const HANDLER_TIMEOUT_MS = 30_000
  export interface MessageRouterCounts { received: number; dispatched: number; unmatched: number; duplicate: number; dropped: number; handlerErrors: number }
  export interface MessageRouterOptions<M extends ChannelAtMessage> {
    channel: string                       // 日志前缀，如 'dingtalk'
    logger: KitLogger
    onUnmatched: (message: M) => Promise<void>
    pluginRoutes?: ReadonlyMap<string, string> // 会话 ID → 插件 ID
    handlerTimeoutMs?: number             // 默认 HANDLER_TIMEOUT_MS
  }
  export class MessageRouter<M extends ChannelAtMessage> {
    constructor(options: MessageRouterOptions<M>)
    get size(): number                    // 路由数 + 插件处理器数
    counters(): MessageRouterCounts
    register(config: ChannelMessageRoute<M>, handler: ChannelMessageHandler<M>): () => void  // 返回幂等的注销函数
    registerPlugin(pluginId: string, handler: ChannelMessageHandler<M>): () => void
    drop(): void                          // 无法解析的输入，dropped + 1
    accept(message: M): void              // 计数、去重、入队
    setReady(ready: boolean): void        // true 时开始投递，false 时暂停
    reset(): void                         // 中止进行中的 handler、清空队列、暂停；之后可再 setReady(true)
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/message-router.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { MessageRouter, MAX_QUEUE } from '../../src/common/inbox.js'
import type { ChannelAtMessage } from '../../src/common/channel.js'
import { until } from '../helpers.js'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const msg = (eventId: string, conversationId: string, content = ''): ChannelAtMessage => ({ eventId, conversationId, content })

function router(options: { pluginRoutes?: Map<string, string>; handlerTimeoutMs?: number } = {}) {
  const unmatched: ChannelAtMessage[] = []
  const r = new MessageRouter<ChannelAtMessage>({ channel: 'test', logger, onUnmatched: async (m) => { unmatched.push(m) }, ...options })
  return { r, unmatched }
}

describe('MessageRouter', () => {
  it('dispatches each message to the highest-priority matching route, then registration order', async () => {
    const { r, unmatched } = router()
    const got: string[] = []
    r.register({ conversationId: 'c1' }, () => { got.push('low-first') })
    r.register({ conversationId: 'c1' }, () => { got.push('low-second') })
    r.register({ conversationId: 'c1', priority: 5, match: (m) => m.content === 'vip' }, () => { got.push('high') })
    r.setReady(true)
    r.accept(msg('e1', 'c1', 'vip'))
    r.accept(msg('e2', 'c1', 'plain'))
    r.accept(msg('e3', 'c2', 'other'))
    await until(() => r.counters().received === 3 && r.counters().dispatched === 2 && unmatched.length === 1)
    expect(got).toEqual(['high', 'low-first'])
    expect(unmatched.map((m) => m.eventId)).toEqual(['e3'])
  })

  it('counts a throwing matcher as a handler error and tries the next route', async () => {
    const { r } = router()
    const got: string[] = []
    r.register({ conversationId: 'c1', priority: 1, match: () => { throw new Error('bad') } }, () => { got.push('never') })
    r.register({ conversationId: 'c1' }, () => { got.push('fallback') })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    await until(() => got.length === 1)
    expect(got).toEqual(['fallback'])
    expect(r.counters().handlerErrors).toBe(1)
  })

  it('sends configured conversations only to their plugin and treats a missing plugin as unmatched', async () => {
    const { r, unmatched } = router({ pluginRoutes: new Map([['c1', 'orders'], ['c2', 'absent']]) })
    const got: string[] = []
    r.register({ conversationId: 'c1' }, () => { got.push('route') })
    r.registerPlugin('orders', () => { got.push('plugin') })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    r.accept(msg('e2', 'c2'))
    await until(() => got.length === 1 && unmatched.length === 1)
    expect(got).toEqual(['plugin'])
    expect(() => r.registerPlugin('orders', () => {})).toThrow(/already registered/)
  })

  it('drops duplicate event IDs and counts unparsable input', async () => {
    const { r } = router()
    r.register({ conversationId: 'c1' }, () => {})
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    r.accept(msg('e1', 'c1'))
    r.drop()
    await until(() => r.counters().dispatched === 1)
    expect(r.counters()).toMatchObject({ received: 2, duplicate: 1, dropped: 1 })
  })

  it('queues before ready and drops once the queue is full', async () => {
    const { r } = router()
    const handler = vi.fn()
    r.register({ conversationId: 'c1' }, handler)
    for (let i = 0; i <= MAX_QUEUE; i++) r.accept(msg(`e${i}`, 'c1'))
    expect(handler).not.toHaveBeenCalled()
    expect(r.counters().dropped).toBe(1)
    r.setReady(true)
    await until(() => r.counters().dispatched === MAX_QUEUE)
  })

  it('times out a slow handler and keeps dispatching', async () => {
    const { r } = router({ handlerTimeoutMs: 20 })
    const got: string[] = []
    r.register({ conversationId: 'c1' }, (m) => m.eventId === 'slow' ? new Promise(() => {}) : void got.push(m.eventId))
    r.setReady(true)
    r.accept(msg('slow', 'c1'))
    r.accept(msg('fast', 'c1'))
    await until(() => got.length === 1)
    expect(r.counters()).toMatchObject({ handlerErrors: 1, dispatched: 1 })
  })

  it('aborts an in-flight handler on reset and on route close', async () => {
    const { r } = router()
    const signals: AbortSignal[] = []
    const close = r.register({ conversationId: 'c1' }, (_m, { signal }) => { signals.push(signal); return new Promise(() => {}) })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    await until(() => signals.length === 1)
    close()
    expect(signals[0]!.aborted).toBe(true)
    expect(r.size).toBe(0)
    close()
    r.reset()
    expect(r.size).toBe(0)
  })

  it('rejects invalid routes', () => {
    const { r } = router()
    expect(() => r.register({ conversationId: '' }, () => {})).toThrow(/conversationId is required/)
    expect(() => r.register({ conversationId: 'c1', priority: Infinity }, () => {})).toThrow(/priority must be finite/)
    expect(() => r.registerPlugin(' ', () => {})).toThrow(/pluginId is required/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/message-router.test.ts`
Expected: FAIL with `Failed to load url ../../src/common/inbox.js` (module does not exist).

- [ ] **Step 3: Implement `MessageRouter`**

Create `src/common/inbox.ts`:

```ts
import type { ChannelAtMessage, ChannelMessageHandler, ChannelMessageRoute } from './channel.js'
import type { KitLogger } from './logger.js'
import { redact } from './redact.js'

export const MAX_QUEUE = 256
export const MAX_SEEN = 2048
export const HANDLER_TIMEOUT_MS = 30_000

export interface MessageRouterCounts {
  received: number
  dispatched: number
  unmatched: number
  duplicate: number
  dropped: number
  handlerErrors: number
}

export interface MessageRouterOptions<M extends ChannelAtMessage> {
  /** 日志前缀，如 `dingtalk`。 */
  channel: string
  logger: KitLogger
  /** 未命中任何路由时调用；失败只记日志。 */
  onUnmatched: (message: M) => Promise<void>
  /** 会话 ID → 插件 ID；配置了的会话只投递给该插件，不再看 `register()` 的路由。 */
  pluginRoutes?: ReadonlyMap<string, string>
  handlerTimeoutMs?: number
}

type Route<M extends ChannelAtMessage> = { id: number; config: ChannelMessageRoute<M>; handler: ChannelMessageHandler<M>; controller: AbortController }
type PluginHandler<M extends ChannelAtMessage> = { handler: ChannelMessageHandler<M>; controller: AbortController }

/**
 * 与渠道无关的群内 @ 消息路由：按 `eventId` 去重、有界队列、优先级路由、插件路由与 handler 超时。
 * 连接（子进程、长连接）由各渠道负责：解析出消息后 `accept()`，就绪时 `setReady(true)`，断开时 `setReady(false)`，停止时 `reset()`。
 * 每条消息只投递给一个处理器，按顺序逐条处理。
 */
export class MessageRouter<M extends ChannelAtMessage> {
  private readonly routes = new Map<number, Route<M>>()
  private readonly plugins = new Map<string, PluginHandler<M>>()
  private nextId = 0
  private readonly queue: M[] = []
  private readonly seen = new Set<string>()
  private processing = false
  private ready = false
  private controller = new AbortController()
  private readonly counts: MessageRouterCounts = { received: 0, dispatched: 0, unmatched: 0, duplicate: 0, dropped: 0, handlerErrors: 0 }

  constructor(private readonly options: MessageRouterOptions<M>) {}

  /** 已注册的路由与插件处理器总数。 */
  get size(): number {
    return this.routes.size + this.plugins.size
  }

  counters(): MessageRouterCounts {
    return { ...this.counts }
  }

  /** 注册路由；返回幂等的注销函数，注销时中止该路由进行中的 handler。 */
  register(config: ChannelMessageRoute<M>, handler: ChannelMessageHandler<M>): () => void {
    if (!config.conversationId || typeof config.conversationId !== 'string') throw new TypeError('conversationId is required')
    if (config.match !== undefined && typeof config.match !== 'function') throw new TypeError('match must be a function')
    if (config.priority !== undefined && !Number.isFinite(config.priority)) throw new TypeError('priority must be finite')
    if (typeof handler !== 'function') throw new TypeError('handler must be a function')
    const id = ++this.nextId
    const route = { id, config, handler, controller: new AbortController() }
    this.routes.set(id, route)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      route.controller.abort()
      this.routes.delete(id)
    }
  }

  /** 注册业务插件处理器；`pluginRoutes` 指向该插件的会话才会投递给它。 */
  registerPlugin(pluginId: string, handler: ChannelMessageHandler<M>): () => void {
    if (!pluginId.trim()) throw new TypeError('pluginId is required')
    if (typeof handler !== 'function') throw new TypeError('handler must be a function')
    if (this.plugins.has(pluginId)) throw new TypeError(`pluginId already registered: ${pluginId}`)
    const plugin = { handler, controller: new AbortController() }
    this.plugins.set(pluginId, plugin)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      plugin.controller.abort()
      if (this.plugins.get(pluginId) === plugin) this.plugins.delete(pluginId)
    }
  }

  /** 记一条无法解析的输入。 */
  drop(): void {
    this.counts.dropped++
  }

  accept(message: M): void {
    this.counts.received++
    if (this.seen.has(message.eventId)) {
      this.counts.duplicate++
      return
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.counts.dropped++
      this.options.logger.warn(`${this.options.channel} event queue full; message dropped`, { eventId: message.eventId })
      return
    }
    this.seen.add(message.eventId)
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!)
    this.queue.push(message)
    if (this.ready) void this.pump()
  }

  setReady(ready: boolean): void {
    this.ready = ready
    if (ready) void this.pump()
  }

  reset(): void {
    this.ready = false
    this.controller.abort()
    this.controller = new AbortController()
    this.queue.length = 0
  }

  private select(message: M): Pick<Route<M>, 'handler' | 'controller'> | undefined {
    const pluginId = this.options.pluginRoutes?.get(message.conversationId)
    if (pluginId) return this.plugins.get(pluginId)
    const routes = [...this.routes.values()]
      .filter((route) => route.config.conversationId === message.conversationId)
      .sort((a, b) => (b.config.priority ?? 0) - (a.config.priority ?? 0) || a.id - b.id)
    for (const route of routes) {
      try {
        if (!route.config.match || route.config.match(message)) return route
      } catch (error) {
        this.counts.handlerErrors++
        this.options.logger.warn(`${this.options.channel} route matcher failed`, { eventId: message.eventId, error: redact(String(error)) })
      }
    }
    return undefined
  }

  private async pump(): Promise<void> {
    if (this.processing || !this.ready) return
    this.processing = true
    try {
      while (this.queue.length && this.ready) {
        const message = this.queue.shift()!
        const selected = this.select(message)
        if (!selected) {
          this.counts.unmatched++
          try {
            await this.options.onUnmatched(message)
          } catch (error) {
            this.options.logger.warn(`failed to record unmatched ${this.options.channel} message`, { eventId: message.eventId, error: redact(String(error)) })
          }
          continue
        }
        const signal = AbortSignal.any([this.controller.signal, selected.controller.signal, AbortSignal.timeout(this.options.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS)])
        let onAbort: (() => void) | undefined
        try {
          await Promise.race([
            Promise.resolve().then(() => selected.handler(message, { signal })),
            new Promise<never>((_, reject) => {
              onAbort = () => reject(new Error('handler aborted or timed out'))
              if (signal.aborted) onAbort()
              else signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
          this.counts.dispatched++
        } catch (error) {
          this.counts.handlerErrors++
          this.options.logger.warn(`${this.options.channel} message handler failed`, { eventId: message.eventId, error: redact(String(error)) })
        } finally {
          if (onAbort) signal.removeEventListener('abort', onAbort)
        }
      }
    } finally {
      this.processing = false
    }
  }
}
```

- [ ] **Step 4: Run the router tests**

Run: `npx vitest run tests/unit/message-router.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Rewire `DingtalkInbox` onto the router**

Edit `src/dingtalk/inbox.ts`:

1. Remove the constants `MAX_QUEUE`, `MAX_SEEN`, `HANDLER_TIMEOUT_MS` and the `Route` / `PluginHandler` type aliases (keep `EVENT_TYPE` and `MAX_LINE`). Add the import:

   ```ts
   import { MessageRouter } from '../common/inbox.js'
   ```

2. Replace the `DingtalkInboxStats` interface body so it reuses the router counts:

   ```ts
   export interface DingtalkInboxStats extends MessageRouterCounts {
     listener: 'idle' | 'starting' | 'ready' | 'failed'
     routes: number
   }
   ```

   (import `type MessageRouterCounts` from `'../common/inbox.js'` together with `MessageRouter`).

3. In `class DingtalkInbox`, delete these fields: `routes`, `pluginHandlers`, `nextId`, `queue`, `processing`, `seen`, `controller`, `counts`. Add:

   ```ts
   private readonly router: MessageRouter<DingtalkAtMessage>
   ```

   and at the end of the constructor parameter list keep `groupRoutes` as is, then add a constructor body:

   ```ts
   ) {
     this.router = new MessageRouter<DingtalkAtMessage>({ channel: 'dingtalk', logger, onUnmatched, pluginRoutes: groupRoutes })
   }
   ```

   (the parameters `logger`, `onUnmatched` and `groupRoutes` stay `private readonly` as before; only the empty body `{}` changes).

4. Replace `stats()`:

   ```ts
   stats(): DingtalkInboxStats {
     return { listener: this.state, routes: this.router.size, ...this.router.counters() }
   }
   ```

5. Replace `register()` and `registerPlugin()` with:

   ```ts
   register(config: DingtalkMessageRoute, handler: DingtalkMessageHandler): DingtalkMessageSubscription {
     return this.subscribe(this.router.register(config, handler))
   }

   /** 注册业务插件处理器；设置页按群 ID 指定 pluginId 后才会向它投递。 */
   registerPlugin(pluginId: string, handler: DingtalkMessageHandler): DingtalkMessageSubscription {
     return this.subscribe(this.router.registerPlugin(pluginId, handler))
   }

   private subscribe(dispose: () => void): DingtalkMessageSubscription {
     const ready = this.start()
     void ready.catch(() => {})
     let closed = false
     return {
       ready,
       close: async () => {
         if (closed) return
         closed = true
         dispose()
         if (this.router.size === 0 && !this.captureUnmatched) await this.stop()
       },
     }
   }
   ```

6. In `start()`:
   - replace `if (this.routes.size === 0 && this.pluginHandlers.size === 0 && !this.captureUnmatched) throw new Error('dws event listener stopped')` with `if (this.router.size === 0 && !this.captureUnmatched) throw new Error('dws event listener stopped')`;
   - delete the line `this.controller = new AbortController()`;
   - in the stdout handler, replace both `this.counts.dropped++` with `this.router.drop()`;
   - in the ready-marker branch, replace `void this.pump()` with `this.router.setReady(true)`;
   - in the `close` handler, add `this.router.setReady(false)` as the first statement, and replace `(this.routes.size === 0 && this.pluginHandlers.size === 0 && !this.captureUnmatched)` with `(this.router.size === 0 && !this.captureUnmatched)`.

7. Replace `accept()` with:

   ```ts
   private accept(line: string): void {
     const message = parseAtMessage(line)
     if (!message) {
       this.router.drop()
       this.logger.warn('invalid dws event line dropped')
       return
     }
     this.router.accept(message)
   }
   ```

8. Delete `pump()` entirely.

9. In `fail()`, add `this.router.setReady(false)` right after `this.state = 'failed'`.

10. In `stop()`, replace the two lines `this.controller.abort()` and `this.queue.length = 0` with `this.router.reset()`.

Verify nothing references removed fields: `grep -nE "this\.(routes|pluginHandlers|queue|seen|counts|controller|processing|pump)\b" src/dingtalk/inbox.ts` prints nothing.

Note: the queue-full log message changes from `dws event queue full; message dropped` to `dingtalk event queue full; message dropped`. No test asserts it.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: all pass, including every test in the unchanged `tests/unit/dingtalk-inbox.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/common/inbox.ts src/dingtalk/inbox.ts tests/unit/message-router.test.ts
git commit -m "refactor(channel): extract channel-agnostic MessageRouter from the DingTalk inbox"
```

---

### Task 3: `notify` 按调用指定渠道

**Files:**
- Create: `src/notify/errors.ts`
- Create: `src/notify/deliver.ts`
- Modify: `src/notify/config.ts`
- Modify: `src/notify/service.ts`（整体重写）
- Modify: `src/notify/index.ts`、`src/index.ts`
- Modify: `docs/superpowers/specs/2026-10-21-channel-contract-notify-design.md`（补充 `send_failed` 与行为变更）
- Test: `tests/unit/notify-deliver.test.ts`（新建）、`tests/unit/notify.test.ts`（重写）

**Interfaces:**
- Consumes: `ChannelService`、`ChannelSendCommon`、`ChannelSendResult`、`CHANNEL_NAMES`（Task 1）；`DingtalkTarget`、`DingtalkAt`（`src/dingtalk/args.ts`）
- Produces:
  ```ts
  // src/notify/errors.ts
  export type NotifyErrorCode = 'channel_unavailable' | 'invalid_channel' | 'login_unsupported' | 'send_failed'
  export class NotifyError extends KitError { constructor(code: NotifyErrorCode, message: string, options?: KitErrorOptions) }
  // src/notify/deliver.ts
  export interface NotifyDelivery<C extends string = string> { channel: C; results: ChannelSendResult['results'] }
  export interface PlannedDelivery<C extends string = string> { channel: C; service: ChannelService | undefined; target?: unknown; at?: unknown }
  export function channelUnavailable(channel: string): NotifyError
  export function deliver<C extends string>(plans: PlannedDelivery<C>[], common: ChannelSendCommon): Promise<NotifyDelivery<C>[]>
  export function requireLogin(channel: string, service: ChannelService): NonNullable<ChannelService['login']>
  export function requireLogout(channel: string, service: ChannelService): NonNullable<ChannelService['logout']>
  // src/notify/service.ts
  export interface NotifyTargets { dingtalk?: DingtalkTarget }
  export interface NotifyAts { dingtalk?: DingtalkAt }
  export interface NotifySendOptions extends ChannelSendCommon { targets?: NotifyTargets; at?: NotifyAts }
  export interface NotifySendResult { deliveries: NotifyDelivery<NotifyChannel>[] }
  export interface NotifyStatus { defaultChannel: NotifyChannel; channels: Record<NotifyChannel, (ChannelStatus & { running: true }) | ChannelNotRunning> }
  class NotifyService { send(o): Promise<NotifySendResult>; status(): Promise<NotifyStatus>; login(channel, options?): Promise<LoginSession>; logout(channel): Promise<ChannelStatus>; health() }
  ```

- [ ] **Step 1: Write the failing `deliver()` tests**

Create `tests/unit/notify-deliver.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ChannelService } from '../../src/common/channel.js'
import { KitError } from '../../src/common/errors.js'
import { deliver, requireLogin, requireLogout } from '../../src/notify/deliver.js'

const ok = (messageId: string): ChannelService => ({
  send: async () => ({ results: [{ ok: true, messageId }] }),
  status: async () => ({ channel: 'dingtalk', identity: 'bot', online: true, detail: 'ok', checkedAt: 0 }),
  health: () => ({ status: 'ok', detail: 'ok' }),
})

describe('deliver', () => {
  it('sends to every planned channel in parallel and keeps plan order', async () => {
    const seen: unknown[] = []
    const a: ChannelService = { ...ok('a1'), send: async (o) => { seen.push(o.target); return { results: [{ ok: true, messageId: 'a1' }] } } }
    const r = await deliver([
      { channel: 'a', service: a, target: { chatId: 'x' } },
      { channel: 'b', service: ok('b1') },
    ], { text: 'hi', idempotencyKey: 'k' })
    expect(r).toEqual([
      { channel: 'a', results: [{ ok: true, messageId: 'a1' }] },
      { channel: 'b', results: [{ ok: true, messageId: 'b1' }] },
    ])
    expect(seen).toEqual([{ chatId: 'x' }])
  })

  it('turns a missing channel and a throwing channel into failed results of that channel only', async () => {
    const kitFail: ChannelService = { ...ok('x'), send: async () => { throw new KitError('dingtalk', 'invalid_target', 'bad target', { retryable: false }) } }
    const rawFail: ChannelService = { ...ok('x'), send: async () => { throw new Error('boom') } }
    const r = await deliver([
      { channel: 'gone', service: undefined },
      { channel: 'kit', service: kitFail },
      { channel: 'raw', service: rawFail },
      { channel: 'fine', service: ok('f1') },
    ], { text: 'hi' })
    expect(r[0]!.results[0]).toMatchObject({ ok: false, error: { code: 'channel_unavailable' } })
    expect(r[1]!.results[0]).toMatchObject({ ok: false, error: { code: 'invalid_target' } })
    expect(r[2]!.results[0]).toMatchObject({ ok: false, error: { code: 'send_failed', retryable: true } })
    expect(r[3]!.results[0]).toEqual({ ok: true, messageId: 'f1' })
  })

  it('rejects login and logout on channels that do not implement them', () => {
    expect(() => requireLogin('bot', ok('x'))).toThrow(expect.objectContaining({ code: 'login_unsupported' }))
    expect(() => requireLogout('bot', ok('x'))).toThrow(expect.objectContaining({ code: 'login_unsupported' }))
    const withLogin: ChannelService = { ...ok('x'), login: async () => { throw new Error('called') } }
    expect(typeof requireLogin('user', withLogin)).toBe('function')
  })
})
```

Before writing it, confirm the `KitError` constructor signature: `grep -n "constructor" -A3 src/common/errors.ts`. It must be `(service, code, message, options)`; if the argument order differs, adjust the `new KitError(...)` call in the test to match.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/notify-deliver.test.ts`
Expected: FAIL with `Failed to load url ../../src/notify/deliver.js`.

- [ ] **Step 3: Move `NotifyError` to its own file**

Create `src/notify/errors.ts`:

```ts
import { KitError, type KitErrorOptions } from '../common/errors.js'

export type NotifyErrorCode = 'channel_unavailable' | 'invalid_channel' | 'login_unsupported' | 'send_failed'

export class NotifyError extends KitError {
  declare readonly code: NotifyErrorCode

  constructor(code: NotifyErrorCode, message: string, options: KitErrorOptions = {}) {
    super('notify', code, message, options)
    this.name = 'NotifyError'
  }
}
```

- [ ] **Step 4: Implement `deliver.ts`**

Create `src/notify/deliver.ts`:

```ts
import type { ChannelSendCommon, ChannelSendResult, ChannelService } from '../common/channel.js'
import { isKitError } from '../common/errors.js'
import { redact } from '../common/redact.js'
import { NotifyError } from './errors.js'

export interface NotifyDelivery<C extends string = string> {
  channel: C
  results: ChannelSendResult['results']
}

export interface PlannedDelivery<C extends string = string> {
  channel: C
  /** 未运行时为 undefined。 */
  service: ChannelService | undefined
  /** 缺省时由渠道使用自己配置的默认目标。 */
  target?: unknown
  at?: unknown
}

export function channelUnavailable(channel: string): NotifyError {
  return new NotifyError('channel_unavailable', `${channel} is not running; enable agent-kit-${channel}`, { details: { channel } })
}

/** 并行投递到各渠道。渠道未运行或 `send()` 抛错，都只转为该渠道的失败结果，不影响其他渠道。 */
export function deliver<C extends string>(plans: PlannedDelivery<C>[], common: ChannelSendCommon): Promise<NotifyDelivery<C>[]> {
  return Promise.all(plans.map(async ({ channel, service, target, at }): Promise<NotifyDelivery<C>> => {
    if (!service) return { channel, results: [{ ok: false, error: channelUnavailable(channel) }] }
    try {
      const r = await service.send({ ...common, target, at })
      return { channel, results: r.results.map((x) => ({ ok: x.ok, ...(x.messageId ? { messageId: x.messageId } : {}), ...(x.error ? { error: x.error } : {}) })) }
    } catch (e) {
      const error = isKitError(e) ? e : new NotifyError('send_failed', `${channel} send failed: ${redact(String((e as Error)?.message ?? e))}`, { retryable: true, cause: e, details: { channel } })
      return { channel, results: [{ ok: false, error }] }
    }
  }))
}

export function requireLogin(channel: string, service: ChannelService): NonNullable<ChannelService['login']> {
  if (!service.login) throw new NotifyError('login_unsupported', `${channel} does not support login`, { details: { channel } })
  return service.login.bind(service)
}

export function requireLogout(channel: string, service: ChannelService): NonNullable<ChannelService['logout']> {
  if (!service.logout) throw new NotifyError('login_unsupported', `${channel} does not support logout`, { details: { channel } })
  return service.logout.bind(service)
}
```

Confirm `KitErrorOptions` has `retryable`, `cause` and `details`: `grep -n "interface KitErrorOptions" -A6 src/common/errors.ts`. Confirm `isKitError` is exported from `src/common/errors.ts` (it is re-exported from `src/index.ts`).

- [ ] **Step 5: Run the deliver tests**

Run: `npx vitest run tests/unit/notify-deliver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Rewrite the `NotifyService` tests**

Replace the whole of `tests/unit/notify.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { NotifyService } from '../../src/notify/service.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('NotifyService', () => {
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

  it('sends to the default channel with its default target when no targets are given', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const result = await notify.send({ text: 'hello', idempotencyKey: 'evt_1' })
    expect(result).toMatchObject({ deliveries: [{ channel: 'dingtalk', results: [{ ok: true }] }] })
    expect(dws.calls().some((call) => call.args.includes('--as=user') && call.args.some((a) => a.includes('cidA')))).toBe(true)
  })

  it('sends only to the channels named in targets, using their targets', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const result = await notify.send({ text: 'hello', targets: { dingtalk: { chatId: 'cidB' } } })
    expect(result.deliveries.map((d) => d.channel)).toEqual(['dingtalk'])
    const sends = dws.calls().filter((call) => call.args.some((a) => a.includes('cidB')))
    expect(sends).toHaveLength(1)
  })

  it('throws when the default channel is not running, but reports a named channel that is not running as a failed delivery', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.send({ text: 'hello' })).rejects.toMatchObject({ code: 'channel_unavailable' })
    const r = await notify.send({ text: 'hello', targets: { dingtalk: { chatId: 'cidA' } } })
    expect(r.deliveries).toEqual([{ channel: 'dingtalk', results: [{ ok: false, error: expect.objectContaining({ code: 'channel_unavailable' }) }] }])
    expect(notify.health()).toMatchObject({ status: 'failed' })
  })

  it('rejects unknown channels in targets', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.send({ text: 'hello', targets: { feishu: { chatId: 'x' } } as never })).rejects.toMatchObject({ code: 'invalid_channel' })
  })

  it('reports the default channel and each channel without runtime switching', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const status = await notify.status()
    expect(status).toEqual({ defaultChannel: 'dingtalk', channels: { dingtalk: expect.objectContaining({ running: true, online: true }) } })
    expect('use' in notify).toBe(false)
    expect(notify.health()).toMatchObject({ status: 'ok', detail: 'default channel: dingtalk' })
  })

  it('requires a channel name for login and logout', async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    await expect(notify.logout('dingtalk')).rejects.toMatchObject({ code: 'channel_unavailable' })
  })
})
```

- [ ] **Step 7: Run to verify the rewritten tests fail**

Run: `npx vitest run tests/unit/notify.test.ts`
Expected: FAIL; the first test reports that `result` has `channel`/`results` instead of `deliveries`.

- [ ] **Step 8: Update the notify config**

Replace the whole of `src/notify/config.ts` with:

```ts
import z from '@deepseek-ai/schemastery'
import { CHANNEL_NAMES, type ChannelName } from '../common/channel.js'
import type { ConfigInput } from '../common/errors.js'

export type NotifyChannel = ChannelName
export const NOTIFY_CHANNELS = CHANNEL_NAMES

export interface NotifyConfig {
  /** 默认渠道：`send()` 未指定 `targets` 时发往这里。 */
  channel: NotifyChannel
}

export const NotifyConfig: z<ConfigInput<NotifyConfig>, NotifyConfig> = z.object({
  channel: z.union(NOTIFY_CHANNELS.map((c) => z.const(c))).default('dingtalk').description('默认渠道：send() 未指定 targets 时发往这里'),
}) as z<ConfigInput<NotifyConfig>, NotifyConfig>
```

Check the admin validator still rejects unknown values: `cd admin && npx vitest run tests/unit/profile.test.ts` must keep passing (it validates `{ channel: 'email' }` as invalid). If schemastery's `z.union` with a single `z.const` member changes the website config table (`website/tests/config-tables.test.ts` only checks leaf paths, which stay `channel`), nothing else needs updating.

- [ ] **Step 9: Rewrite `NotifyService`**

Replace the whole of `src/notify/service.ts` with:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ChannelSendCommon, ChannelService, ChannelStatus, LoginSession } from '../common/channel.js'
import { digest } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import type { DingtalkAt, DingtalkTarget } from '../dingtalk/args.js'
import { NOTIFY_CHANNELS, NotifyConfig, type NotifyChannel } from './config.js'
import { channelUnavailable, deliver, requireLogin, requireLogout, type NotifyDelivery } from './deliver.js'
import { NotifyError } from './errors.js'

export { NotifyError, type NotifyErrorCode } from './errors.js'

/** 按渠道给出的发送目标；缺省的渠道使用其配置中的默认目标。 */
export interface NotifyTargets {
  dingtalk?: DingtalkTarget
}

/** 按渠道给出的 @ 人。 */
export interface NotifyAts {
  dingtalk?: DingtalkAt
}

export interface NotifySendOptions extends ChannelSendCommon {
  /** 写了哪些渠道就只发这些渠道；缺省或为空时发往默认渠道。 */
  targets?: NotifyTargets
  at?: NotifyAts
}

export interface NotifySendResult {
  /** 每个渠道一项，顺序与发送的渠道顺序一致。 */
  deliveries: NotifyDelivery<NotifyChannel>[]
}

/** 未运行的渠道（对应的行未启用或启动失败）。 */
export interface ChannelNotRunning {
  channel: NotifyChannel
  running: false
  detail: string
}

export interface NotifyStatus {
  defaultChannel: NotifyChannel
  /** 每个渠道是否运行及登录状态。 */
  channels: Record<NotifyChannel, (ChannelStatus & { running: true }) | ChannelNotRunning>
}

export interface NotifyCounters {
  success: number
  failure: number
  lastFailureAt: number | null
  lastErrorCode: string | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    notify: NotifyService
  }
}

/**
 * 通知入口：业务包调用 `ctx.notify.send()`，未指定 `targets` 时发往默认渠道，指定了则只发这些渠道。
 *
 * - 修改本行配置的 `channel`（默认渠道）不重载本服务与依赖它的业务插件：在本 fiber 的 `internal/update`
 *   钩子里原地换上新值（不调用 `next()`，否决 cordis 默认的重启）。
 * - 不 inject 渠道服务，而是在发送时用 `ctx.get()` 取：cordis 的 inject 都是必需的，inject 了渠道就
 *   意味着停用任一渠道都会连带卸载本服务以及所有依赖它的业务插件。
 * - 多渠道时并行发送；某个渠道未运行或失败只体现在它自己的结果里，不影响其他渠道。
 */
export class NotifyService extends KitService<NotifyCounters> {
  static Config = NotifyConfig
  private current: NotifyConfig
  private lastSuccessAt: number | null = null
  private readonly counters: NotifyCounters = { success: 0, failure: 0, lastFailureAt: null, lastErrorCode: null }

  constructor(ctx: Context, config: NotifyConfig) {
    super(ctx, 'notify')
    this.current = config
    const self = this
    ctx.on('internal/update', function (next, _noSave, _restart) {
      // this 为本插件的 fiber；next 已经过 NotifyConfig 解析。
      self.current = next as NotifyConfig
      ;(this as unknown as { config: NotifyConfig }).config = self.current
      self.logger.info('notify default channel updated from config', { channel: self.current.channel })
    })
  }

  get config(): NotifyConfig {
    return this.current
  }

  /** 默认渠道。 */
  get defaultChannel(): NotifyChannel {
    return this.current.channel
  }

  private service(name: NotifyChannel): ChannelService | undefined {
    return (this.ctx as unknown as { get(name: string): ChannelService | undefined }).get(name)
  }

  private require(name: NotifyChannel): ChannelService {
    const svc = this.service(name)
    if (!svc) throw channelUnavailable(name)
    return svc
  }

  async send(options: NotifySendOptions): Promise<NotifySendResult> {
    const named = Object.entries(options.targets ?? {}).filter(([, target]) => target !== undefined).map(([name]) => name)
    for (const name of named) {
      if (!NOTIFY_CHANNELS.includes(name as NotifyChannel)) throw new NotifyError('invalid_channel', `unknown channel ${name}`, { details: { channel: name } })
    }
    const channels = named.length > 0 ? (named as NotifyChannel[]) : [this.defaultChannel]
    this.logger.info('notify send', { traceId: options.traceId, channels, body: digest(options.markdown ?? options.text ?? '') })
    if (named.length === 0 && !this.service(this.defaultChannel)) {
      this.recordFailure('channel_unavailable')
      throw channelUnavailable(this.defaultChannel)
    }
    const common: ChannelSendCommon = { title: options.title, markdown: options.markdown, text: options.text, idempotencyKey: options.idempotencyKey, traceId: options.traceId, signal: options.signal }
    const deliveries = await deliver(
      channels.map((channel) => ({ channel, service: this.service(channel), target: options.targets?.[channel], at: options.at?.[channel] })),
      common,
    )
    for (const d of deliveries) {
      const failed = d.results.find((x) => !x.ok)
      if (failed) this.recordFailure(failed.error?.code ?? 'send_failed')
      else this.recordSuccess()
    }
    return { deliveries }
  }

  /** 默认渠道与每个渠道的实时登录状态。 */
  async status(): Promise<NotifyStatus> {
    const entries = await Promise.all(
      NOTIFY_CHANNELS.map(async (name) => {
        const svc = this.service(name)
        if (!svc) return [name, { channel: name, running: false, detail: `agent-kit-${name} is not running` }] as const
        return [name, { ...(await svc.status()), running: true }] as const
      }),
    )
    return { defaultChannel: this.defaultChannel, channels: Object.fromEntries(entries) as NotifyStatus['channels'] }
  }

  /** 登录指定渠道；渠道不需要登录（如机器人）时抛出 `login_unsupported`。 */
  async login(channel: NotifyChannel, options: { signal?: AbortSignal } = {}): Promise<LoginSession> {
    return requireLogin(channel, this.require(channel))(options)
  }

  /** 退出指定渠道的登录；渠道不需要登录时抛出 `login_unsupported`。 */
  async logout(channel: NotifyChannel): Promise<ChannelStatus> {
    return requireLogout(channel, this.require(channel))()
  }

  private recordSuccess(): void {
    this.counters.success++
    this.lastSuccessAt = Date.now()
  }

  private recordFailure(code: string): void {
    this.counters.failure++
    this.counters.lastFailureAt = Date.now()
    this.counters.lastErrorCode = code
  }

  health(): ServiceHealth<NotifyCounters> {
    const counters = { ...this.counters }
    const channel = this.defaultChannel
    const svc = this.service(channel)
    if (!svc) return { status: 'failed', detail: `default channel ${channel} is not running`, counters }
    const channelHealth = svc.health()
    if (channelHealth.status === 'failed') return { status: 'failed', detail: `default channel ${channel}: ${channelHealth.detail}`, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: `default channel: ${channel}`, counters }
  }
}

export default NotifyService
```

- [ ] **Step 10: Update the exports**

Replace `src/notify/index.ts` with:

```ts
export {
  NotifyService as default,
  NotifyService,
  NotifyError,
  type ChannelNotRunning,
  type NotifyAts,
  type NotifyCounters,
  type NotifyErrorCode,
  type NotifySendOptions,
  type NotifySendResult,
  type NotifyStatus,
  type NotifyTargets,
} from './service.js'
export type { NotifyDelivery } from './deliver.js'
export { NotifyConfig, NOTIFY_CHANNELS, type NotifyChannel } from './config.js'
export { DEFAULT_LOGIN_TTL_MS, type ChannelName, type ChannelStatus, type LoginSession } from '../common/channel.js'
```

In `src/index.ts`, inside the `export { NotifyService, ... } from './notify/index.js'` block, add `type NotifyAts,`, `type NotifyDelivery,` and `type NotifyTargets,` in alphabetical position.

- [ ] **Step 11: Run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: all pass. If `grep -rn "notify\.use\|\.source\b" src tests` finds any leftover reference to the removed API, delete it.

- [ ] **Step 12: Record the clarifications in the spec**

In `docs/superpowers/specs/2026-10-21-channel-contract-notify-design.md`, section「4. 错误处理」, replace the bullet

```
- `NotifyErrorCode` 新增 `login_unsupported`（不可重试），保留 `channel_unavailable`、`invalid_channel`。
```

with

```
- `NotifyErrorCode` 新增 `login_unsupported`（不可重试）与 `send_failed`（可重试，渠道 `send()` 抛出非 `KitError` 异常时包装使用），保留 `channel_unavailable`、`invalid_channel`。
```

and in section「5. 版本与迁移」, add to the migration list:

```
  - 渠道发送失败（如钉钉 `DingtalkSendError`）不再从 `notify.send()` 抛出，改为出现在对应 `deliveries[i].results[j].error` 中；
```

- [ ] **Step 13: Commit**

```bash
git add src/notify src/index.ts tests/unit/notify.test.ts tests/unit/notify-deliver.test.ts docs/superpowers/specs/2026-10-21-channel-contract-notify-design.md
git commit -m "feat(notify): send to named channels or the default channel, drop runtime switching"
```

---

### Task 4: admin 的 doctor 与 setup 改为默认渠道

**Files:**
- Modify: `admin/src/checks/notify.ts`
- Modify: `admin/src/cli/messages.ts:49`、`admin/src/cli/messages.ts:109-114`
- Modify: `admin/src/cli/setup.ts:163-167`、`admin/src/cli/setup.ts:246`
- Test: `admin/tests/unit/checks.test.ts:149-155`

**Interfaces:**
- Consumes: `NOTIFY_CHANNELS`、`NotifyChannel`（`@baoyx/dsh-agent-kit/notify`，Task 3）。admin 的 `tsconfig.json` 与 `vitest.config.ts` 用路径别名直接指向 `../src`，单元测试与类型检查无需先构建；admin 的集成测试会自行构建根包 `lib/`。
- Produces: `msg.NOTIFY_DEFAULT_CHANNEL_MESSAGE: string`；doctor 检查 id 仍为 `agent-kit-notify.channel`，标题改为 `默认通知渠道：<渠道名>`。

- [ ] **Step 1: Update the failing check test**

In `admin/tests/unit/checks.test.ts`, inside `describe('notify checks', ...)`, change

```ts
    expect(byId(on, 'agent-kit-notify.channel')).toMatchObject({ status: 'pass', title: '通知渠道：钉钉' })
```

to

```ts
    expect(byId(on, 'agent-kit-notify.channel')).toMatchObject({ status: 'pass', title: '默认通知渠道：钉钉' })
```

and change

```ts
    expect(byId(off, 'agent-kit-notify.channel')).toMatchObject({ status: 'fail', fix: expect.stringContaining('启用 钉钉') })
```

to

```ts
    expect(byId(off, 'agent-kit-notify.channel')).toMatchObject({ status: 'fail', fix: expect.stringContaining('启用 钉钉'), detail: expect.stringContaining('发往默认渠道的通知会失败') })
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd admin && npx vitest run tests/unit/checks.test.ts`
Expected: FAIL on `title` (`通知渠道：钉钉` vs `默认通知渠道：钉钉`).

- [ ] **Step 3: Update the doctor check**

Replace the whole of `admin/src/checks/notify.ts` with:

```ts
import type { Check } from './types.js'

const TITLES: Record<string, string> = { dingtalk: '钉钉' }

/** 默认通知渠道对应的渠道行应已启用，否则未指定 targets 的通知会报 channel_unavailable。 */
export const notifyChecks: Check = (ctx) => {
  const scope = 'agent-kit-notify' as const
  const channel = ((ctx.snapshot.entries[scope].config ?? {}) as { channel?: string }).channel
  if (!channel) return []
  const id = `agent-kit-${channel}` as 'agent-kit-dingtalk'
  const enabled = ctx.snapshot.entries[id]?.enabled === true
  const title = TITLES[channel] ?? channel
  return [
    {
      id: `${scope}.channel`,
      scope,
      title: `默认通知渠道：${title}`,
      status: enabled ? 'pass' : 'fail',
      detail: enabled ? `${id} 已启用` : `${id} 未启用，发往默认渠道的通知会失败`,
      ...(enabled ? {} : { fix: `启用 ${title}（设置页或 setup），或把默认通知渠道改为已启用的渠道` }),
    },
  ]
}
```

- [ ] **Step 4: Update the setup messages**

In `admin/src/cli/messages.ts`, change line 49

```ts
  'agent-kit-notify': '钉钉通知入口（业务包通过 ctx.notify 发送）',
```

to

```ts
  'agent-kit-notify': '通知入口：发往默认渠道，也可按调用指定渠道（业务包通过 ctx.notify 发送）',
```

and under `// ---- notify ----`, after `NOTIFY_CHANNEL_TITLES`, add:

```ts
export const NOTIFY_DEFAULT_CHANNEL_MESSAGE = '默认通知渠道（send() 未指定 targets 时发往这里）'
```

- [ ] **Step 5: Update `configureNotify`**

In `admin/src/cli/setup.ts`, replace

```ts
/** 通知固定发往钉钉。 */
function configureNotify(io: CliIO, enabledChannels: NotifyChannel[]): Config {
  if (!enabledChannels.includes('dingtalk')) io.out(msg.notifyChannelNotEnabled(msg.NOTIFY_CHANNEL_TITLES.dingtalk!))
  return { channel: 'dingtalk' }
}
```

with

```ts
/** 选择默认通知渠道；只有一个可选渠道时直接使用，不提问。 */
async function configureNotify(p: Prompter, io: CliIO, current: Config, enabledChannels: NotifyChannel[]): Promise<Config> {
  const channel = NOTIFY_CHANNELS.length === 1
    ? NOTIFY_CHANNELS[0]!
    : await p.select(
        msg.NOTIFY_DEFAULT_CHANNEL_MESSAGE,
        NOTIFY_CHANNELS.map((value) => ({ value, name: msg.NOTIFY_CHANNEL_TITLES[value] ?? value })),
        (current.channel as NotifyChannel | undefined) ?? NOTIFY_CHANNELS[0]!,
      )
  if (!enabledChannels.includes(channel)) io.out(msg.notifyChannelNotEnabled(msg.NOTIFY_CHANNEL_TITLES[channel] ?? channel))
  return { channel }
}
```

and change line 246

```ts
      : id === 'agent-kit-notify' ? configureNotify(io, enabledChannels)
```

to

```ts
      : id === 'agent-kit-notify' ? await configureNotify(p, io, current, enabledChannels)
```

Check `p.select`'s signature matches `(message, choices, default)`: `grep -n "select" admin/src/cli/prompter.ts`. It is already used this way by `configureJev` (`p.select(msg.JEV_PROVIDER_MESSAGE, msg.JEV_PROVIDER_CHOICES, ...)`). The multi-choice branch only becomes reachable once a second channel joins `CHANNEL_NAMES` (spec 2); the setup tests cover the single-channel branch.

- [ ] **Step 6: Run the admin suite**

Run: `cd admin && npm run typecheck && npx vitest run`
Expected: all pass, including `tests/unit/cli-setup.test.ts` (the notify step still asks nothing when only DingTalk exists) and `tests/unit/checks.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add admin/src/checks/notify.ts admin/src/cli/messages.ts admin/src/cli/setup.ts admin/tests/unit/checks.test.ts
git commit -m "feat(admin): treat the notify channel as the default channel in doctor and setup"
```

---

### Task 5: 文档与 0.3.0 版本

**Files:**
- Modify: `README.md:35`、`README.md:63`、`README.md:186-196`、`README.md:289`、`README.md:295`，并新增「渠道约定」与「0.3.0 迁移」两节
- Modify: `website/src/pages/docs/notify.mdx`
- Modify: `website/src/data/services.ts:102-120`
- Modify: `website/src/data/changelog.ts`
- Modify: `package.json`、`admin/package.json`、`package-lock.json`

**Interfaces:**
- Consumes: Task 1–4 的公开 API 名称（`ChannelService`、`ChannelAtMessage`、`onMessage`、`onPluginMessage`、`unmatchedMessages`、`deliveries`、`defaultChannel`、`login_unsupported`、`send_failed`）
- Produces: 无代码接口

- [ ] **Step 1: Update README**

1. Line 35, change the `ctx.notify` row to:

   ```
   | `ctx.notify` | 通知入口：业务包调用 `ctx.notify.send()`，默认发往配置的默认渠道，也可在 `targets` 中按渠道指定 |
   ```

2. Line 63, replace the sentence with:

   ```
   `notify` 不直接连接外部系统：它在每次发送时查找对应的渠道 Service 并转发，业务包因此只需依赖 `notify`。
   ```

3. Replace the paragraph at line 188 (`` `ctx.notify` 将消息转发给已启用的 `ctx.dingtalk`，返回 `{ channel: 'dingtalk', results }`…``) with:

   ```
   `ctx.notify.send()` 未指定 `targets` 时发往默认渠道（`agent-kit-notify` 的 `channel`），使用该渠道配置的默认目标；`targets` 中写了哪些渠道就只发这些渠道，并行发送。返回 `{ deliveries: Array<{ channel, results }> }`。只有两种情况直接抛出 `NotifyError`：未指定 `targets` 且默认渠道未运行（`channel_unavailable`）；`targets` 中出现未知渠道（`invalid_channel`）。其他失败（指定的渠道未运行、渠道发送失败）都在对应的 `results[i].error` 中返回，调用方需要逐条检查。
   ```

   and in the same section, replace the last sentence `通知服务也提供 status()、login()、logout() 转发到钉钉。` with `` 通知服务的 `status()` 返回 `{ defaultChannel, channels }`；`login(channel)` / `logout(channel)` 必须指定渠道，渠道不需要登录时抛出 `login_unsupported`。 ``

4. Line 289, change the `notify` config row to `` | `notify` | `channel`（默认渠道，目前可选 `dingtalk`） | ``.

5. Line 295, change to `` - `notify.channel` 是默认渠道；该渠道的行未启用时，未指定 `targets` 的发送报 `channel_unavailable`。 ``

6. After the「通知与钉钉登录」section, add:

   ````markdown
   ### 渠道约定

   每个渠道 Service 都实现 `ChannelService`（从根入口导入类型）：`send()`、`status()`、`health()`，需要登录的身份另外实现 `login()` / `logout()`。接收群内 @ 消息的渠道提供同样三个方法：

   - `onMessage({ conversationId, match?, priority? }, handler)`：按会话注册处理器，每条消息只交给优先级最高的首个匹配处理器；
   - `onPluginMessage(pluginId, handler)`：配合设置页的「会话 → 插件」路由；
   - `unmatchedMessages()`：最近未命中任何路由的消息摘要。

   消息至少包含 `ChannelAtMessage` 的字段：`eventId`、`messageId?`、`conversationId`、`senderId?`、`content`、`timestamp?`，渠道特有字段另加（如钉钉的 `senderOpenDingtalkId`）。正文是外部输入，业务插件必须自行校验。

   ### 从 0.2 升级到 0.3

   - `notify.send()` 返回值由 `{ channel, results }` 改为 `{ deliveries: Array<{ channel, results }> }`。
   - 渠道发送失败（如钉钉 `DingtalkSendError`）不再从 `notify.send()` 抛出，改为出现在对应 `results[i].error` 中。
   - 删除 `notify.use()`；要换默认渠道请改配置，临时发往其他渠道请在 `targets` 中指定。
   - `notify.status()` 返回 `{ defaultChannel, channels }`，不再有 `channel`、`source`。
   - `notify.login()` / `logout()` 必须传入渠道名。
   - 钉钉消息新增 `senderId`（与 `senderOpenDingtalkId` 相同），原有字段不变。
   ````

- [ ] **Step 2: Update the website**

1. In `website/src/pages/docs/notify.mdx`:
   - change the frontmatter title and the `<Base>` title to `通知入口`, and the description to `ctx.notify：业务包发送通知的稳定入口，默认发往配置的默认渠道。`;
   - change the result comment in the code block to `// r: { deliveries: Array<{ channel: 'dingtalk', results: Array<{ ok, messageId?, error? }> }> }`;
   - replace the paragraph starting `业务包只需 inject \`notify\`` with:

     ```
     业务包只需 inject `notify`。启用 `agent-kit-notify` 与 `agent-kit-dingtalk` 两行；notify 的 `channel` 是默认渠道，目前为 `dingtalk`。不写 `targets` 时发往默认渠道并使用其默认目标，写了哪些渠道就只发这些渠道。默认渠道未运行时抛出 `channel_unavailable`；指定的渠道未运行或发送失败，在该渠道的 `results[i].error` 中返回。
     ```

   - replace the `status()` paragraph with:

     ```
     `status()` 返回默认渠道与每个渠道的运行、登录状态；`login(channel)` / `logout(channel)` 必须指定渠道，渠道不需要登录时抛出 `login_unsupported`。`notify` 不 inject 渠道 Service，而是在发送时查找它，因此停用渠道不会卸载只依赖 `notify` 的业务插件。
     ```

2. In `website/src/data/services.ts`, in the `notify` entry:
   - `summary`: `'通知入口：业务包通过 ctx.notify.send() 发送，默认发往配置的默认渠道，也可按调用指定渠道。'`
   - `notes[0]`: `'channel 是默认渠道（目前为 dingtalk）；默认渠道的行需要启用，否则未指定 targets 的 send() 抛出 channel_unavailable。'`
   - `notes[2]`: `'status() 返回默认渠道与各渠道的实时登录状态；login(channel) / logout(channel) 必须指定渠道。'`
   - `errors`: change the `channel_unavailable` meaning to `'未指定 targets 时默认渠道未运行，或 login() / logout() 指定的渠道未运行；指定渠道未运行时作为该渠道的失败结果返回。details.channel 为渠道名。'`; change the `invalid_channel` meaning to `'targets 中出现了未知渠道。'`; add after it `{ code: 'login_unsupported', retryable: '否', meaning: '对不需要登录的渠道（如机器人）调用了 login() / logout()。' }` and `{ code: 'send_failed', retryable: '是', meaning: '渠道 send() 抛出了非 KitError 的异常，作为该渠道的失败结果返回。' }`.

3. In `website/src/data/changelog.ts`, add as the first element of `CHANGELOG`:

   ```ts
   {
     version: '0.3.0',
     date: '2026-10-21',
     items: [
       '新增渠道公共约定 ChannelService 与 ChannelAtMessage，为接入飞书、企业微信做准备；钉钉消息新增 senderId，原有字段不变。',
       '钉钉收件的路由、去重、队列与超时逻辑抽为与渠道无关的 MessageRouter，行为不变。',
       'ctx.notify：未指定 targets 时发往默认渠道，指定了则只发这些渠道并行发送；返回 { deliveries }，单个渠道的失败只出现在它自己的结果中。',
       '删除 notify.use() 运行时切换；status() 改为 { defaultChannel, channels }；login() / logout() 必须指定渠道。',
       'admin：doctor 与 setup 按默认通知渠道检查与配置。',
     ],
   },
   ```

4. Run: `cd website && npx vitest run`
   Expected: PASS (config table and service data tests).

- [ ] **Step 3: Bump the versions**

Run:

```bash
npm version 0.3.0 --no-git-tag-version
cd admin && npm version 0.3.0 --no-git-tag-version
```

Then in `admin/package.json`, change the peer dependency `"@baoyx/dsh-agent-kit": "^0.2.0"` (line 53, the only occurrence) to `"@baoyx/dsh-agent-kit": "^0.3.0"`. `admin/` has no lockfile of its own; the root `npm version` updates `package-lock.json`.

Leave `README.md:7`（npm 上已发布 `0.2.0` 的状态说明）、`README.md:112`/`116`（业务包示例依赖 `^0.2.0`）和 `README.md:424`（路线图）不变：它们描述的是 npm 上已发布的版本，发布 0.3.0 是单独的步骤，发布时再更新。

- [ ] **Step 4: Run everything**

Run:

```bash
npm run typecheck && npx vitest run && npm run build
cd admin && npm run typecheck && npx vitest run && npm run build
cd ../website && npx vitest run
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md website/src package.json package-lock.json admin/package.json
git commit -m "docs: channel contract and notify 0.3 migration; bump to 0.3.0"
```


---

## Self-Review Notes

- Spec coverage:
  - §1 公共约定 → Task 1（类型、`senderId`、`implements`）与 Task 2（`MessageRouter`）。
  - §2 notify → Task 3（配置、发送规则、`deliveries`、删除 `use()`、`status()`、`login`/`logout`、`health()`）。
  - §3 admin → Task 4。
  - §4 错误处理 → Task 3（直接抛错的两种情况、异常转结果、`login_unsupported`），Task 2（handler 错误与超时）。
  - §5 版本与迁移、文档、测试 → Task 5 与各任务的测试步骤。
- Spec additions made explicit in Task 3 Step 12: the `send_failed` code, and that channel send failures no longer throw from `notify.send()`.
- Type names are consistent across tasks: `ChannelService`、`ChannelSendCommon`、`ChannelSendResult`、`ChannelAtMessage`、`ChannelMessageRoute`、`ChannelMessageHandler`、`ChannelMessageSubscription`、`MessageRouter`、`MessageRouterCounts`、`deliver`、`PlannedDelivery`、`NotifyDelivery`、`channelUnavailable`、`requireLogin`、`requireLogout`、`NotifyTargets`、`NotifyAts`。
