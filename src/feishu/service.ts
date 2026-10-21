import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ChannelInbox, ChannelMessageHandler, ChannelMessageRoute, ChannelMessageSubscription, ChannelRecipientKind, ChannelRecipientSearchResult, ChannelSendCommon, ChannelService, ChannelStatus } from '../common/channel.js'
import { MessageRouter, type MessageRouterCounts } from '../common/inbox.js'
import { UnmatchedStore, unmatchedFileKey, type ChannelUnmatchedMessage } from '../common/unmatched.js'
import { parseFeishuEvent, type FeishuAtMessage } from './event.js'
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
  inbox: MessageRouterCounts & { listener: 'idle' | 'ready' | 'reconnecting' | 'failed'; routes: number }
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
export class FeishuService extends KitService<FeishuCounters> implements ChannelService<FeishuTarget, FeishuAt>, ChannelInbox<FeishuAtMessage, ChannelUnmatchedMessage, { chatId: string }> {
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
  private readonly router: MessageRouter<FeishuAtMessage>
  private readonly unmatched: UnmatchedStore
  private listener: 'idle' | 'ready' | 'reconnecting' | 'failed' = 'idle'
  /** 等待长连接就绪的订阅方；`markConnected()` 时统一完成，监听失败或服务停止时统一拒绝。 */
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  /** 启动时 botInfo 瞬时失败后，在长连接首次就绪时补取一次机器人信息。 */
  private botInfoRetry: 'none' | 'pending' | 'done' = 'none'
  /** 收到过私聊消息的会话；未命中记录不为它们查群名。 */
  private readonly p2pChats = new Set<string>()
  private readonly counters: Omit<FeishuCounters, 'inbox'> = { success: 0, failure: 0, lastFailureAt: null, lastErrorCode: null }

  constructor(ctx: Context, config: FeishuConfig) {
    super(ctx, 'feishu')
    this.config = config
    if (!config.appId?.trim()) throw new ConfigError('feishu', 'appId is required', { field: 'appId' })
    if (config.defaultTarget) buildCreateMessage({ target: config.defaultTarget, text: '' })
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
    const info = await this.fetchBotInfo()
    if (info.kind === 'rejected') {
      // 只有飞书明确返回的业务错误码（凭据错误、应用停用等）才视为永久失败
      const detail = `feishu credential check failed: ${info.code} ${info.msg}`.trim()
      this.markFailed(detail)
      this.rejectWaiters(new Error(detail))
      return
    }
    if (info.kind === 'transient') {
      // 超时 / 网络错误：长连接客户端会自行重连，照常启动，机器人信息在连上后补取
      this.logger.warn('feishu bot info unavailable at startup; starting long connection anyway', { error: info.msg })
      this.botInfoRetry = 'pending'
    }
    // 启动期间服务已被卸载：不再建立长连接（清理 effect 无法再注册，连接会泄漏并抢走集群消息）
    if (this.stopping) return
    this.startReceiving()
  }

  /**
   * 服务是否正在卸载。Cordis 在 `[Service.init]` 期间被 dispose 时会先清空 `fiber.uid`，
   * 等 init 结束后才执行清理 effect（届时才 abort `controller`），所以两者都要看。
   */
  private get stopping(): boolean {
    return this.controller.signal.aborted || this.ctx.fiber.uid === null
  }

  /** 查询机器人信息，区分明确的业务拒绝与瞬时故障；成功时记录名称与 open_id。 */
  private async fetchBotInfo(): Promise<{ kind: 'ok' } | { kind: 'rejected'; code: number; msg: string } | { kind: 'transient'; msg: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    type Outcome = { kind: 'ok' } | { kind: 'rejected'; code: number; msg: string } | { kind: 'transient'; msg: string }
    const request = this.client!.botInfo(this.controller.signal, this.config.timeoutMs).then(
      (info): Outcome => {
        if (info.code !== undefined && info.code !== 0) return { kind: 'rejected', code: info.code, msg: redact(info.msg ?? '') }
        this.botName = info.bot?.app_name ?? this.botName
        this.botOpenId = info.bot?.open_id ?? this.botOpenId
        return { kind: 'ok' }
      },
      (e: unknown): Outcome => {
        const err = e as { message?: string; response?: { status?: number; data?: { code?: number; msg?: string } } }
        const apiCode = err?.response?.data?.code
        const status = err?.response?.status
        // HTTP 4xx 且带业务码同样是明确拒绝；5xx 按瞬时故障处理
        if (typeof apiCode === 'number' && apiCode !== 0 && !(typeof status === 'number' && status >= 500)) {
          return { kind: 'rejected', code: apiCode, msg: redact(err.response?.data?.msg ?? '') }
        }
        return { kind: 'transient', msg: redact(String(err?.message ?? e)) }
      },
    )
    return Promise.race([
      request,
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'transient', msg: `timed out after ${this.config.timeoutMs}ms` }), this.config.timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
  }

  /** 长连接首次就绪时补取启动阶段没拿到的机器人信息（只重试一次）。 */
  private retryBotInfo(): void {
    if (this.botInfoRetry !== 'pending') return
    this.botInfoRetry = 'done'
    void this.fetchBotInfo().then((info) => {
      if (info.kind !== 'ok') this.logger.warn('feishu bot info still unavailable', { detail: info.kind === 'rejected' ? `${info.code} ${info.msg}` : info.msg })
    })
  }

  protected sdkOptions() {
    return { appId: this.config.appId, appSecret: this.appSecret!, domain: this.config.domain, logger: this.logger }
  }

  protected startReceiving(): void {
    const ws = this.sdk!.startWs(this.sdkOptions(), {
      onReady: () => {
        this.markConnected()
        this.retryBotInfo()
      },
      onReconnected: () => {
        this.markConnected()
        this.retryBotInfo()
      },
      onReconnecting: () => {
        this.connected = false
        this.listener = 'reconnecting'
        this.router.setReady(false)
      },
      onError: (error) => {
        this.connected = false
        this.listener = 'failed'
        this.router.setReady(false)
        const detail = `feishu long connection failed: ${redact(error.message)}`
        this.markFailed(detail, error)
        this.rejectWaiters(new Error(detail))
      },
      // 飞书要求 3 秒内返回：这里只解析、入队，投递由路由器异步完成
      onMessage: (event) => {
        const message = parseFeishuEvent(event, this.botOpenId)
        if (!message) {
          this.router.drop()
          this.logger.warn('invalid feishu event dropped')
          return
        }
        if (message.chatType === 'p2p') this.p2pChats.add(message.conversationId)
        this.router.accept(message)
      },
    })
    this.ctx.effect(() => () => {
      this.rejectWaiters(new Error('feishu service stopped'))
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
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  /** 新订阅的 ready：已就绪立即完成，已失败立即拒绝，否则等待。调用方不 await 时拒绝也不会成为未处理的 rejection。 */
  private readyPromise(): Promise<void> {
    if (this.listener === 'ready') return Promise.resolve()
    const promise = this.listener === 'failed' || this.failure
      ? Promise.reject(new Error(this.failure ?? 'feishu long connection failed'))
      : new Promise<void>((resolve, reject) => { this.readyWaiters.push({ resolve, reject }) })
    promise.catch(() => {})
    return promise
  }

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
      ready: this.readyPromise(),
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

  /** 按群名搜索机器人所在的群与它可见的公开群（选中机器人不在的群时发送会报 permission_denied）；机器人身份无法按姓名搜人，个人请填写 open_id。 */
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
    // 私聊没有群名，不必为每条未命中的私聊消息调用接口
    if (!this.client || this.p2pChats.has(chatId)) return undefined
    const r = await this.client.getChat(chatId, this.controller.signal)
    return r.code === 0 && r.data?.name?.trim() ? r.data.name.trim() : undefined
  }

  /**
   * 发送一条消息。超时（`timeout`）只代表本端没等到响应，飞书仍可能稍后投递成功；
   * 需要安全重试时请传 `idempotencyKey`，飞书按它去重。
   */
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
        await this.sleep(500 * 2 ** attempt, options.signal)
        continue
      }
      this.recordFailure(error.code)
      this.logger.warn('feishu send failed', { traceId: options.traceId, code: error.code })
      return { results: [{ ok: false, error }] }
    }
  }

  /** 可被调用方信号或服务销毁提前唤醒的等待。 */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const signals = [this.controller.signal, ...(signal ? [signal] : [])]
      const done = () => {
        clearTimeout(timer)
        for (const s of signals) s.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      for (const s of signals) {
        if (s.aborted) return done()
        s.addEventListener('abort', done, { once: true })
      }
    })
  }

  /** 成功返回 message_id，失败返回分类后的错误。 */
  private async sendOnce(req: Parameters<FeishuClient['createMessage']>[0], signal?: AbortSignal): Promise<string | FeishuSendError> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = AbortSignal.any([timeout, this.controller.signal, ...(signal ? [signal] : [])])
    // 已中止则不发起 API 调用
    if (combined.aborted) return timeout.aborted ? new FeishuSendError('timeout', `feishu send timed out after ${this.config.timeoutMs}ms`) : new FeishuSendError('aborted', 'feishu send aborted')
    try {
      const r = await Promise.race([
        this.client!.createMessage(req, combined),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(timeout.aborted ? new FeishuSendError('timeout', `feishu send timed out after ${this.config.timeoutMs}ms`) : new FeishuSendError('aborted', 'feishu send aborted'))
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
    const counters: FeishuCounters = { ...this.counters, inbox: { listener: this.listener, routes: this.router.size, ...this.router.counters() } }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (!this.config.dryRun && this.listener === 'idle') return { status: 'degraded', detail: 'feishu long connection starting', counters }
    if (this.listener === 'reconnecting') return { status: 'degraded', detail: 'feishu long connection reconnecting', counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : `bot: ${this.botName ?? 'unknown'}; @ inbox listening (${counters.inbox.routes} route(s))`, counters }
  }
}

export default FeishuService
