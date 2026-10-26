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
