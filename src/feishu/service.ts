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
    let timer: ReturnType<typeof setTimeout> | undefined
    const info = await Promise.race([
      this.client.botInfo(this.controller.signal).catch((e: unknown) => ({ code: -1, msg: redact(String((e as Error)?.message ?? e)) })),
      new Promise<{ code: number; msg: string }>((resolve) => {
        timer = setTimeout(() => resolve({ code: -1, msg: `timed out after ${this.config.timeoutMs}ms` }), this.config.timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
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

  /** 接收在 Task 4 中完整实现；此处只维护连接状态。 */
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
    const counters = { ...this.counters }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : `bot: ${this.botName ?? 'unknown'}`, counters }
  }
}

export default FeishuService
