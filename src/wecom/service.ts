import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ChannelInbox, ChannelMessageHandler, ChannelMessageRoute, ChannelMessageSubscription, ChannelRecipientKind, ChannelRecipientSearchResult, ChannelSendCommon, ChannelService, ChannelStatus } from '../common/channel.js'
import { MessageRouter, type MessageRouterCounts } from '../common/inbox.js'
import { UnmatchedStore, unmatchedFileKey, type ChannelUnmatchedMessage } from '../common/unmatched.js'
import { safeReply } from '../common/reply.js'
import { ConfigError } from '../common/errors.js'
import { digest, redact, registerSecret } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import { resolveSecretRef, type KeyStoreOptions } from '../secrets/index.js'
import { WecomConfig, type WecomTarget } from './config.js'
import { WecomSendError, classifyThrown } from './errors.js'
import { buildContent, resolveTarget, type WecomAt } from './message.js'
import { loadWecomSdk, type WecomConnection, type WecomFrame, type WecomSdkLoader } from './sdk.js'
import { parseWecomFrame, type WecomAtMessage } from './event.js'
import { ConversationStore } from './conversations.js'

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
  inbox: MessageRouterCounts & { listener: 'idle' | 'ready' | 'reconnecting' | 'failed'; routes: number }
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
export class WecomService extends KitService<WecomCounters> implements ChannelService<WecomTarget, WecomAt>, ChannelInbox<WecomAtMessage, ChannelUnmatchedMessage, WecomTarget> {
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
  private readonly counters: Omit<WecomCounters, 'inbox'> = { success: 0, failure: 0, lastFailureAt: null, lastErrorCode: null }
  private readonly router: MessageRouter<WecomAtMessage>
  private readonly unmatched: UnmatchedStore
  private readonly conversations: ConversationStore
  /** 收到的帧，按消息 ID 保存以便回复；按数量限制，只保留最近 1000 个。超过企业微信 24 小时窗口的帧在 SDK 处失败，归类为 api_error。 */
  private readonly frames = new Map<string, WecomFrame>()
  private listener: 'idle' | 'ready' | 'reconnecting' | 'failed' = 'idle'
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  constructor(ctx: Context, config: WecomConfig) {
    super(ctx, 'wecom')
    this.config = config
    if (!config.botId?.trim()) throw new ConfigError('wecom', 'botId is required', { field: 'botId' })
    if (config.defaultTarget) resolveTarget(config.defaultTarget)
    const groupRoutes = new Map<string, string>()
    for (const route of config.groupRoutes ?? []) {
      const conversationId = route.conversationId?.trim()
      const pluginId = route.pluginId?.trim()
      if (!conversationId || !pluginId) throw new ConfigError('wecom', 'group route requires conversationId and pluginId', { field: 'groupRoutes' })
      if (groupRoutes.has(conversationId)) throw new ConfigError('wecom', `duplicate group route: ${conversationId}`, { field: 'groupRoutes' })
      groupRoutes.set(conversationId, pluginId)
    }
    const baseUrl = (ctx as Context & { baseUrl?: string }).baseUrl
    const base = baseUrl ? join(dirname(fileURLToPath(new URL('./cordis.yml', baseUrl))), '.agent-kit') : undefined
    const key = unmatchedFileKey(config.botId)
    this.unmatched = new UnmatchedStore(base ? join(base, 'wecom-unmatched', `${key}.json`) : undefined, async () => undefined, (error) => this.logger.warn('wecom unmatched store unavailable', { error: redact(String(error)) }))
    this.conversations = new ConversationStore(base ? join(base, 'wecom-conversations', `${key}.json`) : undefined, (error) => this.logger.warn('wecom conversation store unavailable', { error: redact(String(error)) }))
    this.router = new MessageRouter<WecomAtMessage>({
      channel: 'wecom', logger: this.logger, onUnmatched: (m) => this.unmatched.add(m), pluginRoutes: groupRoutes,
      replyFor: (message) => (options) => safeReply('wecom', () => this.replyTo(message, options)),
    })
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

  protected startConnection(sdk: Awaited<ReturnType<WecomSdkLoader>>): void {
    const connection = sdk.connect(
      { botId: this.config.botId, secret: this.secret!, ...(this.config.wsUrl ? { wsUrl: this.config.wsUrl } : {}), requestTimeout: this.config.timeoutMs, logger: this.logger },
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
          // failed 是粘性状态，只有重新认证成功才能恢复
          if (this.listener !== 'failed') this.listener = 'reconnecting'
          this.router.setReady(false)
        },
        // 只有 SDK 放弃重连的终态错误才置为 failed（粘性）
        onError: (error) => this.fail(`wecom long connection failed: ${redact(error.message)}`, error),
        // 网络错误、单次认证失败：SDK 会自动重连，只告警并保持 reconnecting（健康为 degraded），不拒绝 ready
        onTransientError: (error) => {
          this.authenticated = false
          this.router.setReady(false)
          if (this.listener !== 'failed') this.listener = 'reconnecting'
          this.logger.warn('wecom long connection error, reconnecting', { error: redact(String(error?.message ?? error)) })
        },
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
          void this.conversations.record({ conversationId: parsed.message.conversationId, chatType: parsed.message.chatType, ...(parsed.message.senderId ? { lastSenderId: parsed.message.senderId } : {}) }).catch((e: unknown) => this.logger.warn('wecom conversation record failed', { error: redact(String(e)) }))
          this.router.accept(parsed.message)
        },
      },
    )
    this.connection = connection
    this.ctx.effect(() => () => {
      this.rejectWaiters(new Error('wecom service stopped'))
      connection.disconnect()
      this.router.reset()
      this.authenticated = false
      this.listener = 'idle'
    }, 'wecom.connection')
  }

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

  /**
   * 基于收到的帧回复；不受「对方须先发过消息」限制。内容校验与 send() 一致（markdown 与 text 互斥）；
   * 不支持 `idempotencyKey`（忽略）。
   */
  private async replyTo(message: WecomAtMessage, options: ChannelSendCommon & { at?: unknown }): Promise<WecomSendResult> {
    let content: string
    try {
      content = buildContent({ title: options.title, markdown: options.markdown, text: options.text, at: options.at as WecomAt | undefined })
    } catch (e) {
      const error = e instanceof WecomSendError ? e : classifyThrown(e, true)
      this.logger.warn('wecom reply failed', { traceId: options.traceId, code: error.code })
      return { results: [{ ok: false, error }] }
    }
    const frame = this.frames.get(message.eventId)
    const fail = (error: WecomSendError): WecomSendResult => {
      this.recordFailure(error.code)
      this.logger.warn('wecom reply failed', { traceId: options.traceId, code: error.code })
      return { results: [{ ok: false, error }] }
    }
    if (!frame) return fail(new WecomSendError('api_error', 'the inbound frame for this message is no longer available'))
    if (this.config.dryRun) return { results: [{ ok: true }] }
    if (!this.connection || !this.authenticated) return fail(new WecomSendError('not_connected', 'wecom long connection is not ready'))
    if (options.signal?.aborted) return fail(new WecomSendError('aborted', 'wecom reply aborted'))
    try {
      await this.connection.replyStream(frame, `reply-${message.eventId}-${Date.now().toString(36)}`, content)
      this.recordSuccess()
      return { results: [{ ok: true, messageId: frame.headers.req_id }] }
    } catch (e) {
      return fail(classifyThrown(e, true))
    }
  }

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
      return classifyThrown(e, await this.conversations.has(target.conversationId))
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
    const counters: WecomCounters = { ...this.counters, inbox: { listener: this.listener, routes: this.router.size, ...this.router.counters() } }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (!this.config.dryRun && this.listener === 'idle') return { status: 'degraded', detail: 'wecom long connection starting', counters }
    if (this.listener === 'reconnecting') return { status: 'degraded', detail: 'wecom long connection reconnecting', counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : `bot: ${this.config.botId}; @ inbox listening (${counters.inbox.routes} route(s))`, counters }
  }
}

export default WecomService
