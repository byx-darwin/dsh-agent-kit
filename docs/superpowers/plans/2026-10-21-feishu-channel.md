# 飞书渠道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `ctx.feishu`（飞书机器人身份，进程内 SDK，收发都支持），让 `notify` 能发往飞书，并在 admin 设置页、doctor、setup 中与钉钉体验对齐。

**Architecture:** 阶段一（Task 1–5，基础包）：先补公共部件（`ChannelInbox`、通用 `UnmatchedStore`、收件人搜索类型、notify 的 `'default'` 目标），再实现 `src/feishu/`。飞书 SDK 只通过 `src/feishu/sdk.ts` 中的窄接口 `FeishuSdk` 使用：真实实现包装 `@larksuiteoapi/node-sdk`，测试用 `src/testing/fake-feishu.ts` 的假实现，`FeishuService.sdkLoader` 是替换入口。接收用 `MessageRouter`。阶段二（Task 6–9，admin + 文档）：注册飞书行、通用化钉钉的路由与未命中面板、新增 doctor 检查与 setup 引导，最后更新文档。

**Tech Stack:** TypeScript（NodeNext、strict）、cordis 4、schemastery、vitest、React 18（admin 前端）、`@larksuiteoapi/node-sdk` ^1.76.0。

**Spec:** `docs/superpowers/specs/2026-10-21-feishu-channel-design.md`

## Global Constraints

- `@larksuiteoapi/node-sdk` 为可选 peer 依赖，版本 `^1.76.0`；只在 Service 启动时动态加载；未安装时以 `ConfigError` 启动失败。
- loader 行 id `agent-kit-feishu`，Service 名 `feishu`，子路径 `@baoyx/dsh-agent-kit/feishu`，bundle 中默认禁用。
- 飞书配置字段：`appId`（必填）、`appSecretRef`（默认 `FEISHU_APP_SECRET`）、`domain`（`feishu` 默认 / `lark`）、`defaultTarget`（`{ chatId }` 或 `{ openId }`）、`groupRoutes`（默认 `[]`）、`timeoutMs`（默认 15000，范围 [1000, 120000]）、`retry.maxAttempts`（默认 2，范围 [0, 5]）、`dryRun`（默认 false）。
- 飞书 ID 校验：`/^[A-Za-z0-9_-]{1,128}$/` 且不以 `-` 开头；`idempotencyKey` 校验 `/^[A-Za-z0-9._:@-]{1,50}$/`，映射为请求的 `uuid`。
- `FeishuErrorCode`：`invalid_target`、`auth_failed`、`permission_denied`、`rate_limited`、`timeout`、`network`、`api_error`。可重试：`rate_limited`、`timeout`、`network`，以及 HTTP 5xx 时的 `api_error`。缺少正文与钉钉一致记为 `invalid_target`。
- 只在传入 `idempotencyKey` 时重试，退避 `500 * 2 ** attempt` ms（与钉钉一致）。
- 未命中记录：最多 200 条、预览 240 字、文件 0600 / 目录 0700、名称缓存 10 分钟（失败 1 分钟）；飞书文件为 `<profile>/.agent-kit/feishu-unmatched/<sha256(appId) 前 24 位>.json`。
- 三个渠道的会话路由字段都叫 `groupRoutes`，不改名。
- `notify` 的 `targets[channel]` 可为 `'default'`；`'default'` 计入「指定了的渠道」，传给渠道的 `target` 为 `undefined`。
- 钉钉现有字段与方法只增不改；`tests/unit/dingtalk-inbox.test.ts`、`tests/unit/dingtalk.test.ts` 不得修改，必须全部通过。
- 飞书权限：`im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:message.p2p_msg:readonly`。
- 版本保持 0.3.0（未发布）；changelog 的 0.3.0 条目补充飞书。
- 注释、用户可见文案与文档用中文（英文词典同步）。
- 每个任务结束时运行：根目录 `npm run typecheck && npx vitest run`；涉及 admin 时再运行 `cd admin && npm run typecheck && npx vitest run`；涉及官网时再运行 `cd website && npx vitest run`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/common/channel.ts` | 修改 | 新增 `ChannelInbox<M>`、`ChannelRecipientSearchResult`、`ChannelRecipientKind` |
| `src/common/unmatched.ts` | 新建 | 通用 `UnmatchedStore`、`ChannelUnmatchedMessage` |
| `src/dingtalk/unmatched.ts` | 修改 | `DingtalkUnmatchedStore` 变为 `UnmatchedStore` 的薄包装，补出旧字段名 |
| `src/dingtalk/recipients.ts`、`src/dingtalk/service.ts` | 修改 | 类型改为公共别名；`implements ChannelInbox` |
| `src/notify/service.ts` | 修改 | `'default'` 目标；加入 `feishu` 目标类型 |
| `src/common/errors.ts` | 修改 | `ServiceName` 加 `'feishu'` |
| `src/feishu/sdk.ts` | 新建 | 窄接口 `FeishuSdk` 与真实 SDK 适配 |
| `src/feishu/config.ts` | 新建 | `FeishuConfig` |
| `src/feishu/errors.ts` | 新建 | `FeishuSendError`、错误分类 |
| `src/feishu/message.ts` | 新建 | 目标校验、消息体构造（文本 / 卡片） |
| `src/feishu/event.ts` | 新建 | `im.message.receive_v1` 解析为 `FeishuAtMessage` |
| `src/feishu/service.ts` | 新建 | `FeishuService`：发送、接收、状态、搜索、健康 |
| `src/feishu/index.ts` | 新建 | 子路径导出 |
| `src/testing/fake-feishu.ts` | 新建 | 假 SDK 与 `useFakeFeishuSdk` |
| `src/index.ts`、`src/testing/index.ts`、`package.json`、`patch.yml` | 修改 | 导出、依赖、loader 行 |
| `admin/src/profile/kit-entries.ts`、`admin/src/client/remote.ts`、`admin/vitest.config.ts` | 修改 | 注册飞书行 |
| `admin/src/admin/service.ts` | 修改 | 飞书密钥、`channelUnmatched`、`channelSearchRecipients` |
| `admin/src/client/channel-routes.tsx`、`admin/src/client/channel-unmatched.tsx` | 新建（由钉钉面板改名） | 通用面板 |
| `admin/src/client/forms.tsx`、`service-card.tsx`、`settings-page.tsx`、`locale.ts`、`index.tsx` | 修改 | 飞书表单、`feishu-target`、面板接入、文案 |
| `admin/src/feishu-probe.ts` | 新建 | 凭据检查与测试消息（doctor 与 setup 共用） |
| `admin/src/checks/feishu.ts`、`checks/run.ts`、`checks/notify.ts` | 新建 / 修改 | doctor |
| `admin/src/cli/setup.ts`、`cli/messages.ts` | 修改 | setup |
| `README.md`、`website/...` | 修改 | 文档 |

---

## 阶段一：基础包

### Task 1: 公共接收部件 `ChannelInbox` 与通用 `UnmatchedStore`

**Files:**
- Modify: `src/common/channel.ts`
- Create: `src/common/unmatched.ts`
- Modify: `src/dingtalk/unmatched.ts`
- Modify: `src/dingtalk/recipients.ts:1-12`
- Modify: `src/dingtalk/service.ts`（类声明与 `createUnmatchedStore`）
- Modify: `src/index.ts`
- Test: `tests/unit/unmatched-store.test.ts`（新建）

**Interfaces:**
- Consumes: `ChannelAtMessage`、`ChannelMessageRoute`、`ChannelMessageHandler`、`ChannelMessageSubscription`（`src/common/channel.ts`，已有）
- Produces:
  ```ts
  // src/common/channel.ts
  export type ChannelRecipientKind = 'group' | 'user'
  export interface ChannelRecipientSearchResult<T = unknown> { candidates: Array<{ name: string; target: T }>; complete: boolean }
  export interface ChannelInbox<M extends ChannelAtMessage, U extends ChannelUnmatchedMessage = ChannelUnmatchedMessage, T = unknown> {
    onMessage(route: ChannelMessageRoute<M>, handler: ChannelMessageHandler<M>): ChannelMessageSubscription
    onPluginMessage(pluginId: string, handler: ChannelMessageHandler<M>): ChannelMessageSubscription
    unmatchedMessages(): Promise<U[]>
    searchRecipients(kind: ChannelRecipientKind, query: string): Promise<ChannelRecipientSearchResult<T>>
  }
  // src/common/unmatched.ts
  export interface ChannelUnmatchedMessage { eventId: string; messageId?: string; conversationId: string; conversationName?: string; senderId?: string; preview: string; receivedAt: number; timestamp?: number }
  export const UNMATCHED_MAX_RECORDS = 200
  export const UNMATCHED_PREVIEW_LENGTH = 240
  export class UnmatchedStore {
    constructor(file: string | undefined, resolveName: (conversationId: string) => Promise<string | undefined>, onError: (error: unknown) => void, legacy?: (raw: Record<string, unknown>) => Record<string, unknown>)
    list(): Promise<ChannelUnmatchedMessage[]>   // 新记录在前
    add(message: ChannelAtMessage): Promise<void>
  }
  export function unmatchedFileKey(account: string): string // sha256 hex 前 24 位
  ```
  `ChannelUnmatchedMessage` 由 `channel.ts` 以 `import type` 引入（`unmatched.ts` 定义，`channel.ts` 重新导出类型），避免运行时循环。

- [ ] **Step 1: Write the failing test**

Create `tests/unit/unmatched-store.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UnmatchedStore, unmatchedFileKey } from '../../src/common/unmatched.js'
import { DingtalkUnmatchedStore } from '../../src/dingtalk/unmatched.js'
import { until } from '../helpers.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'unmatched-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('UnmatchedStore', () => {
  it('stores bounded previews newest first, dedupes by eventId, and fills in conversation names', async () => {
    const file = join(tmp(), 'x', 'store.json')
    const store = new UnmatchedStore(file, async (id) => (id === 'c1' ? '群一' : undefined), () => {})
    await store.add({ eventId: 'e1', conversationId: 'c1', senderId: 's1', content: '字'.repeat(300), timestamp: 5 })
    await store.add({ eventId: 'e1', conversationId: 'c1', content: 'dup' })
    await store.add({ eventId: 'e2', conversationId: 'c2', content: 'b' })
    await until(async () => (await store.list()).some((r) => r.conversationName === '群一'))
    const items = await store.list()
    expect(items.map((r) => r.eventId)).toEqual(['e2', 'e1'])
    expect(items[1]).toMatchObject({ conversationId: 'c1', conversationName: '群一', senderId: 's1', preview: '字'.repeat(240), timestamp: 5 })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps at most 200 records', async () => {
    const store = new UnmatchedStore(join(tmp(), 's.json'), async () => undefined, () => {})
    for (let i = 0; i < 205; i++) await store.add({ eventId: `e${i}`, conversationId: 'c', content: '' })
    const items = await store.list()
    expect(items).toHaveLength(200)
    expect(items.at(-1)!.eventId).toBe('e5')
  })

  it('derives a stable file key without exposing the account', () => {
    expect(unmatchedFileKey('cli_abc')).toMatch(/^[0-9a-f]{24}$/)
    expect(unmatchedFileKey('cli_abc')).toBe(unmatchedFileKey('cli_abc'))
    expect(unmatchedFileKey('cli_abc')).not.toContain('cli_abc')
  })
})

describe('DingtalkUnmatchedStore compatibility', () => {
  it('reads legacy DingTalk records and exposes both field names', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'd'), { recursive: true })
    const file = join(dir, 'd', 'legacy.json')
    writeFileSync(file, JSON.stringify([{ eventId: 'old', conversationId: 'cidA', groupName: '旧群', senderOpenDingtalkId: 'od1', preview: 'p', receivedAt: 1 }]))
    const store = new DingtalkUnmatchedStore(file, async () => undefined, () => {})
    expect(await store.list()).toEqual([{ eventId: 'old', conversationId: 'cidA', conversationName: '旧群', groupName: '旧群', senderId: 'od1', senderOpenDingtalkId: 'od1', preview: 'p', receivedAt: 1 }])
    await store.add({ eventId: 'new', conversationId: 'cidB', senderId: 'od2', content: 'n' })
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    expect(stored.find((r) => r.eventId === 'new')).toMatchObject({ senderId: 'od2' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/unmatched-store.test.ts`
Expected: FAIL with `Failed to load url ../../src/common/unmatched.js`.

- [ ] **Step 3: Create the generic store**

Create `src/common/unmatched.ts` by moving the body of `src/dingtalk/unmatched.ts` and generalizing it:

```ts
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { restrictWindowsAcl } from '../secrets/credentials-file.js'
import type { ChannelAtMessage } from './channel.js'

export const UNMATCHED_MAX_RECORDS = 200
export const UNMATCHED_PREVIEW_LENGTH = 240
const NAME_TTL_MS = 10 * 60_000
const NAME_RETRY_MS = 60_000

/** 未命中任何路由的消息摘要，供设置页补充路由；正文不会完整落盘。 */
export interface ChannelUnmatchedMessage {
  eventId: string
  messageId?: string
  conversationId: string
  conversationName?: string
  senderId?: string
  preview: string
  receivedAt: number
  timestamp?: number
}

/** 不把明文账号放进文件名。 */
export function unmatchedFileKey(account: string): string {
  return createHash('sha256').update(account).digest('hex').slice(0, 24)
}

function validRecord(value: unknown): value is ChannelUnmatchedMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return typeof r.eventId === 'string' && !!r.eventId && typeof r.conversationId === 'string' && !!r.conversationId &&
    typeof r.preview === 'string' && typeof r.receivedAt === 'number' && Number.isFinite(r.receivedAt) &&
    (r.conversationName === undefined || typeof r.conversationName === 'string') &&
    (r.senderId === undefined || typeof r.senderId === 'string')
}

/**
 * 按渠道、按账号保存最近的未命中消息（最多 200 条，预览 240 字，文件 0600）。
 * `legacy` 把旧格式的记录转换为当前字段，在校验之前调用。
 */
export class UnmatchedStore {
  private items: ChannelUnmatchedMessage[] = []
  private loaded?: Promise<void>
  private writing: Promise<void> = Promise.resolve()
  private readonly names = new Map<string, { name?: string; until: number }>()

  constructor(
    private readonly file: string | undefined,
    private readonly resolveName: (conversationId: string) => Promise<string | undefined>,
    private readonly onError: (error: unknown) => void,
    private readonly legacy: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw,
  ) {}

  private load(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      if (!this.file) return
      try {
        const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(parsed)) throw new Error('invalid unmatched message file')
        this.items = parsed
          .map((raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? this.legacy(raw as Record<string, unknown>) : raw))
          .filter(validRecord)
          .slice(-UNMATCHED_MAX_RECORDS)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error)
      }
    })()
    return this.loaded
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve()
    const snapshot = JSON.stringify(this.items)
    const write = this.writing.catch(() => {}).then(async () => {
      await writeFileAtomic(this.file!, snapshot, { mode: 0o600, dirMode: 0o700 })
      if (process.platform === 'win32') await restrictWindowsAcl(this.file!, { onWarning: this.onError })
    })
    this.writing = write
    return write
  }

  async list(): Promise<ChannelUnmatchedMessage[]> {
    await this.load()
    await this.writing.catch(() => {})
    return this.items.slice().reverse().map((item) => ({ ...item }))
  }

  async add(message: ChannelAtMessage): Promise<void> {
    await this.load()
    if (this.items.some((item) => item.eventId === message.eventId)) return
    const cached = this.names.get(message.conversationId)
    const record: ChannelUnmatchedMessage = {
      eventId: message.eventId,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      conversationId: message.conversationId,
      ...(cached?.name ? { conversationName: cached.name } : {}),
      ...(message.senderId ? { senderId: message.senderId } : {}),
      preview: Array.from(message.content).slice(0, UNMATCHED_PREVIEW_LENGTH).join(''),
      receivedAt: Date.now(),
      ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
    }
    this.items.push(record)
    if (this.items.length > UNMATCHED_MAX_RECORDS) this.items.shift()
    await this.persist()
    if (cached && cached.until > Date.now()) return
    // 会话资料查询失败不影响消息接收或已有的未命中记录。
    this.names.set(message.conversationId, { until: Date.now() + NAME_RETRY_MS })
    void this.resolveName(message.conversationId).then(async (name) => {
      this.names.set(message.conversationId, { name, until: Date.now() + (name ? NAME_TTL_MS : NAME_RETRY_MS) })
      if (!name) return
      for (const item of this.items) if (item.conversationId === message.conversationId) item.conversationName = name
      await this.persist()
    }).catch(this.onError)
  }
}
```

Note: the legacy DingTalk records written before this change have `groupName` / `senderOpenDingtalkId` instead of `conversationName` / `senderId`; the DingTalk wrapper passes a `legacy` mapper. Previously `add()` read `message.senderOpenDingtalkId`; since Task 1 of the previous plan, every parsed DingTalk message carries the same value in `senderId`, so reading `senderId` preserves behavior.

- [ ] **Step 4: Turn `DingtalkUnmatchedStore` into a wrapper**

Replace the whole of `src/dingtalk/unmatched.ts` with:

```ts
import { UnmatchedStore, type ChannelUnmatchedMessage } from '../common/unmatched.js'
import type { DingtalkAtMessage } from './inbox.js'

/** 钉钉的未命中记录：在公共字段之外保留旧字段名 `groupName`、`senderOpenDingtalkId`。 */
export interface DingtalkUnmatchedMessage extends ChannelUnmatchedMessage {
  groupName?: string
  senderOpenDingtalkId?: string
}

function fromLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const { groupName, senderOpenDingtalkId, ...rest } = raw
  return {
    ...rest,
    ...(rest.conversationName === undefined && typeof groupName === 'string' ? { conversationName: groupName } : {}),
    ...(rest.senderId === undefined && typeof senderOpenDingtalkId === 'string' ? { senderId: senderOpenDingtalkId } : {}),
  }
}

function withLegacyNames(record: ChannelUnmatchedMessage): DingtalkUnmatchedMessage {
  return {
    ...record,
    ...(record.conversationName !== undefined ? { groupName: record.conversationName } : {}),
    ...(record.senderId !== undefined ? { senderOpenDingtalkId: record.senderId } : {}),
  }
}

export class DingtalkUnmatchedStore {
  private readonly store: UnmatchedStore

  constructor(
    file: string | undefined,
    resolveName: (conversationId: string) => Promise<string | undefined>,
    onError: (error: unknown) => void,
  ) {
    this.store = new UnmatchedStore(file, resolveName, onError, fromLegacy)
  }

  async list(): Promise<DingtalkUnmatchedMessage[]> {
    return (await this.store.list()).map(withLegacyNames)
  }

  add(message: DingtalkAtMessage): Promise<void> {
    return this.store.add(message)
  }
}
```

In `src/dingtalk/service.ts` `createUnmatchedStore()`, replace the inline key computation

```ts
    const key = profile ? createHash('sha256').update(profile).digest('hex').slice(0, 24) : undefined
```

with

```ts
    const key = profile ? unmatchedFileKey(profile) : undefined
```

import `unmatchedFileKey` from `'../common/unmatched.js'`, and remove the `createHash` import if nothing else in the file uses it (`grep -n createHash src/dingtalk/service.ts`).

- [ ] **Step 5: Add `ChannelInbox` and the recipient search types**

Append to `src/common/channel.ts`:

```ts
import type { ChannelUnmatchedMessage } from './unmatched.js'
export type { ChannelUnmatchedMessage } from './unmatched.js'

export type ChannelRecipientKind = 'group' | 'user'

export interface ChannelRecipientSearchResult<T = unknown> {
  candidates: Array<{ name: string; target: T }>
  /** false 表示渠道没有证明已返回全部候选。 */
  complete: boolean
}

/** 接收群内 @ 消息的渠道都实现的约定。 */
export interface ChannelInbox<M extends ChannelAtMessage, U extends ChannelUnmatchedMessage = ChannelUnmatchedMessage, T = unknown> {
  onMessage(route: ChannelMessageRoute<M>, handler: ChannelMessageHandler<M>): ChannelMessageSubscription
  onPluginMessage(pluginId: string, handler: ChannelMessageHandler<M>): ChannelMessageSubscription
  /** 最近未命中任何路由的消息摘要，新记录在前。 */
  unmatchedMessages(): Promise<U[]>
  /** 按名称查找可作为发送目标的群或个人；只返回候选，不自动选择。 */
  searchRecipients(kind: ChannelRecipientKind, query: string): Promise<ChannelRecipientSearchResult<T>>
}
```

(Move the two `import type` lines to the top of the file with the other imports.)

In `src/dingtalk/recipients.ts`, replace

```ts
export type DingtalkRecipientKind = 'group' | 'user'
```

with

```ts
import type { ChannelRecipientKind, ChannelRecipientSearchResult } from '../common/channel.js'

export type DingtalkRecipientKind = ChannelRecipientKind
```

and replace the `DingtalkRecipientSearchResult` interface with

```ts
/** `complete` 为 false 表示 DWS 没有证明已返回全部候选。 */
export type DingtalkRecipientSearchResult = ChannelRecipientSearchResult<DingtalkRecipientTarget>
```

Keep `DingtalkRecipientCandidate` as is (it still matches `{ name; target: DingtalkRecipientTarget }`).

In `src/dingtalk/service.ts`, extend the class declaration:

```ts
export class DingtalkService extends KitService<DingtalkCounters>
  implements ChannelService<DingtalkTarget, DingtalkAt>, ChannelInbox<DingtalkAtMessage, DingtalkUnmatchedMessage, DingtalkRecipientTarget> {
```

importing `ChannelInbox` from `'../common/channel.js'` and `DingtalkRecipientTarget` from `'./recipients.js'` (add to the existing imports).

- [ ] **Step 6: Export the new public types**

In `src/index.ts`, add to the `export type { … } from './common/channel.js'` block: `ChannelInbox`, `ChannelRecipientKind`, `ChannelRecipientSearchResult`, `ChannelUnmatchedMessage`.

- [ ] **Step 7: Run tests**

Run: `npm run typecheck && npx vitest run`
Expected: all pass, including the unchanged `tests/unit/dingtalk-inbox.test.ts` (its `groupName` assertions are served by `withLegacyNames`).

- [ ] **Step 8: Commit**

```bash
git add src/common src/dingtalk src/index.ts tests/unit/unmatched-store.test.ts
git commit -m "refactor(channel): shared ChannelInbox contract and channel-agnostic UnmatchedStore"
```

---

### Task 2: notify 的 `'default'` 目标标记

**Files:**
- Modify: `src/notify/service.ts`（`NotifyTargets`、`send()`）
- Test: `tests/unit/notify.test.ts`

**Interfaces:**
- Consumes: `NotifyService.send()`（已有）
- Produces: `NotifyTargets = { dingtalk?: DingtalkTarget | 'default' }`（Task 5 再加入 `feishu`）；导出常量 `DEFAULT_TARGET = 'default' as const`（`src/notify/service.ts`，经 `src/notify/index.ts` 导出）。

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/notify.test.ts` inside `describe('NotifyService', …)`:

```ts
  it("treats 'default' as naming the channel while letting it use its own default target", async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const r = await notify.send({ text: 'hello', targets: { dingtalk: 'default' } })
    expect(r.deliveries).toMatchObject([{ channel: 'dingtalk', results: [{ ok: true }] }])
    expect(dws.calls().some((call) => call.args.some((a) => a.includes('cidA')))).toBe(true)
  })

  it("reports a channel named with 'default' that is not running as a failed delivery instead of throwing", async () => {
    await root.root.plugin(NotifyService, { channel: 'dingtalk' })
    const notify = root.root.get('notify')!
    const r = await notify.send({ text: 'hello', targets: { dingtalk: 'default' } })
    expect(r.deliveries).toEqual([{ channel: 'dingtalk', results: [{ ok: false, error: expect.objectContaining({ code: 'channel_unavailable' }) }] }])
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/notify.test.ts && npm run typecheck`
Expected: typecheck FAIL (`Type '"default"' is not assignable to type 'DingtalkTarget'`); at runtime the first new test fails because `'default'` reaches `buildSendArgs` as a target.

- [ ] **Step 3: Implement**

In `src/notify/service.ts`:

```ts
/** `targets` 中某渠道写 `'default'`：发往该渠道，并使用其配置的默认目标。 */
export const DEFAULT_TARGET = 'default' as const

/** 按渠道给出的发送目标；写 `'default'` 时该渠道使用自己配置的默认目标。 */
export interface NotifyTargets {
  dingtalk?: DingtalkTarget | typeof DEFAULT_TARGET
}
```

and in `send()`, change the plan construction so `'default'` becomes `undefined`:

```ts
    const targets = options.targets as Partial<Record<NotifyChannel, unknown>> | undefined
    const ats = options.at as Partial<Record<NotifyChannel, unknown>> | undefined
    const deliveries = await deliver(
      channels.map((channel) => {
        const target = targets?.[channel]
        return { channel, service: this.service(channel), target: target === DEFAULT_TARGET ? undefined : target, at: ats?.[channel] }
      }),
      common,
    )
```

(Replace the existing `channels.map(...)` argument of `deliver`; keep everything else.) Update the doc comment on `NotifySendOptions.targets` to: `/** 写了哪些渠道就只发这些渠道（值可为 'default'）；缺省或为空时发往默认渠道。 */`.

Export `DEFAULT_TARGET` from `src/notify/index.ts` and `src/index.ts` (add next to `NOTIFY_CHANNELS`).

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/notify src/index.ts tests/unit/notify.test.ts
git commit -m "feat(notify): 'default' target marker to name a channel without overriding its target"
```

---

### Task 3: 飞书发送（SDK 接缝、假 SDK、配置、错误、消息体、`send` / `status`）

**Files:**
- Modify: `src/common/errors.ts:3`（`ServiceName`）
- Create: `src/feishu/sdk.ts`、`src/feishu/config.ts`、`src/feishu/errors.ts`、`src/feishu/message.ts`、`src/feishu/service.ts`、`src/feishu/index.ts`
- Create: `src/testing/fake-feishu.ts`
- Modify: `src/testing/index.ts`
- Modify: `package.json`（devDependency）
- Test: `tests/unit/feishu-send.test.ts`

**Interfaces:**
- Consumes: `ChannelService`、`ChannelSendCommon`、`ChannelSendResult`、`ChannelStatus`（`src/common/channel.ts`）；`KitService`、`ServiceHealth`；`ConfigError`、`KitError`；`resolveSecretRef`（`src/secrets/index.ts`）；`registerSecret`、`digest`、`redact`
- Produces:
  ```ts
  // src/feishu/sdk.ts
  export interface FeishuApiResponse<T = unknown> { code?: number; msg?: string; data?: T }
  export interface FeishuCreateMessageRequest { params: { receive_id_type: 'chat_id' | 'open_id' }; data: { receive_id: string; msg_type: 'text' | 'interactive'; content: string; uuid?: string } }
  export interface FeishuClient {
    createMessage(req: FeishuCreateMessageRequest, signal: AbortSignal): Promise<FeishuApiResponse<{ message_id?: string }>>
    searchChats(query: string, signal: AbortSignal): Promise<FeishuApiResponse<{ items?: Array<{ chat_id?: string; name?: string }>; has_more?: boolean }>>
    getChat(chatId: string, signal: AbortSignal): Promise<FeishuApiResponse<{ name?: string }>>
    botInfo(signal: AbortSignal): Promise<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>
  }
  export interface FeishuWsHandlers { onReady(): void; onError(error: Error): void; onReconnecting(): void; onReconnected(): void; onMessage(event: unknown): void }
  export interface FeishuWs { close(): void }
  export interface FeishuSdkOptions { appId: string; appSecret: string; domain: 'feishu' | 'lark'; logger: KitLogger }
  export interface FeishuSdk { createClient(o: FeishuSdkOptions): FeishuClient; startWs(o: FeishuSdkOptions, handlers: FeishuWsHandlers): FeishuWs }
  export type FeishuSdkLoader = () => Promise<FeishuSdk>
  export const loadFeishuSdk: FeishuSdkLoader
  // src/feishu/config.ts
  export type FeishuTarget = { chatId: string } | { openId: string }
  export interface FeishuConfig { appId: string; appSecretRef: string; domain: 'feishu' | 'lark'; defaultTarget?: FeishuTarget; groupRoutes: Array<{ conversationId: string; pluginId: string }>; timeoutMs: number; retry: { maxAttempts: number }; dryRun: boolean }
  export const FeishuConfig: z<ConfigInput<FeishuConfig>, FeishuConfig>
  export const FEISHU_APP_SECRET_REF = 'FEISHU_APP_SECRET'
  // src/feishu/errors.ts
  export type FeishuErrorCode = 'invalid_target' | 'auth_failed' | 'permission_denied' | 'rate_limited' | 'timeout' | 'network' | 'api_error'
  export class FeishuSendError extends KitError { constructor(code: FeishuErrorCode, message: string, options?: KitErrorOptions) }
  export function classifyApiCode(code: number, msg: string): FeishuSendError
  export function classifyThrown(e: unknown): FeishuSendError
  // src/feishu/message.ts
  export interface FeishuAt { openIds?: string[]; all?: boolean }
  export function buildCreateMessage(input: { target?: FeishuTarget; title?: string; markdown?: string; text?: string; at?: FeishuAt; idempotencyKey?: string }): FeishuCreateMessageRequest
  export function assertFeishuId(kind: string, value: unknown): string
  // src/feishu/service.ts
  export interface FeishuSendOptions extends ChannelSendCommon { target?: FeishuTarget; at?: FeishuAt }
  export class FeishuService extends KitService<FeishuCounters> implements ChannelService<FeishuTarget, FeishuAt> {
    static Config: typeof FeishuConfig
    static sdkLoader: FeishuSdkLoader
    static keyStore: Pick<KeyStoreOptions, 'credentialsFile' | 'env'>
    send(o: FeishuSendOptions): Promise<{ results: Array<{ ok: boolean; messageId?: string; error?: FeishuSendError }> }>
    status(): Promise<ChannelStatus>
    health(): ServiceHealth<FeishuCounters>
  }
  // src/testing/fake-feishu.ts
  export interface FakeFeishuSendStep { code?: number; msg?: string; messageId?: string; throw?: 'network' | 'timeout' | { status: number } }
  export interface FakeFeishu { sdk: FeishuSdk; sends: FeishuCreateMessageRequest[]; setSend(steps: FakeFeishuSendStep[]): void; emit(event: unknown): Promise<void>; ready(): void; reconnecting(): void; reconnected(): void; error(error: Error): void; closed(): boolean; started(): number }
  export function createFakeFeishuSdk(options?: { botName?: string; botOpenId?: string; chats?: Array<{ chatId: string; name: string }>; send?: FakeFeishuSendStep[]; authCode?: number }): FakeFeishu
  export function useFakeFeishuSdk(fake: FakeFeishu): () => void
  ```

- [ ] **Step 1: Install the SDK as a dev dependency and widen `ServiceName`**

Run: `npm install --save-dev @larksuiteoapi/node-sdk@^1.76.0`

In `src/common/errors.ts` line 3, add `'feishu'`:

```ts
export type ServiceName = 'agentWs' | 'dingtalk' | 'feishu' | 'notify' | 'agentTasks' | 'jev' | 'kit'
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/feishu-send.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FeishuService } from '../../src/feishu/service.js'
import { buildCreateMessage } from '../../src/feishu/message.js'
import { createFakeFeishuSdk, useFakeFeishuSdk, type FakeFeishu } from '../../src/testing/fake-feishu.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('buildCreateMessage', () => {
  it('builds a text message with mentions appended', () => {
    const r = buildCreateMessage({ target: { chatId: 'oc_1' }, text: 'hi', at: { openIds: ['ou_a'], all: true }, idempotencyKey: 'evt-1' })
    expect(r.params.receive_id_type).toBe('chat_id')
    expect(r.data).toMatchObject({ receive_id: 'oc_1', msg_type: 'text', uuid: 'evt-1' })
    expect(JSON.parse(r.data.content)).toEqual({ text: 'hi <at user_id="ou_a"></at> <at user_id="all"></at>' })
  })

  it('builds a markdown card with a title and card-style mentions', () => {
    const r = buildCreateMessage({ target: { openId: 'ou_x' }, title: '告警', markdown: '**down**', at: { openIds: ['ou_a'] } })
    expect(r.params.receive_id_type).toBe('open_id')
    expect(r.data.msg_type).toBe('interactive')
    expect(JSON.parse(r.data.content)).toEqual({
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '告警' } },
      body: { elements: [{ tag: 'markdown', content: '**down** <at id=ou_a></at>' }] },
    })
  })

  it('rejects bad targets, bad keys, and missing or doubled bodies', () => {
    expect(() => buildCreateMessage({ text: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: '-oc' }, text: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: 'oc_1' } })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: 'oc_1' }, text: 'a', markdown: 'b' })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: 'oc_1' }, text: 'a', idempotencyKey: 'x'.repeat(51) })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
    expect(() => buildCreateMessage({ target: { chatId: 'oc_1' }, text: 'a', at: { openIds: ['bad id'] } })).toThrow(expect.objectContaining({ code: 'invalid_target' }))
  })
})

describe('FeishuService send', () => {
  let root: TestRoot
  let fake: FakeFeishu
  let restore: () => void
  const savedEnv = { ...process.env }
  const config = { appId: 'cli_test', defaultTarget: { chatId: 'oc_default' } }

  beforeEach(() => {
    root = createRoot()
    process.env.FEISHU_APP_SECRET = 'secret-value'
    fake = createFakeFeishuSdk({ botName: '告警机器人', botOpenId: 'ou_bot' })
    restore = useFakeFeishuSdk(fake)
  })
  afterEach(async () => {
    await root.dispose()
    restore()
    process.env = { ...savedEnv }
  })

  it('sends to the default target and returns the message id', async () => {
    await root.root.plugin(FeishuService, config)
    const r = await root.root.get('feishu')!.send({ text: 'hello' })
    expect(r.results).toEqual([{ ok: true, messageId: 'om_1' }])
    expect(fake.sends[0]!.data.receive_id).toBe('oc_default')
  })

  it('maps API error codes and only retries with an idempotency key', async () => {
    await root.root.plugin(FeishuService, { ...config, retry: { maxAttempts: 1 } })
    const feishu = root.root.get('feishu')!
    fake.setSend([{ code: 99991400, msg: 'rate limited' }, { messageId: 'om_2' }])
    expect((await feishu.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'rate_limited', retryable: true } })
    fake.setSend([{ code: 99991400, msg: 'rate limited' }, { messageId: 'om_3' }])
    expect((await feishu.send({ text: 'x', idempotencyKey: 'k1' })).results).toEqual([{ ok: true, messageId: 'om_3' }])
    fake.setSend([{ code: 230002, msg: 'bot not in chat' }])
    expect((await feishu.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'permission_denied', retryable: false } })
    fake.setSend([{ throw: { status: 503 } }])
    expect((await feishu.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'api_error', retryable: true } })
    fake.setSend([{ throw: 'network' }])
    expect((await feishu.send({ text: 'x' })).results[0]).toMatchObject({ ok: false, error: { code: 'network', retryable: true } })
    expect(feishu.health()).toMatchObject({ status: 'degraded' })
  })

  it('throws on invalid input instead of returning a result', async () => {
    await root.root.plugin(FeishuService, config)
    await expect(root.root.get('feishu')!.send({ text: 'x', target: { chatId: 'has space' } })).rejects.toMatchObject({ code: 'invalid_target' })
  })

  it('does not call the API in dryRun', async () => {
    await root.root.plugin(FeishuService, { ...config, dryRun: true })
    expect((await root.root.get('feishu')!.send({ text: 'x' })).results).toEqual([{ ok: true }])
    expect(fake.sends).toHaveLength(0)
  })

  it('reports bot identity and online state, and has no login', async () => {
    await root.root.plugin(FeishuService, config)
    const feishu = root.root.get('feishu')!
    expect(await feishu.status()).toMatchObject({ channel: 'feishu', identity: 'bot', online: false, account: '告警机器人' })
    fake.ready()
    expect(await feishu.status()).toMatchObject({ online: true })
    expect('login' in feishu).toBe(false)
  })

  it('fails to start without appId or a resolvable secret', async () => {
    delete process.env.FEISHU_APP_SECRET
    FeishuService.keyStore = { credentialsFile: '/nonexistent/credentials.yaml' }
    try {
      await root.root.plugin(FeishuService, config)
      expect(root.failures.some((f) => f.service === 'feishu') || root.root.get('feishu') === undefined).toBe(true)
    } finally {
      FeishuService.keyStore = {}
    }
  })
})
```

Note on the last test: check how a failing `[Service.init]` surfaces in this repo's tests before finalizing the assertion — `grep -n "rejects\|failures" tests/unit/jev.test.ts | head` and follow the same pattern the jev tests use for a missing key; replace the assertion with that pattern if it differs.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/feishu-send.test.ts`
Expected: FAIL with `Failed to load url ../../src/feishu/service.js`.

- [ ] **Step 4: Implement `src/feishu/sdk.ts`**

```ts
import { ConfigError } from '../common/errors.js'
import type { KitLogger } from '../common/logger.js'

export interface FeishuApiResponse<T = unknown> {
  code?: number
  msg?: string
  data?: T
}

export interface FeishuCreateMessageRequest {
  params: { receive_id_type: 'chat_id' | 'open_id' }
  data: { receive_id: string; msg_type: 'text' | 'interactive'; content: string; uuid?: string }
}

/** 本包用到的飞书接口；真实实现包装 @larksuiteoapi/node-sdk，测试用假实现。 */
export interface FeishuClient {
  createMessage(req: FeishuCreateMessageRequest, signal: AbortSignal): Promise<FeishuApiResponse<{ message_id?: string }>>
  searchChats(query: string, signal: AbortSignal): Promise<FeishuApiResponse<{ items?: Array<{ chat_id?: string; name?: string }>; has_more?: boolean }>>
  getChat(chatId: string, signal: AbortSignal): Promise<FeishuApiResponse<{ name?: string }>>
  botInfo(signal: AbortSignal): Promise<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>
}

export interface FeishuWsHandlers {
  onReady(): void
  onError(error: Error): void
  onReconnecting(): void
  onReconnected(): void
  /** `im.message.receive_v1` 事件；必须同步返回（飞书要求 3 秒内处理完）。 */
  onMessage(event: unknown): void
}

export interface FeishuWs {
  close(): void
}

export interface FeishuSdkOptions {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  logger: KitLogger
}

export interface FeishuSdk {
  createClient(options: FeishuSdkOptions): FeishuClient
  startWs(options: FeishuSdkOptions, handlers: FeishuWsHandlers): FeishuWs
}

export type FeishuSdkLoader = () => Promise<FeishuSdk>

/** 默认从 @larksuiteoapi/node-sdk 加载（可选 peer，只在启用 feishu 时加载）。 */
export const loadFeishuSdk: FeishuSdkLoader = async () => {
  let lark: typeof import('@larksuiteoapi/node-sdk')
  try {
    lark = await import('@larksuiteoapi/node-sdk')
  } catch (e) {
    throw new ConfigError('feishu', '@larksuiteoapi/node-sdk is not installed; it is required when the feishu service is enabled', { cause: (e as Error).message })
  }
  const domainOf = (d: 'feishu' | 'lark') => (d === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu)
  // SDK 的 logger 接口为 error/warn/info/debug/trace(...msg)；统一转到已脱敏的 KitLogger
  const bridge = (logger: KitLogger) => ({
    error: (...m: unknown[]) => logger.error('feishu sdk', { message: m.map(String).join(' ') }),
    warn: (...m: unknown[]) => logger.warn('feishu sdk', { message: m.map(String).join(' ') }),
    info: (...m: unknown[]) => logger.debug('feishu sdk', { message: m.map(String).join(' ') }),
    debug: (...m: unknown[]) => logger.debug('feishu sdk', { message: m.map(String).join(' ') }),
    trace: () => {},
  })
  return {
    createClient({ appId, appSecret, domain, logger }) {
      const client = new lark.Client({ appId, appSecret, domain: domainOf(domain), logger: bridge(logger), loggerLevel: lark.LoggerLevel.warn })
      return {
        createMessage: (req) => client.im.v1.message.create(req) as Promise<FeishuApiResponse<{ message_id?: string }>>,
        searchChats: (query) => client.im.v1.chat.search({ params: { query, page_size: 20 } }) as Promise<FeishuApiResponse<{ items?: Array<{ chat_id?: string; name?: string }>; has_more?: boolean }>>,
        getChat: (chatId) => client.im.v1.chat.get({ path: { chat_id: chatId } }) as Promise<FeishuApiResponse<{ name?: string }>>,
        botInfo: () => client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }) as Promise<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>,
      }
    },
    startWs({ appId, appSecret, domain, logger }, handlers) {
      const ws = new lark.WSClient({
        appId,
        appSecret,
        domain: domainOf(domain),
        logger: bridge(logger),
        loggerLevel: lark.LoggerLevel.warn,
        onReady: handlers.onReady,
        onError: handlers.onError,
        onReconnecting: handlers.onReconnecting,
        onReconnected: handlers.onReconnected,
      })
      void ws.start({
        eventDispatcher: new lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data: unknown) => { handlers.onMessage(data) },
        }),
      })
      return { close: () => ws.close() }
    },
  }
}
```

The `signal` parameters are accepted for interface symmetry; the real adapter does not forward them (the SDK request API has no abort option), and the service enforces timeouts itself. Verify each SDK call against `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts` (`grep -n "class WSClient\|class EventDispatcher\|request<\|Domain\b" node_modules/@larksuiteoapi/node-sdk/types/index.d.ts | head`). If a member name or shape differs (for example `client.im.message.create` vs `client.im.v1.message.create`, or the `logger` method set), fix it **here in the adapter only**; the `FeishuSdk` interface and the service must not change. If the SDK types make a cast in this file necessary, cast at the call site.

- [ ] **Step 5: Implement `src/feishu/config.ts`**

```ts
import z from '@deepseek-ai/schemastery'
import type { ConfigInput } from '../common/errors.js'

export const FEISHU_APP_SECRET_REF = 'FEISHU_APP_SECRET'

export type FeishuTarget = { chatId: string } | { openId: string }

export interface FeishuConfig {
  appId: string
  /** App Secret 的密钥引用：先读同名环境变量，再读 dsh 凭据文件。 */
  appSecretRef: string
  domain: 'feishu' | 'lark'
  defaultTarget?: FeishuTarget
  /** 会话 ID（群或单聊）到业务插件 ID 的一对一路由。 */
  groupRoutes: Array<{ conversationId: string; pluginId: string }>
  timeoutMs: number
  retry: { maxAttempts: number }
  dryRun: boolean
}

const int = () => z.natural().step(1)

const Target = z.union([
  z.object({ chatId: z.string().required() }),
  z.object({ openId: z.string().required() }),
])

export const FeishuConfig: z<ConfigInput<FeishuConfig>, FeishuConfig> = z.object({
  appId: z.string().required().description('飞书自建应用的 App ID'),
  appSecretRef: z.string().default(FEISHU_APP_SECRET_REF).description('App Secret 的密钥引用：先读同名环境变量，再读 dsh 凭据文件'),
  domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu').description('feishu 为飞书，lark 为国际版 Lark'),
  defaultTarget: Target.description('省略 target 时使用'),
  groupRoutes: z.array(z.object({ conversationId: z.string().required(), pluginId: z.string().required() })).default([]).description('会话 ID（群或单聊）到业务插件 ID 的一对一路由；可在 Agent Kit 设置页配置'),
  timeoutMs: int().min(1000).max(120_000).default(15_000).description('单次发送超时（毫秒）'),
  retry: z.object({ maxAttempts: int().max(5).default(2) }).default({ maxAttempts: 2 }).description('传入 idempotencyKey 时的重试次数'),
  dryRun: z.boolean().default(false).description('只记日志，不调用飞书接口'),
}) as z<ConfigInput<FeishuConfig>, FeishuConfig>
```

- [ ] **Step 6: Implement `src/feishu/errors.ts`**

```ts
import { KitError, type KitErrorOptions } from '../common/errors.js'

export type FeishuErrorCode = 'invalid_target' | 'auth_failed' | 'permission_denied' | 'rate_limited' | 'timeout' | 'network' | 'api_error'

const RETRYABLE: ReadonlySet<FeishuErrorCode> = new Set(['rate_limited', 'timeout', 'network'])

export class FeishuSendError extends KitError {
  declare readonly code: FeishuErrorCode

  constructor(code: FeishuErrorCode, message: string, options: KitErrorOptions = {}) {
    super('feishu', code, message, { retryable: options.retryable ?? RETRYABLE.has(code), ...options })
    this.name = 'FeishuSendError'
  }
}

/**
 * 飞书错误码 → 分类。数字来自开放平台通用错误码与「发送消息」接口错误码表：
 * https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
 * https://open.feishu.cn/document/server-docs/im-v1/message/create
 */
const API_CODES: Record<number, FeishuErrorCode> = {
  99991661: 'auth_failed', // tenant_access_token 缺失
  99991663: 'auth_failed', // tenant_access_token 无效
  99991664: 'auth_failed',
  99991665: 'auth_failed',
  10003: 'auth_failed', // app_id / app_secret 错误
  99991672: 'permission_denied', // 应用未开通所需权限
  99991400: 'rate_limited', // 请求频率超限
  230020: 'rate_limited', // 发送消息频率超限
  230002: 'permission_denied', // 机器人不在群里
  230006: 'permission_denied', // 机器人能力未启用
  230027: 'permission_denied', // 缺少权限
  230001: 'invalid_target', // 参数错误
  230013: 'invalid_target', // 接收方不在可见范围
  230099: 'invalid_target', // 消息内容不合法
}

export function classifyApiCode(code: number, msg: string): FeishuSendError {
  const kind = API_CODES[code] ?? 'api_error'
  return new FeishuSendError(kind, `feishu api error ${code}: ${msg}`, { details: { apiCode: code } })
}

/** SDK 抛出的异常（axios 风格）→ 分类。 */
export function classifyThrown(e: unknown): FeishuSendError {
  if (e instanceof FeishuSendError) return e
  const err = e as { name?: string; code?: string; message?: string; response?: { status?: number; data?: { code?: number; msg?: string } } }
  const status = err?.response?.status
  const apiCode = err?.response?.data?.code
  if (typeof apiCode === 'number' && apiCode !== 0) return classifyApiCode(apiCode, err.response?.data?.msg ?? '')
  if (status === 429) return new FeishuSendError('rate_limited', 'feishu rate limited (HTTP 429)', { cause: e })
  if (status === 401) return new FeishuSendError('auth_failed', 'feishu authentication failed (HTTP 401)', { cause: e })
  if (status === 403) return new FeishuSendError('permission_denied', 'feishu permission denied (HTTP 403)', { cause: e })
  if (typeof status === 'number') return new FeishuSendError('api_error', `feishu HTTP ${status}`, { retryable: status >= 500, cause: e })
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
    return new FeishuSendError('timeout', 'feishu request timed out', { cause: e })
  }
  return new FeishuSendError('network', `feishu request failed: ${err?.message ?? String(e)}`, { cause: e })
}
```

Before committing, open the two documentation pages named in the comment and check every number in `API_CODES`. Correct any number that maps to a different meaning; add an entry only if it is listed on those pages. Keep the categories.

- [ ] **Step 7: Implement `src/feishu/message.ts`**

```ts
import type { FeishuTarget } from './config.js'
import { FeishuSendError } from './errors.js'
import type { FeishuCreateMessageRequest } from './sdk.js'

export interface FeishuAt {
  /** 要 @ 的用户 open_id。 */
  openIds?: string[]
  all?: boolean
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
const KEY = /^[A-Za-z0-9._:@-]{1,50}$/

export function assertFeishuId(kind: string, value: unknown): string {
  if (typeof value !== 'string' || value.startsWith('-') || !ID.test(value)) {
    throw new FeishuSendError('invalid_target', `invalid ${kind}`, { details: { kind } })
  }
  return value
}

function mentions(at: FeishuAt | undefined, card: boolean): string {
  const ids = (at?.openIds ?? []).map((id) => assertFeishuId('openId', id))
  if (at?.all) ids.push('all')
  return ids.map((id) => (card ? `<at id=${id}></at>` : `<at user_id="${id}"></at>`)).join(' ')
}

const join = (body: string, extra: string) => (extra ? `${body} ${extra}` : body)

/** 文本发 `text` 消息；Markdown 发卡片（`interactive`），`title` 作卡片标题。 */
export function buildCreateMessage(input: {
  target?: FeishuTarget
  title?: string
  markdown?: string
  text?: string
  at?: FeishuAt
  idempotencyKey?: string
}): FeishuCreateMessageRequest {
  if (!input.target) throw new FeishuSendError('invalid_target', 'target is required')
  if (input.markdown !== undefined && input.text !== undefined) throw new FeishuSendError('invalid_target', 'markdown and text are mutually exclusive')
  if (input.markdown === undefined && input.text === undefined) throw new FeishuSendError('invalid_target', 'either markdown or text is required')
  const [receive_id_type, receive_id] = 'chatId' in input.target
    ? ['chat_id' as const, assertFeishuId('chatId', input.target.chatId)]
    : ['open_id' as const, assertFeishuId('openId', input.target.openId)]
  if (input.idempotencyKey !== undefined && !KEY.test(input.idempotencyKey)) {
    throw new FeishuSendError('invalid_target', 'invalid idempotencyKey', { details: { kind: 'idempotencyKey' } })
  }
  const uuid = input.idempotencyKey !== undefined ? { uuid: input.idempotencyKey } : {}
  if (input.markdown !== undefined) {
    const card = {
      schema: '2.0',
      ...(input.title ? { header: { title: { tag: 'plain_text', content: input.title } } } : {}),
      body: { elements: [{ tag: 'markdown', content: join(input.markdown, mentions(input.at, true)) }] },
    }
    return { params: { receive_id_type }, data: { receive_id, msg_type: 'interactive', content: JSON.stringify(card), ...uuid } }
  }
  const body = input.title ? `${input.title}\n${input.text}` : input.text!
  return { params: { receive_id_type }, data: { receive_id, msg_type: 'text', content: JSON.stringify({ text: join(body, mentions(input.at, false)) }), ...uuid } }
}
```

- [ ] **Step 8: Implement the fake SDK**

Create `src/testing/fake-feishu.ts`:

```ts
import { FeishuService } from '../feishu/service.js'
import type { FeishuClient, FeishuCreateMessageRequest, FeishuSdk, FeishuWsHandlers } from '../feishu/sdk.js'

export interface FakeFeishuSendStep {
  code?: number
  msg?: string
  messageId?: string
  throw?: 'network' | 'timeout' | { status: number }
}

export interface FakeFeishu {
  sdk: FeishuSdk
  /** 每次 createMessage 的请求，按调用顺序。 */
  sends: FeishuCreateMessageRequest[]
  /** 按调用次序取，用完后重复最后一个；默认每次成功。 */
  setSend(steps: FakeFeishuSendStep[]): void
  /** 推送一条 `im.message.receive_v1` 事件。 */
  emit(event: unknown): Promise<void>
  ready(): void
  reconnecting(): void
  reconnected(): void
  error(error: Error): void
  closed(): boolean
  /** startWs 被调用的次数。 */
  started(): number
}

export function createFakeFeishuSdk(options: {
  botName?: string
  botOpenId?: string
  chats?: Array<{ chatId: string; name: string }>
  send?: FakeFeishuSendStep[]
  /** 非 0 时 botInfo 返回该错误码（模拟凭据错误）。 */
  authCode?: number
} = {}): FakeFeishu {
  let steps: FakeFeishuSendStep[] = options.send ?? []
  let calls = 0
  let handlers: FeishuWsHandlers | undefined
  let closed = false
  let started = 0
  const sends: FeishuCreateMessageRequest[] = []
  const chats = options.chats ?? []
  const client: FeishuClient = {
    async createMessage(req) {
      sends.push(req)
      const step = steps.length ? steps[Math.min(calls, steps.length - 1)]! : {}
      calls++
      if (step.throw === 'network') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      if (step.throw === 'timeout') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
      if (step.throw) throw Object.assign(new Error(`HTTP ${step.throw.status}`), { response: { status: step.throw.status } })
      if (step.code) return { code: step.code, msg: step.msg ?? 'error' }
      return { code: 0, msg: 'ok', data: { message_id: step.messageId ?? `om_${sends.length}` } }
    },
    async searchChats(query) {
      return { code: 0, data: { items: chats.filter((c) => c.name.includes(query)).map((c) => ({ chat_id: c.chatId, name: c.name })), has_more: false } }
    },
    async getChat(chatId) {
      const chat = chats.find((c) => c.chatId === chatId)
      return chat ? { code: 0, data: { name: chat.name } } : { code: 230001, msg: 'not found' }
    },
    async botInfo() {
      if (options.authCode) return { code: options.authCode, msg: 'invalid app credential' }
      return { code: 0, bot: { app_name: options.botName ?? 'fake bot', open_id: options.botOpenId ?? 'ou_bot' } }
    },
  }
  const need = () => {
    if (!handlers) throw new Error('fake feishu: startWs has not been called')
    return handlers
  }
  return {
    sdk: {
      createClient: () => client,
      startWs: (_options, h) => {
        handlers = h
        closed = false
        started++
        return { close: () => { closed = true } }
      },
    },
    sends,
    setSend: (next) => { steps = next; calls = 0 },
    emit: async (event) => {
      need().onMessage(event)
      // 让路由器的投递有机会执行
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    },
    ready: () => need().onReady(),
    reconnecting: () => need().onReconnecting(),
    reconnected: () => need().onReconnected(),
    error: (e) => need().onError(e),
    closed: () => closed,
    started: () => started,
  }
}

/** 让 `FeishuService` 使用假 SDK；返回恢复函数。 */
export function useFakeFeishuSdk(fake: FakeFeishu): () => void {
  const previous = FeishuService.sdkLoader
  FeishuService.sdkLoader = async () => fake.sdk
  return () => { FeishuService.sdkLoader = previous }
}
```

Add to `src/testing/index.ts`:

```ts
export { createFakeFeishuSdk, useFakeFeishuSdk, type FakeFeishu, type FakeFeishuSendStep } from './fake-feishu.js'
```

- [ ] **Step 9: Implement `FeishuService` (send, status, health; no receive yet)**

Create `src/feishu/service.ts`:

```ts
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ChannelSendCommon, ChannelService, ChannelStatus } from '../common/channel.js'
import { ConfigError } from '../common/errors.js'
import { digest, redact, registerSecret } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import { resolveSecretRef, type KeyStoreOptions } from '../secrets/index.js'
import { FeishuConfig, type FeishuTarget } from './config.js'
import { FeishuSendError, classifyApiCode, classifyThrown } from './errors.js'
import { buildCreateMessage, type FeishuAt } from './message.js'
import { loadFeishuSdk, type FeishuClient, type FeishuSdk, type FeishuSdkLoader } from './sdk.js'

export interface FeishuSendOptions extends ChannelSendCommon {
  target?: FeishuTarget
  at?: FeishuAt
}

export interface FeishuSendResult {
  results: Array<{ ok: boolean; messageId?: string; error?: FeishuSendError }>
}

export interface FeishuCounters {
  success: number
  failure: number
  lastFailureAt: number | null
  lastErrorCode: string | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishu: FeishuService
  }
}

/**
 * 飞书机器人（自建应用）：发送消息，接收群内 @ 机器人与私聊机器人的消息。
 * SDK 只经 {@link FeishuSdk} 使用；`sdkLoader` 是测试替换入口。
 */
export class FeishuService extends KitService<FeishuCounters> implements ChannelService<FeishuTarget, FeishuAt> {
  static Config = FeishuConfig
  /** 测试钩子：替换 SDK 的加载方式。 */
  static sdkLoader: FeishuSdkLoader = loadFeishuSdk
  /** 测试钩子：覆盖密钥解析的凭据文件路径 / 环境变量。 */
  static keyStore: Pick<KeyStoreOptions, 'credentialsFile' | 'env'> = {}
  readonly config: FeishuConfig
  protected sdk?: FeishuSdk
  protected client?: FeishuClient
  protected appSecret?: string
  protected botName?: string
  protected botOpenId?: string
  protected connected = false
  protected readonly controller = new AbortController()
  private lastSuccessAt: number | null = null
  private readonly counters: FeishuCounters = { success: 0, failure: 0, lastFailureAt: null, lastErrorCode: null }

  constructor(ctx: Context, config: FeishuConfig) {
    super(ctx, 'feishu')
    this.config = config
    if (!config.appId?.trim()) throw new ConfigError('feishu', 'appId is required', { field: 'appId' })
    if (config.defaultTarget) buildCreateMessage({ target: config.defaultTarget, text: '' })
    ctx.effect(() => () => this.controller.abort(), 'feishu.abortInFlight')
  }

  async [Service.init](): Promise<void> {
    const credentials = (this.ctx as unknown as { get(name: string): KeyStoreOptions['credentials'] }).get('credentials')
    const resolved = await resolveSecretRef(this.config.appSecretRef, { ...FeishuService.keyStore, credentials })
    if (!resolved) {
      throw new ConfigError('feishu', `${this.config.appSecretRef} is not set and was not found in the dsh credentials store`, { field: 'appSecretRef' })
    }
    this.appSecret = resolved.value
    this.ctx.effect(() => registerSecret(resolved.value), 'feishu.appSecret')
    this.logger.info('app secret resolved', { ref: this.config.appSecretRef, source: resolved.source })
    this.sdk = await FeishuService.sdkLoader()
    this.client = this.sdk.createClient(this.sdkOptions())
    if (this.config.dryRun) return
    const info = await this.client.botInfo(this.controller.signal).catch((e: unknown) => ({ code: -1, msg: redact(String((e as Error)?.message ?? e)) }))
    if (info.code !== 0) {
      this.markFailed(`feishu credential check failed: ${info.code} ${info.msg ?? ''}`.trim())
      return
    }
    this.botName = (info as { bot?: { app_name?: string } }).bot?.app_name
    this.botOpenId = (info as { bot?: { open_id?: string } }).bot?.open_id
    this.startReceiving()
  }

  protected sdkOptions() {
    return { appId: this.config.appId, appSecret: this.appSecret!, domain: this.config.domain, logger: this.logger }
  }

  /** 接收在 Task 4 中实现。 */
  protected startReceiving(): void {}

  async send(options: FeishuSendOptions): Promise<FeishuSendResult> {
    const req = buildCreateMessage({
      target: options.target ?? this.config.defaultTarget,
      title: options.title,
      markdown: options.markdown,
      text: options.text,
      at: options.at,
      idempotencyKey: options.idempotencyKey,
    })
    const body = options.markdown ?? options.text ?? ''
    if (this.config.dryRun) {
      this.logger.info('feishu send (dry-run)', { traceId: options.traceId, msgType: req.data.msg_type, body: digest(body) })
      this.recordSuccess()
      return { results: [{ ok: true }] }
    }
    const maxAttempts = options.idempotencyKey !== undefined ? this.config.retry.maxAttempts : 0
    for (let attempt = 0; ; attempt++) {
      this.logger.info('feishu send', { traceId: options.traceId, attempt, msgType: req.data.msg_type, body: digest(body) })
      const error = await this.sendOnce(req, options.signal)
      if (typeof error === 'string') {
        this.recordSuccess()
        return { results: [{ ok: true, messageId: error }] }
      }
      if (error.retryable && attempt < maxAttempts && !options.signal?.aborted && !this.controller.signal.aborted) {
        this.logger.warn('feishu send failed, retrying', { traceId: options.traceId, attempt, code: error.code })
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        continue
      }
      this.recordFailure(error.code)
      this.logger.warn('feishu send failed', { traceId: options.traceId, code: error.code })
      return { results: [{ ok: false, error }] }
    }
  }

  /** 成功返回 message_id，失败返回分类后的错误。 */
  private async sendOnce(req: Parameters<FeishuClient['createMessage']>[0], signal?: AbortSignal): Promise<string | FeishuSendError> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = AbortSignal.any([timeout, this.controller.signal, ...(signal ? [signal] : [])])
    try {
      const r = await Promise.race([
        this.client!.createMessage(req, combined),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(timeout.aborted ? new FeishuSendError('timeout', `feishu send timed out after ${this.config.timeoutMs}ms`) : Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (combined.aborted) onAbort()
          else combined.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      if (r.code !== undefined && r.code !== 0) return classifyApiCode(r.code, r.msg ?? '')
      return r.data?.message_id ?? ''
    } catch (e) {
      return classifyThrown(e)
    }
  }

  async status(): Promise<ChannelStatus> {
    return {
      channel: 'feishu',
      identity: 'bot',
      online: this.connected,
      ...(this.botName ? { account: this.botName } : {}),
      detail: this.connected ? 'long connection ready' : this.failure ?? 'not connected',
      checkedAt: Date.now(),
    }
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

  health(): ServiceHealth<FeishuCounters> {
    const counters = { ...this.counters }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : `bot: ${this.botName ?? 'unknown'}`, counters }
  }
}

export default FeishuService
```

Notes:
- Confirm the `ConfigError` constructor: `grep -n "class ConfigError" -A4 src/common/errors.ts` — it is `(service, message, details?)`; the calls above pass `details` as the third argument.
- Confirm `KeyStoreOptions` has `env` and `credentialsFile`: `grep -n "interface KeyStoreOptions" -A12 src/secrets/*.ts`. If `env` is not a member, drop it from the `Pick`.
- The status test expects `online: true` after `fake.ready()`; that requires the receive wiring from Task 4. For this task, make `startReceiving()` start the WS with handlers that only set `this.connected` (`onReady`/`onReconnected` → `true`, `onReconnecting`/`onError` → `false`), and `close()` it in an effect; Task 4 replaces the body. Write it as:

```ts
  protected startReceiving(): void {
    const ws = this.sdk!.startWs(this.sdkOptions(), {
      onReady: () => { this.connected = true },
      onReconnected: () => { this.connected = true },
      onReconnecting: () => { this.connected = false },
      onError: () => { this.connected = false },
      onMessage: () => {},
    })
    this.ctx.effect(() => () => ws.close(), 'feishu.ws')
  }
```

Create `src/feishu/index.ts`:

```ts
export { FeishuService as default, FeishuService, type FeishuCounters, type FeishuSendOptions, type FeishuSendResult } from './service.js'
export { FeishuConfig, FEISHU_APP_SECRET_REF, type FeishuTarget } from './config.js'
export { FeishuSendError, type FeishuErrorCode } from './errors.js'
export { buildCreateMessage, type FeishuAt } from './message.js'
export type { FeishuSdk, FeishuClient, FeishuWs, FeishuWsHandlers, FeishuSdkLoader } from './sdk.js'
```

- [ ] **Step 10: Run tests**

Run: `npx vitest run tests/unit/feishu-send.test.ts`, then `npm run typecheck && npx vitest run`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/common/errors.ts src/feishu src/testing tests/unit/feishu-send.test.ts
git commit -m "feat(feishu): bot-identity sending through the Feishu SDK with a fake SDK for tests"
```

---

### Task 4: 飞书接收、路由、未命中记录与收件人搜索

**Files:**
- Create: `src/feishu/event.ts`
- Modify: `src/feishu/service.ts`（`startReceiving`、接收方法、搜索、健康）
- Modify: `src/feishu/index.ts`
- Test: `tests/unit/feishu-inbox.test.ts`

**Interfaces:**
- Consumes: `MessageRouter`、`MessageRouterCounts`（`src/common/inbox.ts`）；`UnmatchedStore`、`unmatchedFileKey`（Task 1）；`ChannelInbox`、`ChannelRecipientSearchResult`（Task 1）；`FeishuSdk`、`FakeFeishu`（Task 3）
- Produces:
  ```ts
  // src/feishu/event.ts
  export interface FeishuAtMessage extends ChannelAtMessage { chatType: 'p2p' | 'group'; messageType: string; mentions: Array<{ openId: string; name: string }> }
  export function parseFeishuEvent(data: unknown, botOpenId?: string): FeishuAtMessage | undefined
  // FeishuService additions
  onMessage(route: ChannelMessageRoute<FeishuAtMessage>, handler: ChannelMessageHandler<FeishuAtMessage>): ChannelMessageSubscription
  onPluginMessage(pluginId: string, handler: ChannelMessageHandler<FeishuAtMessage>): ChannelMessageSubscription
  unmatchedMessages(): Promise<ChannelUnmatchedMessage[]>
  searchRecipients(kind: ChannelRecipientKind, query: string): Promise<ChannelRecipientSearchResult<{ chatId: string }>>
  // FeishuCounters gains: inbox: MessageRouterCounts & { listener: 'idle' | 'ready' | 'reconnecting' | 'failed'; routes: number }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/feishu-inbox.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFeishuEvent, type FeishuAtMessage } from '../../src/feishu/event.js'
import { FeishuService } from '../../src/feishu/service.js'
import { createFakeFeishuSdk, useFakeFeishuSdk, type FakeFeishu } from '../../src/testing/fake-feishu.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

const textEvent = (id: string, chatId: string, text: string, over: Record<string, unknown> = {}) => ({
  sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
  message: {
    message_id: id,
    chat_id: chatId,
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '告警机器人' }, { key: '@_user_2', id: { open_id: 'ou_a' }, name: '张三' }],
    create_time: '1700000000000',
    ...over,
  },
})

describe('parseFeishuEvent', () => {
  it('maps a group text message and replaces mention placeholders, dropping the bot mention', () => {
    expect(parseFeishuEvent(textEvent('om_1', 'oc_1', '@_user_1 请 @_user_2 处理'), 'ou_bot')).toEqual({
      eventId: 'om_1', messageId: 'om_1', conversationId: 'oc_1', chatType: 'group', senderId: 'ou_sender',
      content: '请 @张三 处理', messageType: 'text',
      mentions: [{ openId: 'ou_bot', name: '告警机器人' }, { openId: 'ou_a', name: '张三' }], timestamp: 1700000000000,
    })
  })

  it('extracts the text of post messages and leaves other types empty', () => {
    const post = { title: '日报', content: [[{ tag: 'text', text: '第一行' }, { tag: 'at', user_id: 'ou_bot' }], [{ tag: 'a', text: '链接', href: 'https://x' }]] }
    expect(parseFeishuEvent(textEvent('om_2', 'oc_1', '', { message_type: 'post', content: JSON.stringify(post) }), 'ou_bot')?.content).toBe('日报\n第一行\n链接')
    expect(parseFeishuEvent(textEvent('om_3', 'oc_1', '', { message_type: 'image', content: JSON.stringify({ image_key: 'k' }) }))).toMatchObject({ content: '', messageType: 'image' })
  })

  it('accepts the SDK payload wrapped in `event` and rejects malformed payloads', () => {
    expect(parseFeishuEvent({ event: textEvent('om_4', 'oc_1', 'hi') })?.eventId).toBe('om_4')
    expect(parseFeishuEvent({ message: { chat_id: 'oc_1' } })).toBeUndefined()
    expect(parseFeishuEvent(textEvent('om_5', 'oc_1', 'x', { content: 'not json' }))).toBeUndefined()
    expect(parseFeishuEvent(null)).toBeUndefined()
  })
})

describe('FeishuService inbox', () => {
  let root: TestRoot
  let fake: FakeFeishu
  let restore: () => void
  let dir: string
  const savedEnv = { ...process.env }

  beforeEach(() => {
    root = createRoot()
    dir = mkdtempSync(join(tmpdir(), 'feishu-'))
    root.root.baseUrl = pathToFileURL(`${dir}/`).href
    process.env.FEISHU_APP_SECRET = 'secret-value'
    fake = createFakeFeishuSdk({ botName: '告警机器人', botOpenId: 'ou_bot', chats: [{ chatId: 'oc_other', name: '研发群' }, { chatId: 'oc_ops', name: '运维值班群' }] })
    restore = useFakeFeishuSdk(fake)
  })
  afterEach(async () => {
    await root.dispose()
    restore()
    rmSync(dir, { recursive: true, force: true })
    process.env = { ...savedEnv }
  })

  it('queues messages until the connection is ready, then routes by conversation', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const got: FeishuAtMessage[] = []
    await root.root.plugin({ name: 'biz', inject: ['feishu'], apply(ctx: Context) { ctx.feishu.onMessage({ conversationId: 'oc_1' }, (m) => { got.push(m) }) } })
    const feishu = root.root.get('feishu')!
    await fake.emit(textEvent('om_1', 'oc_1', 'hello'))
    expect(got).toHaveLength(0)
    fake.ready()
    await until(() => got.length === 1)
    expect(got[0]).toMatchObject({ eventId: 'om_1', content: 'hello', chatType: 'group' })
    await fake.emit(textEvent('om_1', 'oc_1', 'hello'))
    expect(feishu.health().counters.inbox).toMatchObject({ listener: 'ready', duplicate: 1, routes: 1 })
  })

  it('delivers configured conversations to the business plugin and records unmatched ones with names', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test', groupRoutes: [{ conversationId: 'oc_1', pluginId: 'orders' }] })
    const feishu = root.root.get('feishu')!
    const got: string[] = []
    feishu.onPluginMessage('orders', (m) => { got.push(m.eventId) })
    fake.ready()
    await fake.emit(textEvent('om_1', 'oc_1', 'a'))
    await fake.emit(textEvent('om_2', 'oc_other', '没人处理'))
    await until(async () => got.length === 1 && (await feishu.unmatchedMessages())[0]?.conversationName === '研发群')
    expect(await feishu.unmatchedMessages()).toMatchObject([{ eventId: 'om_2', conversationId: 'oc_other', conversationName: '研发群', senderId: 'ou_sender', preview: '没人处理' }])
  })

  it('reports reconnecting as degraded and errors as failed with a service-failed event', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    fake.ready()
    expect(feishu.health().status).toBe('ok')
    fake.reconnecting()
    expect(feishu.health()).toMatchObject({ status: 'degraded', detail: expect.stringContaining('reconnecting') })
    fake.reconnected()
    expect(feishu.health().status).toBe('ok')
    fake.error(new Error('gave up'))
    expect(feishu.health().status).toBe('failed')
    expect(root.failures.some((f) => f.service === 'feishu')).toBe(true)
  })

  it('drops malformed events and closes the connection on unload', async () => {
    const fork = await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    fake.ready()
    await fake.emit({ nope: true })
    expect(feishu.health().counters.inbox.dropped).toBe(1)
    await fork.dispose()
    expect(fake.closed()).toBe(true)
  })

  it('searches groups the bot belongs to and refuses user search', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test' })
    const feishu = root.root.get('feishu')!
    expect(await feishu.searchRecipients('group', '运维')).toEqual({ candidates: [{ name: '运维值班群', target: { chatId: 'oc_ops' } }], complete: true })
    await expect(feishu.searchRecipients('user', '张三')).rejects.toThrow(/open_id/)
    await expect(feishu.searchRecipients('group', 'x')).rejects.toThrow(/2–80/)
  })

  it('rejects duplicate group routes and listening in dryRun', async () => {
    await root.root.plugin(FeishuService, { appId: 'cli_test', groupRoutes: [{ conversationId: 'oc_1', pluginId: 'a' }, { conversationId: 'oc_1', pluginId: 'b' }] })
    expect(root.root.get('feishu')).toBeUndefined()
  })
})
```

Check how a plugin fork is disposed in this repo before relying on `fork.dispose()`: `grep -n "dispose()" tests/unit/dingtalk-inbox.test.ts | head -3` and use the same API. For the last test, check how a constructor `ConfigError` surfaces in the DingTalk tests (`grep -n "duplicate group route" -B3 -A3 tests/unit/dingtalk*.test.ts`) and mirror that assertion.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/feishu-inbox.test.ts`
Expected: FAIL with `Failed to load url ../../src/feishu/event.js`.

- [ ] **Step 3: Implement `src/feishu/event.ts`**

```ts
import type { ChannelAtMessage } from '../common/channel.js'

/** 群内 @ 机器人或私聊机器人的消息。正文是外部输入，业务插件必须自行校验。 */
export interface FeishuAtMessage extends ChannelAtMessage {
  chatType: 'p2p' | 'group'
  /** 飞书原始消息类型，如 `text`、`post`、`image`。 */
  messageType: string
  mentions: Array<{ openId: string; name: string }>
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function postText(content: Record<string, unknown>): string {
  const localized = obj(content.zh_cn) ?? obj(content.en_us) ?? content
  const lines: string[] = []
  if (str(localized.title)) lines.push(localized.title as string)
  for (const paragraph of Array.isArray(localized.content) ? localized.content : []) {
    const parts = (Array.isArray(paragraph) ? paragraph : []).map((node) => {
      const n = obj(node)
      return n && (n.tag === 'text' || n.tag === 'a') && typeof n.text === 'string' ? n.text : ''
    }).join('')
    if (parts) lines.push(parts)
  }
  return lines.join('\n')
}

/** 解析 `im.message.receive_v1`；结构不合法时返回 undefined。 */
export function parseFeishuEvent(data: unknown, botOpenId?: string): FeishuAtMessage | undefined {
  const root = obj(data)
  const event = obj(root?.event) ?? root
  const message = obj(event?.message)
  if (!message) return undefined
  const messageId = str(message.message_id)
  const chatId = str(message.chat_id)
  const messageType = str(message.message_type)
  if (!messageId || !chatId || !messageType || typeof message.content !== 'string') return undefined
  let content: Record<string, unknown> | undefined
  try {
    content = obj(JSON.parse(message.content))
  } catch {
    return undefined
  }
  if (!content) return undefined
  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).flatMap((m) => {
    const mention = obj(m)
    const openId = str(obj(mention?.id)?.open_id)
    const key = str(mention?.key)
    return openId && key ? [{ key, openId, name: str(mention?.name) ?? '' }] : []
  })
  let text = ''
  if (messageType === 'text' && typeof content.text === 'string') {
    text = content.text
    for (const m of mentions) text = text.split(m.key).join(m.openId === botOpenId ? '' : `@${m.name}`)
    text = text.replace(/\s+/g, ' ').trim()
  } else if (messageType === 'post') {
    text = postText(content)
  }
  const sender = str(obj(obj(event?.sender)?.sender_id)?.open_id)
  const created = Number(message.create_time)
  return {
    eventId: messageId,
    messageId,
    conversationId: chatId,
    chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
    ...(sender ? { senderId: sender } : {}),
    content: text,
    messageType,
    mentions: mentions.map(({ openId, name }) => ({ openId, name })),
    ...(Number.isFinite(created) && created > 0 ? { timestamp: created } : {}),
  }
}
```

Note: collapsing whitespace in `text` content is required so `@_user_1 请 @_user_2 处理` with the bot mention removed yields `请 @张三 处理`.

- [ ] **Step 4: Wire receiving into `FeishuService`**

In `src/feishu/service.ts`:

1. Add imports:

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChannelInbox, ChannelMessageHandler, ChannelMessageRoute, ChannelMessageSubscription, ChannelRecipientKind, ChannelRecipientSearchResult } from '../common/channel.js'
import { MessageRouter, type MessageRouterCounts } from '../common/inbox.js'
import { UnmatchedStore, unmatchedFileKey, type ChannelUnmatchedMessage } from '../common/unmatched.js'
import { parseFeishuEvent, type FeishuAtMessage } from './event.js'
```

2. Extend `FeishuCounters`:

```ts
export interface FeishuCounters {
  success: number
  failure: number
  lastFailureAt: number | null
  lastErrorCode: string | null
  inbox: MessageRouterCounts & { listener: 'idle' | 'ready' | 'reconnecting' | 'failed'; routes: number }
}
```

and change the private counters field to `Omit<FeishuCounters, 'inbox'>`, building `inbox` in `health()`.

3. Extend the class declaration with `ChannelInbox<FeishuAtMessage, ChannelUnmatchedMessage, { chatId: string }>` and add fields:

```ts
  private readonly router: MessageRouter<FeishuAtMessage>
  private readonly unmatched: UnmatchedStore
  private listener: 'idle' | 'ready' | 'reconnecting' | 'failed' = 'idle'
```

4. In the constructor, after the `defaultTarget` check, validate routes and create the router and store (same rules and messages as DingTalk):

```ts
    const groupRoutes = new Map<string, string>()
    for (const route of config.groupRoutes ?? []) {
      const conversationId = route.conversationId?.trim()
      const pluginId = route.pluginId?.trim()
      if (!conversationId || !pluginId) throw new ConfigError('feishu', 'group route requires conversationId and pluginId', { field: 'groupRoutes' })
      if (groupRoutes.has(conversationId)) throw new ConfigError('feishu', `duplicate group route: ${conversationId}`, { field: 'groupRoutes' })
      groupRoutes.set(conversationId, pluginId)
    }
    const baseUrl = (ctx as Context & { baseUrl?: string }).baseUrl
    const dir = baseUrl ? join(dirname(fileURLToPath(new URL('./cordis.yml', baseUrl))), '.agent-kit', 'feishu-unmatched') : undefined
    this.unmatched = new UnmatchedStore(
      dir ? join(dir, `${unmatchedFileKey(config.appId)}.json`) : undefined,
      (chatId) => this.chatName(chatId),
      (error) => this.logger.warn('feishu unmatched metadata unavailable', { error: redact(String(error)) }),
    )
    this.router = new MessageRouter<FeishuAtMessage>({ channel: 'feishu', logger: this.logger, onUnmatched: (m) => this.unmatched.add(m), pluginRoutes: groupRoutes })
```

5. Replace `startReceiving()`:

```ts
  protected startReceiving(): void {
    const ws = this.sdk!.startWs(this.sdkOptions(), {
      onReady: () => this.markConnected(),
      onReconnected: () => this.markConnected(),
      onReconnecting: () => {
        this.connected = false
        this.listener = 'reconnecting'
        this.router.setReady(false)
      },
      onError: (error) => {
        this.connected = false
        this.listener = 'failed'
        this.router.setReady(false)
        this.markFailed(`feishu long connection failed: ${redact(error.message)}`, error)
      },
      // 飞书要求 3 秒内返回：这里只解析、入队，投递由路由器异步完成
      onMessage: (event) => {
        const message = parseFeishuEvent(event, this.botOpenId)
        if (!message) {
          this.router.drop()
          this.logger.warn('invalid feishu event dropped')
          return
        }
        this.router.accept(message)
      },
    })
    this.ctx.effect(() => () => {
      ws.close()
      this.router.reset()
      this.connected = false
      this.listener = 'idle'
    }, 'feishu.ws')
  }

  private markConnected(): void {
    this.connected = true
    this.listener = 'ready'
    this.clearFailed()
    this.router.setReady(true)
  }
```

6. Add the inbox methods (pattern copied from `DingtalkService.onMessage`):

```ts
  /** 按会话 ID 注册 @ 消息处理器；每条消息只下发给优先级最高的首个匹配处理器。 */
  onMessage(route: ChannelMessageRoute<FeishuAtMessage>, handler: ChannelMessageHandler<FeishuAtMessage>): ChannelMessageSubscription {
    return this.subscribe(this.router.register(route, handler), 'feishu.onMessage')
  }

  /** 业务插件以设置页使用的插件 ID 注册接收器；会话到插件的映射由 `groupRoutes` 配置。 */
  onPluginMessage(pluginId: string, handler: ChannelMessageHandler<FeishuAtMessage>): ChannelMessageSubscription {
    return this.subscribe(this.router.registerPlugin(pluginId, handler), 'feishu.onPluginMessage')
  }

  private subscribe(dispose: () => void, label: string): ChannelMessageSubscription {
    if (this.config.dryRun) {
      dispose()
      throw new ConfigError('feishu', 'cannot listen for messages in dryRun mode', { field: 'dryRun' })
    }
    const subscription: ChannelMessageSubscription = {
      ready: this.listener === 'ready' ? Promise.resolve() : new Promise<void>((resolve) => {
        const timer = setInterval(() => { if (this.listener === 'ready') { clearInterval(timer); resolve() } }, 20)
        this.ctx.effect(() => () => clearInterval(timer), `${label}.ready`)
      }),
      close: async () => dispose(),
    }
    try {
      // Cordis 将此 effect 归属到调用方插件；插件卸载时自动取消它的路由。
      this.ctx.effect(() => () => dispose(), label)
    } catch (error) {
      dispose()
      throw error
    }
    return subscription
  }

  /** 最近 200 条未命中记录（只保存 240 字预览），新记录在前。 */
  unmatchedMessages(): Promise<ChannelUnmatchedMessage[]> {
    return this.unmatched.list()
  }

  /** 只支持按群名搜索机器人所在的群；机器人身份无法按姓名搜人，个人请填写 open_id。 */
  async searchRecipients(kind: ChannelRecipientKind, query: string): Promise<ChannelRecipientSearchResult<{ chatId: string }>> {
    if (kind === 'user') throw new TypeError('feishu bot cannot search users; enter an open_id')
    if (kind !== 'group') throw new TypeError('recipient kind must be group or user')
    const term = query?.trim()
    if (!term || term.length < 2 || term.length > 80) throw new TypeError('recipient search query must be 2–80 characters')
    if (!this.client) throw new Error('feishu service is not initialized')
    const r = await this.client.searchChats(term, this.controller.signal)
    if (r.code !== undefined && r.code !== 0) throw classifyApiCode(r.code, r.msg ?? '')
    const candidates = (r.data?.items ?? []).flatMap((item) => (item.chat_id ? [{ name: item.name ?? item.chat_id, target: { chatId: item.chat_id } }] : []))
    return { candidates, complete: r.data?.has_more !== true }
  }

  private async chatName(chatId: string): Promise<string | undefined> {
    if (!this.client) return undefined
    const r = await this.client.getChat(chatId, this.controller.signal)
    return r.code === 0 && r.data?.name?.trim() ? r.data.name.trim() : undefined
  }
```

The `ready` promise polling is a deliberately small mechanism; if `MessageRouter` or the service already exposes a ready signal by the time you implement this, use it instead and note the change in the report.

7. Update `health()`:

```ts
  health(): ServiceHealth<FeishuCounters> {
    const counters: FeishuCounters = { ...this.counters, inbox: { listener: this.listener, routes: this.router.size, ...this.router.counters() } }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (this.listener === 'reconnecting') return { status: 'degraded', detail: 'feishu long connection reconnecting', counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : `bot: ${this.botName ?? 'unknown'}; @ inbox listening (${counters.inbox.routes} route(s))`, counters }
  }
```

8. Export `parseFeishuEvent` and `type FeishuAtMessage` from `src/feishu/index.ts`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/feishu-inbox.test.ts tests/unit/feishu-send.test.ts`, then `npm run typecheck && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/feishu tests/unit/feishu-inbox.test.ts
git commit -m "feat(feishu): receive @ and direct messages over the long connection with routing and unmatched records"
```

---

### Task 5: 接入 bundle、notify 与公开导出

**Files:**
- Modify: `src/common/channel.ts`（`CHANNEL_NAMES`）
- Modify: `src/notify/service.ts`（`NotifyTargets`、`NotifyAts`）
- Modify: `package.json`（`exports`、`peerDependencies`、`peerDependenciesMeta`）
- Modify: `patch.yml`
- Modify: `src/index.ts`
- Modify: `tests/unit/channel-contract.test.ts`、`tests/integration/dsh-loader.test.ts`
- Test: `tests/unit/notify.test.ts`

**Interfaces:**
- Consumes: `FeishuService`、`FeishuTarget`、`FeishuAt`、`createFakeFeishuSdk`、`useFakeFeishuSdk`（Task 3–4）；`DEFAULT_TARGET`（Task 2）
- Produces: `CHANNEL_NAMES = ['dingtalk', 'feishu']`；`NotifyTargets = { dingtalk?: DingtalkTarget | 'default'; feishu?: FeishuTarget | 'default' }`；`NotifyAts = { dingtalk?: DingtalkAt; feishu?: FeishuAt }`；loader 行 `agent-kit-feishu`；子路径 `@baoyx/dsh-agent-kit/feishu`。

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/notify.test.ts` (new imports at the top: `FeishuService` from `'../../src/feishu/service.js'`, `createFakeFeishuSdk, useFakeFeishuSdk` from `'../../src/testing/fake-feishu.js'`):

```ts
  it('sends to DingTalk with its default target and to a named Feishu group in one call', async () => {
    process.env.FEISHU_APP_SECRET = 'secret-value'
    const fake = createFakeFeishuSdk()
    const restore = useFakeFeishuSdk(fake)
    try {
      await root.root.plugin(DingtalkService, { dwsPath: dws.path, identity: 'user', defaultTarget: { chatId: 'cidA' } })
      await root.root.plugin(FeishuService, { appId: 'cli_test' })
      await root.root.plugin(NotifyService, { channel: 'dingtalk' })
      const notify = root.root.get('notify')!
      const r = await notify.send({ text: 'hello', targets: { dingtalk: 'default', feishu: { chatId: 'oc_ops' } } })
      expect(r.deliveries.map((d) => [d.channel, d.results[0]!.ok])).toEqual([['dingtalk', true], ['feishu', true]])
      expect(fake.sends[0]!.data.receive_id).toBe('oc_ops')
      await expect(notify.login('feishu')).rejects.toMatchObject({ code: 'login_unsupported' })
      expect((await notify.status()).channels.feishu).toMatchObject({ running: true, identity: 'bot' })
    } finally {
      restore()
    }
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/notify.test.ts`
Expected: FAIL with `invalid_channel` (`feishu` is not in `CHANNEL_NAMES`).

- [ ] **Step 3: Implement**

1. `src/common/channel.ts`: `export const CHANNEL_NAMES: readonly ChannelName[] = ['dingtalk', 'feishu']`.
2. `src/notify/service.ts`: import `type FeishuTarget` from `'../feishu/config.js'` and `type FeishuAt` from `'../feishu/message.js'` (type-only, so no runtime dependency on the SDK), and extend:

```ts
export interface NotifyTargets {
  dingtalk?: DingtalkTarget | typeof DEFAULT_TARGET
  feishu?: FeishuTarget | typeof DEFAULT_TARGET
}

export interface NotifyAts {
  dingtalk?: DingtalkAt
  feishu?: FeishuAt
}
```

3. `tests/unit/channel-contract.test.ts`: change `expect(CHANNEL_NAMES).toEqual(['dingtalk'])` to `expect(CHANNEL_NAMES).toEqual(['dingtalk', 'feishu'])` and rename the test to `'lists the implemented channels'`.
4. `package.json`:
   - add to `exports`, after `./dingtalk`:
     ```json
     "./feishu": {
       "types": "./lib/feishu/index.d.ts",
       "default": "./lib/feishu/index.js"
     },
     ```
   - add `"@larksuiteoapi/node-sdk": "^1.76.0"` to `peerDependencies`, and `"@larksuiteoapi/node-sdk": { "optional": true }` to `peerDependenciesMeta`.
5. `patch.yml`: add after the `agent-kit-dingtalk` row:
   ```yaml
       - id: agent-kit-feishu
         name: '@baoyx/dsh-agent-kit/feishu'
         disabled: true
   ```
6. `src/index.ts`: add

```ts
export {
  FeishuService,
  FeishuConfig,
  FeishuSendError,
  FEISHU_APP_SECRET_REF,
  buildCreateMessage,
  parseFeishuEvent,
  type FeishuAt,
  type FeishuAtMessage,
  type FeishuCounters,
  type FeishuErrorCode,
  type FeishuSendOptions,
  type FeishuSendResult,
  type FeishuTarget,
} from './feishu/index.js'
```

   and add `type NotifyAts`/`type NotifyTargets` already exported (no change).
7. `tests/integration/dsh-loader.test.ts`: in the two `for (const name of [...])` lists (lines ~61 and ~141), add `'feishu'` to the first (all services undefined when disabled). Leave the second list unchanged unless that test enables every row — read the test around line 141 first; if it enables rows from `patch.yml` generically and `feishu` would fail to start without SDK credentials, keep `feishu` out of that list and note it in the report.

- [ ] **Step 4: Run tests and build**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: all pass; `lib/feishu/index.js` exists after the build (`ls lib/feishu/index.js`).

- [ ] **Step 5: Commit**

```bash
git add src package.json package-lock.json patch.yml tests
git commit -m "feat(feishu): register the agent-kit-feishu row and route notify to Feishu"
```

---

## 阶段二：admin 与文档

### Task 6: admin 后端注册飞书行、飞书密钥与按渠道的接口

**Files:**
- Modify: `admin/vitest.config.ts:11`
- Modify: `admin/src/profile/kit-entries.ts`
- Modify: `admin/src/admin/service.ts`
- Modify: `admin/src/client/remote.ts`、`admin/src/client/index.tsx`
- Modify: `admin/src/cli/messages.ts`（`KIT_TITLES`、`NOTIFY_CHANNEL_TITLES`）、`admin/src/checks/notify.ts`（`TITLES`）
- Modify: tests that build `KitSnapshot.entries` or list kit ids (`admin/tests/unit/checks.test.ts`, `admin/tests/unit/profile.test.ts`, `admin/tests/integration/admin-entries.test.ts`, `admin/tests/integration/dsh-loader.test.ts`, `admin/tests/unit/client-page.test.tsx`)
- Test: `admin/tests/integration/admin.test.ts`（或 `admin-entries.test.ts` 中已有的 status / setSecret 测试组）

**Interfaces:**
- Consumes: `FeishuConfig`、`FEISHU_APP_SECRET_REF`（`@baoyx/dsh-agent-kit/feishu`）；`ChannelUnmatchedMessage`、`ChannelRecipientSearchResult`（`@baoyx/dsh-agent-kit`）
- Produces:
  ```ts
  // admin/src/profile/kit-entries.ts
  export type KitId = 'agent-kit-ws' | 'agent-kit-dingtalk' | 'agent-kit-feishu' | 'agent-kit-notify' | 'agent-kit-agent-tasks' | 'agent-kit-jev'
  // admin/src/admin/service.ts（remote 方法）
  channelUnmatched(channel: 'dingtalk' | 'feishu'): Promise<ChannelUnmatchedMessage[]>
  channelSearchRecipients(channel: 'dingtalk' | 'feishu', kind: 'group' | 'user', query: string): Promise<ChannelRecipientSearchResult>
  // agent-kit-feishu 行的 status 带 secrets: [{ label: 'App Secret', ref: <appSecretRef>, configured, source? }]
  // admin/src/client/remote.ts AdminApi 新增同名两个方法；KitId 同步；新类型 ChannelUnmatchedMessage、ChannelRecipientSearchResult
  ```

- [ ] **Step 1: Write the failing tests**

In the admin integration test file that already covers `status()` for kit rows and `setSecret` with refs (find it with `grep -ln "layaSecrets\|Laya API Key\|LAYA_API_KEY" admin/tests -r`), add:

```ts
  it('shows the Feishu App Secret on its row and accepts it in setSecret', async () => {
    const admin = await setup()
    const s = await admin.status()
    expect(s.services.find((x) => x.id === 'agent-kit-feishu')).toMatchObject({ title: '飞书', secrets: [{ label: 'App Secret', ref: 'FEISHU_APP_SECRET', configured: false }] })
    expect(await admin.setSecret('credentials', 'app-secret', 'FEISHU_APP_SECRET')).toEqual({ configured: true, source: 'credentials' })
  })

  it('serves unmatched messages and recipient search per channel and rejects unknown channels', async () => {
    const admin = await setup()
    await expect(admin.channelUnmatched('feishu')).rejects.toThrow(/not running|未运行/)
    await expect(admin.channelUnmatched('email' as never)).rejects.toThrow(/bad_request/)
    await expect(admin.channelSearchRecipients('email' as never, 'group', 'ab')).rejects.toThrow(/bad_request/)
  })
```

(Use the file's existing `setup()` helper and the same assertion style it uses for `dingtalkUnmatched` when DingTalk is not running — read that test first and copy its expected error text.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd admin && npx vitest run tests/integration`
Expected: FAIL — no `agent-kit-feishu` row and `channelUnmatched` is not a function.

- [ ] **Step 3: Register the row**

1. `admin/vitest.config.ts`: add `feishu` to the subpath alias group: `(ws|dingtalk|feishu|notify|agent-tasks|jev|secrets|testing)`.
2. `admin/src/profile/kit-entries.ts`: import `FeishuConfig` from `'@baoyx/dsh-agent-kit/feishu'`; add `'agent-kit-feishu'` to `KitId` (after `'agent-kit-dingtalk'`); add to `KIT_ENTRIES` right after the DingTalk entry:

```ts
  { id: 'agent-kit-feishu', service: 'feishu', module: '@baoyx/dsh-agent-kit/feishu', title: '飞书', validate: validator(FeishuConfig as unknown as Schema) },
```

3. `admin/src/client/remote.ts`: add `'agent-kit-feishu'` to its `KitId`.
4. `admin/src/cli/messages.ts`: add `'agent-kit-feishu': '飞书机器人（收发消息）'` to `KIT_TITLES` and `feishu: '飞书'` to `NOTIFY_CHANNEL_TITLES`. `admin/src/checks/notify.ts`: `const TITLES: Record<string, string> = { dingtalk: '钉钉', feishu: '飞书' }` and widen the cast `as 'agent-kit-dingtalk'` to `as KitId` (import `type KitId` from `'../profile/index.js'`).
5. Fix every test helper that builds a full `entries` record or lists kit ids: `grep -rn "'agent-kit-jev'" admin/tests` — add `'agent-kit-feishu': off` (or the equivalent default) to each `entries` object, and insert `'agent-kit-feishu'` after `'agent-kit-dingtalk'` in each id list (e.g. `admin/tests/unit/profile.test.ts:139`, `admin/tests/integration/admin-entries.test.ts:86`), and `'feishu'` after `'dingtalk'` in `admin/tests/integration/dsh-loader.test.ts:37`.

- [ ] **Step 4: Feishu secret and per-channel endpoints in `AgentKitAdmin`**

In `admin/src/admin/service.ts`:

1. Next to `layaKeyRef`, add:

```ts
/** 飞书行的 App Secret 引用。 */
function feishuSecretRef(config: Record<string, unknown> | undefined): string {
  return ((config ?? {}) as { appSecretRef?: string }).appSecretRef ?? FEISHU_APP_SECRET_REF
}

const CHANNEL_SERVICES = ['dingtalk', 'feishu'] as const
type AdminChannel = (typeof CHANNEL_SERVICES)[number]
```

   importing `FEISHU_APP_SECRET_REF` from `'@baoyx/dsh-agent-kit/feishu'`.

2. In `status()` (the profile branch), after `layaSecrets`:

```ts
    const feishuRef = feishuSecretRef(snapshot.entries['agent-kit-feishu'].config)
    const feishuSecrets = [{ label: 'App Secret', ref: feishuRef, ...(await describeSecretRef(feishuRef, this.keyStore)) }]
```

   and in the `KIT_ENTRIES.map` add `...(meta.id === 'agent-kit-feishu' ? { secrets: feishuSecrets } : {}),` next to the jev line. In the no-profile branch, leave rows without secrets (as today).

3. In `registeredRef`, accept the Feishu ref:

```ts
    const kit = (await readKitEntries(profile.patchFile)).entries
    if (ref === layaKeyRef(kit['agent-kit-jev'].config) || ref === feishuSecretRef(kit['agent-kit-feishu'].config)) return
```

   (replace the existing single `layaKeyRef` line).

4. Add the endpoints, replacing the bodies of `dingtalkUnmatched` / `dingtalkSearchRecipients` with delegations:

```ts
  private channel(name: unknown): AdminChannel {
    if (!CHANNEL_SERVICES.includes(name as AdminChannel)) failWith('bad_request', `unknown channel ${String(name)}`)
    return name as AdminChannel
  }

  private inbox(name: AdminChannel): Pick<ChannelInbox<ChannelAtMessage>, 'unmatchedMessages' | 'searchRecipients'> {
    const service = (this.ctx as unknown as { get(name: string): Pick<ChannelInbox<ChannelAtMessage>, 'unmatchedMessages' | 'searchRecipients'> | undefined }).get(name)
    if (!service) failWith('bad_request', `${name} 未运行，先启用并保存 agent-kit-${name}`)
    return service
  }

  async channelUnmatched(channel: AdminChannel): Promise<ChannelUnmatchedMessage[]> {
    return this.inbox(this.channel(channel)).unmatchedMessages()
  }

  async channelSearchRecipients(channel: AdminChannel, kind: ChannelRecipientKind, query: string): Promise<ChannelRecipientSearchResult> {
    const name = this.channel(channel)
    try {
      return await this.inbox(name).searchRecipients(kind, query)
    } catch (e) {
      if (e instanceof RemoteError) throw e
      failWith('bad_request', redact((e as Error).message))
    }
  }

  /** @deprecated 0.3 起改用 `channelUnmatched('dingtalk')`。 */
  async dingtalkUnmatched(): Promise<DingtalkUnmatchedMessage[]> {
    return this.channelUnmatched('dingtalk') as Promise<DingtalkUnmatchedMessage[]>
  }

  /** @deprecated 0.3 起改用 `channelSearchRecipients('dingtalk', …)`。 */
  async dingtalkSearchRecipients(kind: DingtalkRecipientKind, query: string): Promise<DingtalkRecipientSearchResult> {
    return this.channelSearchRecipients('dingtalk', kind, query) as Promise<DingtalkRecipientSearchResult>
  }
```

   Before replacing, read the existing `dingtalkUnmatched` / `dingtalkSearchRecipients` bodies (lines ~495–515): keep whatever writability check, error text and redaction they apply, moving it into `channelUnmatched` / `channelSearchRecipients` so the DingTalk behavior and its tests stay identical. Import `ChannelAtMessage`, `ChannelInbox`, `ChannelRecipientKind`, `ChannelRecipientSearchResult`, `ChannelUnmatchedMessage` as types from `'@baoyx/dsh-agent-kit'`.

5. Add `'channelUnmatched', 'channelSearchRecipients'` to the `markRemote` method list at the bottom of the file.

- [ ] **Step 5: Client API**

In `admin/src/client/remote.ts`:

```ts
export type AdminChannel = 'dingtalk' | 'feishu'
export interface ChannelUnmatchedMessage {
  eventId: string
  messageId?: string
  conversationId: string
  conversationName?: string
  senderId?: string
  preview: string
  receivedAt: number
  timestamp?: number
}
export interface ChannelRecipientSearchResult {
  candidates: Array<{ name: string; target: Record<string, string> }>
  complete: boolean
}
```

add to `AdminApi`:

```ts
  channelUnmatched(channel: AdminChannel): Promise<ChannelUnmatchedMessage[]>
  channelSearchRecipients(channel: AdminChannel, kind: 'group' | 'user', query: string): Promise<ChannelRecipientSearchResult>
```

add descriptors `method('channelUnmatched', ['channel'])` and `method('channelSearchRecipients', ['channel', 'kind', 'query'])` to `AGENT_KIT_REMOTE.descriptors` (after `dingtalkSearchRecipients`), and to `createAdminApi`:

```ts
    channelUnmatched: (channel) => unwrap(svc().channelUnmatched!(channel)),
    channelSearchRecipients: (channel, kind, query) => unwrap(svc().channelSearchRecipients!(channel, kind, query)),
```

In `admin/src/client/index.tsx` add the matching `lazyApi` entries:

```ts
    channelUnmatched: async (...a: Parameters<typeof api.channelUnmatched>) => (await ready, api.channelUnmatched(...a)),
    channelSearchRecipients: async (...a: Parameters<typeof api.channelSearchRecipients>) => (await ready, api.channelSearchRecipients(...a)),
```

Update the tests that enumerate the remote API: `fakeApi` in `admin/tests/unit/client-page.test.tsx` (add `channelUnmatched: vi.fn(async () => [])`, `channelSearchRecipients: vi.fn(async () => ({ candidates: [], complete: true }))`), the descriptor list assertion in the same file (append `['channelUnmatched', ['channel']], ['channelSearchRecipients', ['channel', 'kind', 'query']]` in descriptor order), and the remote method name list in `admin/tests/integration/dsh-loader.test.ts:45` (add `'channelSearchRecipients', 'channelUnmatched'` in sorted order).

- [ ] **Step 6: Run tests**

Run: `cd admin && npm run typecheck && npx vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add admin
git commit -m "feat(admin): register the Feishu row, its App Secret, and per-channel inbox endpoints"
```

---

### Task 7: admin 前端：通用面板、飞书卡片与 `feishu-target`

**Files:**
- Create: `admin/src/client/channel-routes.tsx`（由 `dingtalk-routes.tsx` 改名并通用化，删除原文件）
- Create: `admin/src/client/channel-unmatched.tsx`（由 `dingtalk-unmatched.tsx` 改名并通用化，删除原文件）
- Modify: `admin/src/client/service-card.tsx`、`admin/src/client/settings-page.tsx`、`admin/src/client/forms.tsx`、`admin/src/client/locale.ts`
- Modify: `admin/src/admin/entry.ts`（`EntryFieldKind`）、`admin/src/client/remote.ts`（`EntryField.kind`）
- Test: `admin/tests/unit/client-page.test.tsx`（以及引用了被改名 key 的测试）

**Interfaces:**
- Consumes: `AdminApi.channelUnmatched`、`AdminApi.channelSearchRecipients`、`AdminChannel`、`ChannelUnmatchedMessage`（Task 6）
- Produces:
  ```tsx
  export function ChannelRoutesPanel(props: { channel: AdminChannel; config: Record<string, unknown>; onChange(config: Record<string, unknown>): void; status: AdminStatus; api: AdminApi; disabled: boolean; t: T }): JSX.Element
  export function ChannelUnmatchedPanel(props: { channel: AdminChannel; api: AdminApi; t: T }): JSX.Element
  // EntryFieldKind 增加 'feishu-target'
  // FORMS['agent-kit-feishu'] = FeishuForm（appId 文本、domain 下拉）
  ```

- [ ] **Step 1: Write the failing tests**

Add to `admin/tests/unit/client-page.test.tsx` (inside `describe('SettingsPage', …)`):

```tsx
  it('shows the Feishu card with its form, routes, unmatched panel and App Secret', async () => {
    const s = status()
    s.services.splice(2, 0, { id: 'agent-kit-feishu', title: '飞书', enabled: true, phase: 'active', health: { status: 'ok', detail: 'bot: 告警机器人' }, config: { appId: 'cli_x', groupRoutes: [] }, secrets: [{ label: 'App Secret', ref: 'FEISHU_APP_SECRET', configured: false }] })
    const api = fakeApi(s)
    api.channelUnmatched = vi.fn(async () => [{ eventId: 'om_1', conversationId: 'oc_1', conversationName: '研发群', preview: '没人处理', receivedAt: 1 }])
    render(<SettingsPage api={api} t={t} />)
    const card = await screen.findByRole('region', { name: '飞书' })
    expect(within(card).getByLabelText(zh['feishu.appId']!)).toHaveProperty('value', 'cli_x')
    expect(within(card).getByLabelText(zh['feishu.domain']!)).toBeTruthy()
    expect(within(card).getByRole('region', { name: zh['routes.title']! })).toBeTruthy()
    expect(within(card).getByText('App Secret')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: zh['unmatched.refresh']! }))
    await waitFor(() => expect(api.channelUnmatched).toHaveBeenCalledWith('feishu'))
    expect(await within(card).findByText('研发群')).toBeTruthy()
  })

  it('keeps the DingTalk routes and unmatched panels working through the generic components', async () => {
    const s = status()
    s.services[1] = { ...s.services[1]!, enabled: true, config: { identity: 'user', groupRoutes: [] } }
    const api = fakeApi(s)
    render(<SettingsPage api={api} t={t} />)
    const card = await screen.findByRole('region', { name: '钉钉' })
    fireEvent.click(within(card).getByRole('button', { name: zh['unmatched.refresh']! }))
    await waitFor(() => expect(api.channelUnmatched).toHaveBeenCalledWith('dingtalk'))
  })
```

If the settings-page tests use a different `region` name for cards or rely on DingTalk auth panel mocks being present, adjust to the file's existing conventions (read the nearest existing DingTalk card test first).

- [ ] **Step 2: Run to verify it fails**

Run: `cd admin && npx vitest run tests/unit/client-page.test.tsx`
Expected: FAIL — no `feishu.appId` field and `routes.title` key missing.

- [ ] **Step 3: Generic panels and locale keys**

1. `git mv admin/src/client/dingtalk-routes.tsx admin/src/client/channel-routes.tsx` and `git mv admin/src/client/dingtalk-unmatched.tsx admin/src/client/channel-unmatched.tsx`.
2. In `channel-routes.tsx`: rename the export to `ChannelRoutesPanel`, add `channel: AdminChannel` as the first prop, replace `api.dingtalkUnmatched()` with `api.channelUnmatched(channel)`, replace the type `DingtalkUnmatchedMessage` with `ChannelUnmatchedMessage`, replace `item.groupName` with `item.conversationName` (three places), replace every `t('dingtalk.routes.X')` with `t('routes.X')`, change the placeholder `"cid…"` to `{channel === 'feishu' ? 'oc_…' : 'cid…'}`, and make the `<datalist>` id unique per channel: ``id={`agent-kit-business-plugins-${channel}`}`` with the input's `list` attribute matching.
3. In `channel-unmatched.tsx`: rename the export to `ChannelUnmatchedPanel`, add `channel: AdminChannel` prop, call `api.channelUnmatched(channel)`, use `ChannelUnmatchedMessage`, `item.conversationName`, and `t('unmatched.X')` instead of `t('dingtalk.unmatched.X')`.
4. In `admin/src/client/locale.ts`, in both `zh` and `en`, rename every `dingtalk.routes.*` key to `routes.*` and every `dingtalk.unmatched.*` key to `unmatched.*`, and make the channel-specific texts generic:
   - `routes.title`: `'会话消息转发到业务插件'` / `'Forward conversation messages to business plugins'`
   - `routes.hint`: `'按会话 ID 精确匹配 @ 本渠道账号或机器人的消息（也适用于单聊）；每个会话只交给一个插件。目标插件未注册时记为未命中，不转给其他插件。添加或删除后点击卡片底部“保存”。'` / `'Match @ messages for this channel's account or bot by conversation ID (direct chats included). Each conversation goes to one plugin. If the target plugin is not registered, the message is recorded as unmatched. Save the card after editing.'`
   - `routes.empty`: `'还没有会话路由。'` / `'No conversation routes yet.'`
   - `routes.groupId`: `'会话 ID'` / `'Conversation ID'`
   - `routes.remove`: `'移除会话 {id} 的路由'` / `'Remove route for conversation {id}'`
   - `routes.duplicate`: `'这个会话 ID 已配置路由。'` / `'This conversation ID already has a route.'`
   - `routes.suggestions`: `'未命中的会话：'` / `'Unmatched conversations:'`
   - `unmatched.title`: `'未命中插件的消息'` / `'Unmatched messages'`
   - `unmatched.hint`: `'仅本机可查看最近 200 条记录；保留会话 ID 与最多 240 字消息预览。会话名查询失败时仍保留会话 ID。'` / `'Available locally only. Keeps the latest 200 records with conversation IDs and message previews of up to 240 characters. The conversation ID remains available if name lookup fails.'`
   - `unmatched.unknownGroup`: `'会话名未知'` / `'Unknown conversation'`
   - keep the remaining renamed keys' texts as they are.
   Then add the Feishu form keys: `'feishu.appId': 'App ID'`, `'feishu.domain': '域名'`, `'feishu.domain.feishu': '飞书'`, `'feishu.domain.lark': 'Lark（国际版）'`, `'recipient.openId': '用户 open_id'`, `'recipient.feishuUserHint': '飞书机器人无法按姓名搜人，请填写 open_id。'`, `'service.agent-kit-feishu': '飞书'` and the English equivalents (`'App ID'`, `'Domain'`, `'Feishu'`, `'Lark (international)'`, `'User open_id'`, `'Feishu bots cannot search people by name; enter an open_id.'`, `'Feishu'`). The locale test checks `zh` and `en` have the same keys.
5. Fix every test that references the renamed keys: `grep -rn "dingtalk\.routes\|dingtalk\.unmatched" admin/tests admin/src` and replace with the new keys.

- [ ] **Step 4: Wire the panels and the Feishu form**

1. `admin/src/client/service-card.tsx`:
   - import `ChannelRoutesPanel` from `'./channel-routes.js'` (remove the DingTalk import);
   - replace `{enabled && service.id !== 'agent-kit-dingtalk' && (` with `{enabled && service.id !== 'agent-kit-dingtalk' && (` unchanged for the form block, but change the routes line to:

```tsx
        {enabled && (service.id === 'agent-kit-dingtalk' || service.id === 'agent-kit-feishu') && (
          <ChannelRoutesPanel channel={service.id === 'agent-kit-feishu' ? 'feishu' : 'dingtalk'} config={config} onChange={setConfig} status={props.status} api={props.api} disabled={disabled} t={t} />
        )}
```

     so the Feishu card shows both its form (via `FORMS`) and the routes panel.
2. `admin/src/client/settings-page.tsx`: import `ChannelUnmatchedPanel` from `'./channel-unmatched.js'` (remove the DingTalk import); replace `<DingtalkUnmatchedPanel api={api} t={t} />` with `<ChannelUnmatchedPanel channel="dingtalk" api={api} t={t} />`, and add inside the `ServiceCard` children:

```tsx
            {s.id === 'agent-kit-feishu' && s.enabled && status.writable && <ChannelUnmatchedPanel channel="feishu" api={api} t={t} />}
```

3. `admin/src/client/forms.tsx`: add the Feishu form and register it in `FORMS` (find `export const FORMS` and add `'agent-kit-feishu': FeishuForm`):

```tsx
/** 飞书机器人：App ID 与域名；App Secret 走卡片下方的密钥面板。 */
function FeishuForm(p: FormProps) {
  const domain = (p.config.domain as string | undefined) ?? 'feishu'
  return (
    <>
      {text(p, 'appId', p.t('feishu.appId'))}
      <Field label={p.t('feishu.domain')}>
        {(id) => (
          <select id={id} disabled={p.disabled} value={domain} onChange={(e) => p.onChange({ ...p.config, domain: e.target.value })}>
            <option value="feishu">{p.t('feishu.domain.feishu')}</option>
            <option value="lark">{p.t('feishu.domain.lark')}</option>
          </select>
        )}
      </Field>
    </>
  )
}
```

4. `feishu-target` field kind:
   - `admin/src/admin/entry.ts`: add `'feishu-target'` to `EntryFieldKind` (and update its doc comment: `` `feishu-target` 是飞书群（`{ chatId }`）或用户（`{ openId }`） ``). Check `assertEntry` validates kinds against a list (`grep -n "dingtalk-target" admin/src/admin/entry.ts`) and add `'feishu-target'` there too.
   - `admin/src/client/remote.ts`: add `'feishu-target'` to `EntryField.kind`.
   - `admin/src/client/forms.tsx`: in `EntryInput`, add `case 'feishu-target': return <FeishuTargetInput id={id} value={value} onChange={set} disabled={p.disabled} api={p.api} t={p.t} />`; change `DingtalkTargetInput`'s search call from `api.dingtalkSearchRecipients(kind, query.trim())` to `api.channelSearchRecipients('dingtalk', kind, query.trim())` (and its result type to `ChannelRecipientSearchResult`); add:

```tsx
/** 飞书：按群名搜索机器人所在的群（存 `{ chatId }`），个人只能手动填写 open_id（存 `{ openId }`）。 */
function FeishuTargetInput({ id, value, onChange, disabled, api, t }: { id: string; value: unknown; onChange(value: unknown): void; disabled: boolean; api?: AdminApi; t: T }) {
  const current = value && typeof value === 'object' && !Array.isArray(value) ? value as Config : {}
  const [kind, setKind] = useState<'group' | 'user'>(current.openId ? 'user' : 'group')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState('')
  const [result, setResult] = useState<ChannelRecipientSearchResult>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const selected = current.chatId ?? current.openId
  const search = async () => {
    if (!api || query.trim().length < 2) return
    setLoading(true)
    setError(undefined)
    setResult(undefined)
    try {
      setResult(await api.channelSearchRecipients('feishu', 'group', query.trim()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="agent-kit-target-picker">
      <select aria-label={t('recipient.kind')} value={kind} disabled={disabled} onChange={(e) => { setKind(e.target.value as 'group' | 'user'); setQuery(''); setResult(undefined) }}>
        <option value="group">{t('recipient.group')}</option>
        <option value="user">{t('recipient.user')}</option>
      </select>
      {kind === 'group' ? (
        <div className="agent-kit-target-search">
          <input id={id} value={query} disabled={disabled} placeholder={t('recipient.groupQuery')} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" className="agent-kit-btn" disabled={disabled || loading || !api || query.trim().length < 2} onClick={() => void search()}>{t('recipient.search')}</button>
        </div>
      ) : (
        <div className="agent-kit-target-search">
          <input id={id} value={openId} disabled={disabled} placeholder={t('recipient.openId')} onChange={(e) => setOpenId(e.target.value)} />
          <button type="button" className="agent-kit-btn" disabled={disabled || !openId.trim()} onClick={() => { onChange({ openId: openId.trim() }); setOpenId('') }}>{t('recipient.select')}</button>
          <small>{t('recipient.feishuUserHint')}</small>
        </div>
      )}
      {selected && <div className="agent-kit-hint">{t('recipient.selected')}（{current.chatId ? t('recipient.group') : t('recipient.user')}）: <code>{String(selected)}</code> <button type="button" className="agent-kit-btn" disabled={disabled} onClick={() => onChange(undefined)}>{t('recipient.clear')}</button></div>}
      {result && <div className="agent-kit-route-suggestions">
        {result.candidates.length === 0 && <p className="agent-kit-hint">{t('recipient.empty')}</p>}
        {result.candidates.map((candidate) => {
          const candidateId = Object.values(candidate.target)[0]!
          return <button type="button" className="agent-kit-btn" key={candidateId} disabled={disabled} onClick={() => onChange(candidate.target)}>{candidate.name} · {candidateId}</button>
        })}
        {!result.complete && <p className="agent-kit-hint">{t('recipient.incomplete')}</p>}
      </div>}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
```

     If the locale has no `recipient.select` key, add `'recipient.select': '使用'` / `'Use'` to both dictionaries.

- [ ] **Step 5: Run tests and build**

Run: `cd admin && npm run typecheck && npx vitest run && npm run build`
Expected: all pass, including the locale key-parity test and `client-build.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add admin
git commit -m "feat(admin): generic routes and unmatched panels, Feishu card and feishu-target fields"
```

---

### Task 8: doctor 与 setup 支持飞书

**Files:**
- Create: `admin/src/feishu-probe.ts`
- Create: `admin/src/checks/feishu.ts`
- Modify: `admin/src/checks/run.ts`（`SERVICE_CHECKS`）、`admin/src/checks/types.ts`（`CheckContext.feishuProbe?`）
- Modify: `admin/src/cli/setup.ts`、`admin/src/cli/messages.ts`
- Test: `admin/tests/unit/checks.test.ts`、`admin/tests/unit/cli-setup.test.ts`

**Interfaces:**
- Consumes: `KitId` with `'agent-kit-feishu'`（Task 6）；`describeSecretRef`、`saveSecretRef`、`resolveSecretRef`（`@baoyx/dsh-agent-kit/secrets`）；`FEISHU_APP_SECRET_REF`
- Produces:
  ```ts
  // admin/src/feishu-probe.ts
  export interface FeishuProbeResult { ok: boolean; botName?: string; detail: string }
  export type FeishuProbe = (input: { appId: string; appSecret: string; domain: 'feishu' | 'lark' }) => Promise<FeishuProbeResult>
  export const probeFeishu: FeishuProbe   // POST tenant_access_token/internal，再 GET bot/v3/info，5 秒超时
  export function sendFeishuTestMessage(input: { appId: string; appSecret: string; domain: 'feishu' | 'lark'; chatId: string; text: string }): Promise<{ ok: boolean; detail: string }>
  // CheckContext 新增可选字段 feishuProbe?: FeishuProbe（测试替换）
  // SetupDeps 新增可选字段 feishuProbe?: FeishuProbe、sendFeishuTest?: typeof sendFeishuTestMessage
  ```

- [ ] **Step 1: Write the failing tests**

In `admin/tests/unit/checks.test.ts`, add (using the file's `ctx()` / `snapshot()` / `byId()` helpers):

```ts
describe('feishu checks', () => {
  const feishu = (config: Record<string, unknown>) => snapshot({ 'agent-kit-feishu': { enabled: true, config } })

  it('reports SDK, appId, secret source and a working credential', async () => {
    const report = await runChecks(ctx({
      snapshot: feishu({ appId: 'cli_x' }),
      resolveModule: (name) => name === '@larksuiteoapi/node-sdk',
      env: { FEISHU_APP_SECRET: 's' },
      feishuProbe: async () => ({ ok: true, botName: '告警机器人', detail: 'ok' }),
    }))
    expect(byId(report.results, 'agent-kit-feishu.sdk')).toMatchObject({ status: 'pass' })
    expect(byId(report.results, 'agent-kit-feishu.appId')).toMatchObject({ status: 'pass' })
    expect(byId(report.results, 'agent-kit-feishu.secret')).toMatchObject({ status: 'pass', detail: expect.stringContaining('环境变量') })
    expect(byId(report.results, 'agent-kit-feishu.credential')).toMatchObject({ status: 'pass', detail: expect.stringContaining('告警机器人') })
  })

  it('fails with install and configuration fixes, and skips the credential check without a secret', async () => {
    const report = await runChecks(ctx({ snapshot: feishu({}), resolveModule: () => false, env: {}, feishuProbe: async () => { throw new Error('should not be called') } }))
    expect(byId(report.results, 'agent-kit-feishu.sdk')).toMatchObject({ status: 'fail', fix: expect.stringContaining('add @larksuiteoapi/node-sdk') })
    expect(byId(report.results, 'agent-kit-feishu.appId')).toMatchObject({ status: 'fail' })
    expect(byId(report.results, 'agent-kit-feishu.secret')).toMatchObject({ status: 'fail' })
    expect(byId(report.results, 'agent-kit-feishu.credential')).toMatchObject({ status: 'skip' })
  })

  it('fails the credential check with the probe detail', async () => {
    const report = await runChecks(ctx({ snapshot: feishu({ appId: 'cli_x' }), resolveModule: () => true, env: { FEISHU_APP_SECRET: 's' }, feishuProbe: async () => ({ ok: false, detail: '10003 invalid app_secret' }) }))
    expect(byId(report.results, 'agent-kit-feishu.credential')).toMatchObject({ status: 'fail', detail: expect.stringContaining('10003') })
  })
})
```

Check the `ctx()` helper passes `env` and `keyStore` such that `describeSecretRef` sees the env value (`grep -n "function ctx" -A12 admin/tests/unit/checks.test.ts`); if the secret check reads the env through `ctx.keyStore.env`, pass `keyStore: { env: { FEISHU_APP_SECRET: 's' }, credentialsFile: '/nonexistent' }` instead.

In `admin/tests/unit/cli-setup.test.ts`, add a test following the file's existing scripted-prompter pattern (read one existing test first and copy its harness):
- select services including `agent-kit-feishu` and `agent-kit-notify`;
- answer App ID `cli_x`, domain `feishu`, App Secret `s3cret` (password), decline the test message;
- default notify channel prompt appears with both `钉钉` and `飞书`, answer `feishu`;
- with `deps.feishuProbe` returning `{ ok: true, botName: 'bot', detail: 'ok' }` and `deps.keyStore` pointing at a temp credentials file;
- assert the written `cordis.patch.yml` has `agent-kit-feishu` enabled with `appId: cli_x` and `agent-kit-notify` with `channel: feishu`, and that `resolveSecretRef('FEISHU_APP_SECRET', keyStore)` returns `s3cret`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd admin && npx vitest run tests/unit/checks.test.ts tests/unit/cli-setup.test.ts`
Expected: FAIL — no `agent-kit-feishu.*` checks and setup never asks for Feishu.

- [ ] **Step 3: Implement the probe**

Create `admin/src/feishu-probe.ts`:

```ts
/** 飞书凭据检查与测试消息；doctor 与 setup 共用，不依赖飞书 SDK。 */
export interface FeishuProbeResult {
  ok: boolean
  botName?: string
  detail: string
}

export type FeishuProbe = (input: { appId: string; appSecret: string; domain: 'feishu' | 'lark' }) => Promise<FeishuProbeResult>

const BASE = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' } as const
const TIMEOUT_MS = 5000

async function tenantToken(input: { appId: string; appSecret: string; domain: 'feishu' | 'lark' }): Promise<{ token?: string; detail: string }> {
  const res = await fetch(`${BASE[input.domain]}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string }
  return data.code === 0 && data.tenant_access_token ? { token: data.tenant_access_token, detail: 'ok' } : { detail: `${data.code ?? res.status} ${data.msg ?? ''}`.trim() }
}

export const probeFeishu: FeishuProbe = async (input) => {
  try {
    const { token, detail } = await tenantToken(input)
    if (!token) return { ok: false, detail: `获取 tenant_access_token 失败：${detail}` }
    const res = await fetch(`${BASE[input.domain]}/open-apis/bot/v3/info`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const data = (await res.json()) as { code?: number; msg?: string; bot?: { app_name?: string } }
    if (data.code !== 0) return { ok: false, detail: `查询机器人信息失败（是否已开启机器人能力？）：${data.code ?? res.status} ${data.msg ?? ''}`.trim() }
    return { ok: true, ...(data.bot?.app_name ? { botName: data.bot.app_name } : {}), detail: '凭据有效' }
  } catch (e) {
    return { ok: false, detail: `请求飞书失败：${(e as Error).message}` }
  }
}

export async function sendFeishuTestMessage(input: { appId: string; appSecret: string; domain: 'feishu' | 'lark'; chatId: string; text: string }): Promise<{ ok: boolean; detail: string }> {
  try {
    const { token, detail } = await tenantToken(input)
    if (!token) return { ok: false, detail: `获取 tenant_access_token 失败：${detail}` }
    const res = await fetch(`${BASE[input.domain]}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ receive_id: input.chatId, msg_type: 'text', content: JSON.stringify({ text: input.text }) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = (await res.json()) as { code?: number; msg?: string }
    return data.code === 0 ? { ok: true, detail: '测试消息已发送' } : { ok: false, detail: `发送失败：${data.code ?? res.status} ${data.msg ?? ''}`.trim() }
  } catch (e) {
    return { ok: false, detail: `请求飞书失败：${(e as Error).message}` }
  }
}
```

- [ ] **Step 4: Implement the doctor checks**

1. `admin/src/checks/types.ts`: add to `CheckContext`:

```ts
  /** 飞书凭据检查；不传时用 `probeFeishu`（真实请求，5 秒超时）。 */
  feishuProbe?: FeishuProbe
```

   importing `type FeishuProbe` from `'../feishu-probe.js'`.
2. Create `admin/src/checks/feishu.ts`:

```ts
import { describeSecretRef, resolveSecretRef } from '@baoyx/dsh-agent-kit/secrets'
import { probeFeishu } from '../feishu-probe.js'
import type { Check, CheckResult } from './types.js'

type FeishuCheckConfig = { appId?: string; appSecretRef?: string; domain?: 'feishu' | 'lark' }

const PERMISSIONS = 'im:message:send_as_bot、im:message.group_at_msg:readonly、im:message.p2p_msg:readonly'
const SOURCE: Record<string, string> = { env: '环境变量', credentials: 'dsh 凭据文件' }

export const feishuChecks: Check = async (ctx) => {
  const scope = 'agent-kit-feishu' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as FeishuCheckConfig
  const ref = config.appSecretRef ?? 'FEISHU_APP_SECRET'
  const keyStore = { ...ctx.keyStore, env: ctx.env }
  const sdk = ctx.resolveModule('@larksuiteoapi/node-sdk')
  const secret = await describeSecretRef(ref, keyStore)
  const results: CheckResult[] = [
    { id: `${scope}.sdk`, scope, title: '@larksuiteoapi/node-sdk 已安装', status: sdk ? 'pass' : 'fail', detail: sdk ? '已安装' : '未安装', ...(sdk ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @larksuiteoapi/node-sdk` }) },
    { id: `${scope}.appId`, scope, title: '飞书 App ID', status: config.appId ? 'pass' : 'fail', detail: config.appId ? config.appId : '未填写', ...(config.appId ? {} : { fix: '在设置页或 setup 中填写 App ID' }) },
    { id: `${scope}.secret`, scope, title: `飞书 App Secret（${ref}）`, status: secret.configured ? 'pass' : 'fail', detail: secret.configured ? `已配置（来源：${SOURCE[secret.source!] ?? secret.source}）` : '未配置', ...(secret.configured ? {} : { fix: `在设置页保存 App Secret，或设置环境变量 ${ref}` }) },
  ]
  if (!config.appId || !secret.configured) {
    results.push({ id: `${scope}.credential`, scope, title: '飞书凭据有效', status: 'skip', detail: '缺少 App ID 或 App Secret，跳过' })
    return results
  }
  const value = (await resolveSecretRef(ref, keyStore))!.value
  const r = await (ctx.feishuProbe ?? probeFeishu)({ appId: config.appId, appSecret: value, domain: config.domain ?? 'feishu' })
  results.push({
    id: `${scope}.credential`,
    scope,
    title: '飞书凭据有效',
    status: r.ok ? 'pass' : 'fail',
    detail: r.ok ? `机器人：${r.botName ?? '未知'}；另需在开发者后台开通权限 ${PERMISSIONS}，事件订阅选长连接` : r.detail,
    ...(r.ok ? {} : { fix: '核对 App ID / App Secret，并在飞书开发者后台开启机器人能力' }),
  })
  return results
}
```

   Check whether `KeyStoreOptions` has an `env` member (`grep -n "env" src/secrets/key-store.ts src/secrets/*.ts | head`); `resolveSecretRef` reads `o.env ?? process.env`, so passing `env: ctx.env` makes the checks follow the doctor's environment. If the type lacks `env`, add it only if `resolveSecretRef`'s options already declare it (they do: `(o.env ?? process.env)`).
3. `admin/src/checks/run.ts`: import `feishuChecks` and add `'agent-kit-feishu': feishuChecks` to `SERVICE_CHECKS`.

- [ ] **Step 5: Implement setup**

In `admin/src/cli/setup.ts`:

1. Extend `SetupDeps`:

```ts
  /** 飞书凭据检查与测试消息，测试可替换。 */
  feishuProbe?: FeishuProbe
  sendFeishuTest?: typeof sendFeishuTestMessage
```

2. Add messages to `admin/src/cli/messages.ts` under a new `// ---- feishu ----` section:

```ts
export const FEISHU_APP_ID_MESSAGE = '飞书 App ID（开发者后台 → 凭证与基础信息）'
export const FEISHU_DOMAIN_MESSAGE = '使用飞书还是 Lark 国际版'
export const FEISHU_DOMAIN_CHOICES = [
  { value: 'feishu' as const, name: '飞书' },
  { value: 'lark' as const, name: 'Lark（国际版）' },
]
export const FEISHU_SECRET_MESSAGE = '飞书 App Secret（只写入 dsh 凭据文件）'
export function feishuSecretFoundMessage(ref: string, source: string): string {
  return `已找到 ${ref}（来源：${source}），继续使用？`
}
export function feishuProbeResult(ok: boolean, detail: string, botName?: string): string {
  return ok ? `飞书凭据有效，机器人：${botName ?? '未知'}\n` : `飞书凭据检查失败：${detail}\n`
}
export const FEISHU_SDK_MISSING = (profile: string) => `未安装 @larksuiteoapi/node-sdk，启用飞书前请运行：dsh plugin --profile ${profile} add @larksuiteoapi/node-sdk\n`
export const FEISHU_PERMISSIONS_HINT = '请确认飞书开发者后台已开启机器人能力，事件订阅选择长连接并订阅「接收消息 v2.0」，开通权限 im:message:send_as_bot、im:message.group_at_msg:readonly、im:message.p2p_msg:readonly。\n'
export const FEISHU_TEST_CONFIRM = '向一个飞书群发送测试消息？'
export const FEISHU_TEST_CHAT_MESSAGE = '群 chat_id（oc_ 开头，机器人需已在群里）'
```

3. Add `configureFeishu`:

```ts
/** 飞书：App ID、域名、App Secret（凭据文件），随后检查凭据。 */
async function configureFeishu(p: Prompter, current: Config, keyStore: KeyStoreOptions, io: CliIO, deps: SetupDeps, ctx: CheckContext, profileName: string): Promise<Config> {
  if (!ctx.resolveModule('@larksuiteoapi/node-sdk')) io.out(msg.FEISHU_SDK_MISSING(profileName))
  const appId = await p.input(msg.FEISHU_APP_ID_MESSAGE, current.appId as string | undefined, nonEmpty)
  const domain = await p.select(msg.FEISHU_DOMAIN_MESSAGE, msg.FEISHU_DOMAIN_CHOICES, (current.domain as 'feishu' | 'lark') ?? 'feishu')
  const config: Config = { ...current, appId, domain }
  const ref = (config.appSecretRef as string | undefined) ?? FEISHU_APP_SECRET_REF
  const existing = await describeSecretRef(ref, keyStore)
  if (!(existing.configured && (await p.confirm(msg.feishuSecretFoundMessage(ref, existing.source!), true)))) {
    await saveSecretRef(ref, await p.password(msg.FEISHU_SECRET_MESSAGE), keyStore)
  }
  const secret = await resolveSecretRef(ref, keyStore)
  if (secret) {
    const r = await (deps.feishuProbe ?? probeFeishu)({ appId, appSecret: secret.value, domain })
    io.out(msg.feishuProbeResult(r.ok, r.detail, r.botName))
  }
  io.out(msg.FEISHU_PERMISSIONS_HINT)
  return config
}
```

   imports: `FEISHU_APP_SECRET_REF` from `'@baoyx/dsh-agent-kit/feishu'`; `resolveSecretRef` added to the existing `'@baoyx/dsh-agent-kit/secrets'` import; `probeFeishu, sendFeishuTestMessage, type FeishuProbe` from `'../feishu-probe.js'`.

4. In `runSetup`:
   - `const ids: KitId[] = ['agent-kit-ws', 'agent-kit-dingtalk', 'agent-kit-feishu', 'agent-kit-notify', 'agent-kit-agent-tasks', 'agent-kit-jev']`
   - replace the `channelRows` / `enabledChannels` lines with:

```ts
  const channelRows: Record<NotifyChannel, KitId | undefined> = { dingtalk: 'agent-kit-dingtalk', feishu: 'agent-kit-feishu', wecom: undefined }
  const enabledChannels = NOTIFY_CHANNELS.filter((c) => channelRows[c] !== undefined && enabled.includes(channelRows[c]!))
  // 只有带 CLI 的渠道需要安装检查
  await installMissingClis(p, io, deps, ctx.findExecutable, enabledChannels.filter((c): c is ChannelCliId & NotifyChannel => c in CHANNEL_CLIS))
```

   - add the Feishu branch to the per-row config dispatch: `: id === 'agent-kit-feishu' ? await configureFeishu(p, current, keyStore, io, deps, ctx, profile.name)`.
   - after the DingTalk test-message block, add:

```ts
  const feishu = changes['agent-kit-feishu']
  if (feishu?.enabled && (await p.confirm(msg.FEISHU_TEST_CONFIRM, false))) {
    const config = feishu.config as { appId: string; domain?: 'feishu' | 'lark'; appSecretRef?: string }
    const secret = await resolveSecretRef(config.appSecretRef ?? FEISHU_APP_SECRET_REF, keyStore)
    if (secret) {
      const chatId = await p.input(msg.FEISHU_TEST_CHAT_MESSAGE, undefined, nonEmpty)
      const r = await (deps.sendFeishuTest ?? sendFeishuTestMessage)({ appId: config.appId, appSecret: secret.value, domain: config.domain ?? 'feishu', chatId, text: msg.dingtalkTestMarkdown() })
      io.out(`${r.detail}\n`)
    }
  }
```

   `configureNotify` already offers a select when `NOTIFY_CHANNELS` has more than one entry; with `feishu` in `CHANNEL_NAMES` the "钉钉 / 飞书" choice now appears. The `wecom` key in `channelRows` keeps the `Record<NotifyChannel, …>` exhaustive; it never matches because `NOTIFY_CHANNELS` does not contain `wecom`.

- [ ] **Step 6: Run tests**

Run: `cd admin && npm run typecheck && npx vitest run`
Expected: all pass. Existing setup tests that walk through the notify step may now get a channel select prompt; update their scripted answers to pick `dingtalk` where they previously relied on auto-selection.

- [ ] **Step 7: Commit**

```bash
git add admin
git commit -m "feat(admin): Feishu doctor checks and setup guidance"
```

---

### Task 9: 文档与官网

**Files:**
- Modify: `README.md`
- Modify: `admin/README.md`
- Create: `website/src/pages/docs/feishu.mdx`
- Modify: `website/src/data/services.ts`、`website/src/data/config-tables.ts`、`website/src/data/changelog.ts`、`website/src/pages/docs/notify.mdx`
- Modify: `website/tests/config-tables.test.ts`

**Interfaces:**
- Consumes: public names from Tasks 1–8 (`ctx.feishu`, `FeishuConfig` fields, `FeishuErrorCode` codes, `DEFAULT_TARGET`/`'default'`, `ChannelInbox`, `channelUnmatched`)
- Produces: none

- [ ] **Step 1: Write the failing website test**

In `website/tests/config-tables.test.ts`:
- add `import { FeishuConfig } from '../../src/feishu/config'` and `['feishu', FeishuConfig]` to the `it.each` list;
- append `['陆', 'feishu']` to the expected numerals list in `'services metadata is complete and ordered'`;
- add `feishu: 'src/feishu/errors.ts'` to the error-code `sources` map.

Run: `cd website && npx vitest run`
Expected: FAIL (no `feishu` service metadata).

- [ ] **Step 2: Website data and pages**

1. `website/src/data/services.ts`: add `'feishu'` to `ServiceId`, and append a `feishu` entry modeled on the `dingtalk` entry (read it first and match its fields):
   - `numeral: '陆'`, `verb: '收发'`, `name: '飞书'`, `context: 'ctx.feishu'`, `slug: 'feishu'`, `kitId: 'agent-kit-feishu'`;
   - `summary: '飞书机器人：发送文本或 Markdown 卡片，接收群内 @ 机器人与私聊机器人的消息并按会话分发给业务插件。'`;
   - `notes`: `'机器人（自建应用）身份；需安装可选依赖 @larksuiteoapi/node-sdk ^1.76.0。'`, `'App Secret 通过 appSecretRef 引用（默认 FEISHU_APP_SECRET），先读环境变量，再读 dsh 凭据文件。'`, `'长连接接收：同一飞书应用的多个连接只有一个会收到某条消息，一个应用只接一个 Profile。'`, `'开发者后台需开启机器人能力、事件订阅选长连接，并开通 im:message:send_as_bot、im:message.group_at_msg:readonly、im:message.p2p_msg:readonly。'`;
   - `errors`: one row per `FeishuErrorCode` (`invalid_target` 否, `auth_failed` 否, `permission_denied` 否, `rate_limited` 是, `timeout` 是, `network` 是, `api_error` 'HTTP 5xx 时是'), plus `INVALID_CONFIG`, with meanings taken from the spec's error table.
2. `website/src/data/config-tables.ts`: import `FeishuConfig` from `'../../../src/feishu/config'` and add `feishu: FeishuConfig as unknown as SchemaNode` to `SCHEMAS`.
3. Create `website/src/pages/docs/feishu.mdx` following `website/src/pages/docs/dingtalk.mdx`'s structure (read it first): title `飞书`; sections 「接口」(send example with text and markdown, `onMessage` example, `onPluginMessage`, `searchRecipients('group', …)`), 「消息字段」(the `FeishuAtMessage` table from the spec), 「部署」(the deployment notes), and a `<Notice>` about one app per Profile.
4. `website/src/pages/docs/notify.mdx`: add an example after the existing code block:

```ts
// 钉钉发往配置的默认群，飞书发往指定群
await ctx.notify.send({ text: '库存告警', targets: { dingtalk: 'default', feishu: { chatId: 'oc_xxx' } } })
```

   and replace the Notice text with: `` `notify` 只负责转发，真正发送由对应渠道的 Service 完成（钉钉为已登录的 user，飞书为机器人）。`doctor` 会检查默认渠道的行是否启用。 ``
5. `website/src/data/changelog.ts`: add to the 0.3.0 `items` (after the existing items):
   - `'新增 ctx.feishu：飞书机器人（自建应用）身份，进程内使用 @larksuiteoapi/node-sdk（可选依赖）；发送文本或 Markdown 卡片，长连接接收群内 @ 机器人与私聊机器人的消息并按会话分发。'`
   - `'新增 ChannelInbox 约定与通用的未命中消息存储；notify 的 targets 可写 'default' 表示使用该渠道的默认目标。'`
   - `'admin：设置页新增飞书卡片（App ID、域名、App Secret、会话路由、未命中消息），doctor 检查 SDK、凭据与机器人能力，setup 引导配置；钉钉的路由与未命中面板改为通用组件。'`

Run: `cd website && npx vitest run`
Expected: PASS.

- [ ] **Step 3: README**

In `README.md`:
1. Intro line: add 飞书 to the list of capabilities (「钉钉 user / 飞书机器人推送与通知」).
2. 「功能」table: add a row after `ctx.dingtalk`:
   `| ctx.feishu | 飞书机器人（自建应用）：发送文本或 Markdown 卡片；长连接接收群内 @ 机器人与私聊机器人的消息，按会话 ID 下发给业务插件 |`
   and change the `ctx.notify` row's wording if it still names only DingTalk.
3. Replace the sentence「五个 Service 默认禁用」and the import-path list to include `ctx.feishu` / `@baoyx/dsh-agent-kit/feishu` (now six Services).
4. 「环境要求」: add `- 使用 ctx.feishu：安装 @larksuiteoapi/node-sdk（^1.76.0），在飞书开发者后台创建自建应用并开启机器人能力，事件订阅选长连接并订阅「接收消息 v2.0」，开通 im:message:send_as_bot、im:message.group_at_msg:readonly、im:message.p2p_msg:readonly；App Secret 用 appSecretRef 引用（默认 FEISHU_APP_SECRET）。`
5. Fix `README.md:66`（「使用 ctx.notify：同时启用 ctx.dingtalk」）to「使用 `ctx.notify`：同时启用默认渠道（钉钉或飞书）的 Service」.
6. In 「通知与钉钉登录」, add the `'default'` example from Step 2.4 and one sentence: `` `targets` 中某渠道写 `'default'`，表示发往该渠道并使用其配置的默认目标。 ``
7. Add a 「飞书」 section after the DingTalk section with: config example (`cordis.patch.yml` row with `appId`, `domain`, `groupRoutes`), the `onMessage` example, the message fields table, and the one-app-per-Profile note.
8. In 「渠道约定」, add `searchRecipients()` to the receive-side method list and mention the interface name `ChannelInbox`.
9. 「从 0.2 升级到 0.3」: add `- admin 的远程方法 dingtalkUnmatched / dingtalkSearchRecipients 改为 channelUnmatched(channel) / channelSearchRecipients(channel, …)，旧方法保留一个版本。` and `- 钉钉未命中记录新增 conversationName、senderId 字段，原 groupName、senderOpenDingtalkId 保留。`
10. Update the patch.yml/loader row list mentions (「五个 loader 行」) to include `agent-kit-feishu`, and the config table to add a `feishu` row listing its fields.

In `admin/README.md`, mention the Feishu card, its doctor checks and setup step in the feature list.

Check for leftover single-channel wording: `grep -n "固定发往钉钉\|只经钉钉\|五个 Service\|五个 loader" README.md admin/README.md website/src -r` should print nothing.

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
git add README.md admin/README.md website
git commit -m "docs: Feishu channel, ChannelInbox, and the 'default' notify target"
```

---

## Self-Review Notes

- Spec coverage:
  - §1 公共约定：`ChannelInbox`、`UnmatchedStore`、兼容字段、`groupRoutes`、搜索类型 → Task 1；`'default'` 标记 → Task 2。
  - §2 飞书 Service：接入与 SDK 加载 → Task 3 / 5；配置、发送、错误码、`dryRun` → Task 3；接收、生命周期、状态、搜索、健康 → Task 4；`CHANNEL_NAMES`、notify 类型、bundle 行、导出 → Task 5。
  - §3 admin：注册、密钥、接口 → Task 6；卡片、通用面板、`feishu-target` → Task 7；doctor、setup → Task 8。
  - §4 错误处理：`FeishuSendError`、`ConfigError`、`registerSecret`、路由器计数 → Task 3–4。
  - 测试 → each task; 真实飞书走查 is out of plan scope (manual, reported at delivery).
  - 交付与文档 → Task 9.
- Interface names used across tasks: `ChannelInbox`、`ChannelUnmatchedMessage`、`ChannelRecipientSearchResult`、`ChannelRecipientKind`、`UnmatchedStore`、`unmatchedFileKey`、`DEFAULT_TARGET`、`FeishuSdk`、`FeishuClient`、`FeishuWsHandlers`、`FeishuService.sdkLoader`、`FeishuService.keyStore`、`createFakeFeishuSdk`、`useFakeFeishuSdk`、`FeishuTarget`、`FeishuAt`、`FeishuAtMessage`、`parseFeishuEvent`、`buildCreateMessage`、`FeishuSendError`、`classifyApiCode`、`classifyThrown`、`FEISHU_APP_SECRET_REF`、`channelUnmatched`、`channelSearchRecipients`、`AdminChannel`、`ChannelRoutesPanel`、`ChannelUnmatchedPanel`、`probeFeishu`、`sendFeishuTestMessage`、`FeishuProbe`。
