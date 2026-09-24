import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { raceAbort } from '../common/abort.js'
import { ConfigError, KitError, type ConfigInput } from '../common/errors.js'
import { BASE_ENV_WHITELIST, pickEnv, runProcess } from '../common/process.js'
import { redactValue, registerSecret } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import type { Answers, EntryType, JevUsage, Questions } from './types.js'

export const JEV_API_KEY_ENV = 'TYPESAFE_API_KEY'

export interface JevConfig {
  model: string
  timeoutMs: number
  /** macOS 钥匙串中保存 API Key 的服务名（可给多个，按顺序尝试）；仅在未设置 TYPESAFE_API_KEY 时读取。 */
  keychainService?: string | string[]
  /** 钥匙串条目的账户名，默认当前用户（$USER）。 */
  keychainAccount?: string
}

const KeychainName = z.string().pattern(/^[\w.@:-]{1,128}$/)

/** 与其他工具（如 gitflow-cli）共享 TypeSafe Key 时推荐的钥匙串服务名。 */
export const SHARED_KEYCHAIN_SERVICE = 'ai.typesafe.api-key'

export const JevConfig: z<ConfigInput<JevConfig>, JevConfig> = z.object({
  model: z.string().default('jev-latest').description('SDK 支持的模型名'),
  timeoutMs: z.natural().step(1).min(1000).max(300_000).default(30_000).description('一次 judge() 的总时长，包含 SDK 内部重试'),
  keychainService: z
    .union([KeychainName, z.array(KeychainName)])
    .description('macOS 钥匙串服务名，推荐共享名 ai.typesafe.api-key；可给列表按顺序尝试'),
  keychainAccount: z.string().pattern(/^[\w.@:-]{1,128}$/).description('钥匙串账户名，默认 $USER'),
}) as z<ConfigInput<JevConfig>, JevConfig>

/** 从钥匙串读取密钥；找不到时返回 undefined。 */
export type KeychainReader = (service: string, account: string) => Promise<string | undefined>

/** 通过 `/usr/bin/security find-generic-password -w` 读取 macOS 钥匙串（不经过 shell，5 秒超时）。 */
export const macosKeychainReader: KeychainReader = async (service, account) => {
  const r = await runProcess('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], {
    env: pickEnv(BASE_ENV_WHITELIST),
    timeoutMs: 5000,
    killGraceMs: 500,
    maxOutputBytes: 64 * 1024,
  })
  if (r.exitCode !== 0) return undefined
  const key = r.stdout.replace(/[\r\n]+$/, '')
  return key.trim() ? key : undefined
}

export type JevErrorCode = 'unavailable' | 'rate_limited' | 'unauthorized' | 'bad_request' | 'aborted'

export class JevError extends KitError {
  declare readonly code: JevErrorCode
  constructor(code: JevErrorCode, message: string, options: { cause?: unknown; details?: Record<string, unknown> } = {}) {
    super('jev', code, message, { retryable: code === 'unavailable' || code === 'rate_limited', ...options })
    this.name = 'JevError'
  }
}

export interface JudgeOptions<Q extends Questions> {
  state: EntryType
  questions: Q
  model?: string
  signal?: AbortSignal
  traceId?: string
}

export interface JudgeResult<Q extends Questions> {
  model: string
  answers: Answers<Q>
  usage?: JevUsage
}

export interface JevCounters {
  success: number
  failure: number
  failuresByCode: Partial<Record<JevErrorCode, number>>
}

/** SDK 客户端中本包用到的部分，便于测试替换。 */
export interface JevClient {
  systemOne(
    request: { state: EntryType; questions: Questions; model?: string },
    options?: { signal?: AbortSignal },
  ): PromiseLike<{ model: string; answers: Record<string, unknown>; usage?: JevUsage }>
}

export type JevClientFactory = (options: { apiKey: string; model: string; timeoutMs: number }) => Promise<JevClient>

/** 默认从 @typesafe-ai/sdk 创建客户端（可选 peer，只在启用 jev 时加载）。 */
export const defaultClientFactory: JevClientFactory = async ({ apiKey, model, timeoutMs }) => {
  let sdk: typeof import('@typesafe-ai/sdk')
  try {
    sdk = await import('@typesafe-ai/sdk')
  } catch (e) {
    throw new ConfigError('jev', '@typesafe-ai/sdk is not installed; it is required when the jev service is enabled', { cause: (e as Error).message })
  }
  // SDK 的 timeout 是单次尝试的超时，总时长由本包控制
  return new sdk.TypeSafeClient({ apiKey, defaultModel: model, timeout: timeoutMs, logLevel: 'off' })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    jev: JevService
  }
}

function statusOf(e: unknown): number | undefined {
  const status = (e as { status?: unknown })?.status
  return typeof status === 'number' ? status : undefined
}

export class JevService extends KitService<JevCounters> {
  static Config = JevConfig
  /** 测试钩子：替换 SDK 客户端的创建方式。 */
  static clientFactory: JevClientFactory = defaultClientFactory
  /** 测试钩子：替换钥匙串读取方式。 */
  static keychainReader: KeychainReader = macosKeychainReader
  /** 测试钩子：当前平台。 */
  static platform: NodeJS.Platform = process.platform
  readonly config: JevConfig
  private apiKey?: string
  private client?: JevClient
  private readonly controller = new AbortController()
  private readonly counters: JevCounters = { success: 0, failure: 0, failuresByCode: {} }

  constructor(ctx: Context, config: JevConfig) {
    super(ctx, 'jev')
    this.config = config
    const apiKey = process.env[JEV_API_KEY_ENV]?.trim() ? process.env[JEV_API_KEY_ENV] : undefined
    if (apiKey) this.useKey(apiKey)
    else if (!this.keychainEnabled()) {
      throw new ConfigError('jev', `environment variable ${JEV_API_KEY_ENV} is not set`, { field: JEV_API_KEY_ENV })
    }
    ctx.effect(() => () => this.controller.abort(), 'jev.abortInFlight')
  }

  async [Service.init](): Promise<void> {
    if (!this.apiKey) {
      const services = ([] as string[]).concat(this.config.keychainService!)
      const account = this.config.keychainAccount ?? process.env.USER ?? ''
      let key: string | undefined
      let found: string | undefined
      for (const service of account ? services : []) {
        try {
          key = await JevService.keychainReader(service, account)
        } catch (e) {
          throw new ConfigError('jev', `failed to read keychain item ${service}: ${(e as Error).message}`, { field: 'keychainService' })
        }
        if (key) {
          found = service
          break
        }
      }
      if (!key) {
        throw new ConfigError('jev', `${JEV_API_KEY_ENV} is not set and keychain item ${services.join(' / ')} (account ${account || '<unknown>'}) was not found`, {
          field: 'keychainService',
        })
      }
      this.useKey(key)
      this.logger.info('api key loaded from keychain', { service: found })
    }
    this.client = await JevService.clientFactory({ apiKey: this.apiKey!, model: this.config.model, timeoutMs: this.config.timeoutMs })
  }

  private keychainEnabled(): boolean {
    if (!this.config.keychainService) return false
    if (JevService.platform !== 'darwin') {
      this.logger.warn('keychainService is only supported on macOS; ignoring it', { platform: JevService.platform })
      return false
    }
    return true
  }

  private useKey(key: string): void {
    this.apiKey = key
    this.ctx.effect(() => registerSecret(key), 'jev.apiKey')
  }

  async judge<const Q extends Questions>(options: JudgeOptions<Q>): Promise<JudgeResult<Q>> {
    const { traceId } = options
    if (!this.client) throw new JevError('unavailable', 'jev service is not ready')
    if (options.signal?.aborted) throw this.fail(new JevError('aborted', 'aborted before start'), traceId)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs)
    const signals = [timeout.signal, this.controller.signal]
    if (options.signal) signals.push(options.signal)
    const signal = AbortSignal.any(signals)
    const started = Date.now()
    try {
      const request = { state: options.state, questions: options.questions, ...(options.model ? { model: options.model } : {}) }
      // SDK 在 signal 中止时会中断请求与后续重试；再与中止信号竞争，保证严格的总时长
      const result = await raceAbort(this.client.systemOne(request, { signal }), signal, () => signal.reason ?? new Error('aborted'))
      this.counters.success++
      this.clearFailed()
      this.logger.info('jev judge ok', { traceId, durationMs: Date.now() - started, questions: Object.keys(options.questions).length })
      return { model: result.model, answers: result.answers as Answers<Q>, ...(result.usage ? { usage: result.usage } : {}) }
    } catch (e) {
      let err: JevError
      if (timeout.signal.aborted) err = new JevError('unavailable', `judge timed out after ${this.config.timeoutMs}ms`)
      else if (options.signal?.aborted || this.controller.signal.aborted) err = new JevError('aborted', 'judge aborted')
      else err = classify(e)
      if (err.code === 'unauthorized') this.markFailed('TypeSafe API rejected the API key', err)
      throw this.fail(err, traceId)
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(err: JevError, traceId?: string): JevError {
    this.counters.failure++
    this.counters.failuresByCode[err.code] = (this.counters.failuresByCode[err.code] ?? 0) + 1
    this.logger.warn('jev judge failed', { traceId, code: err.code, error: err })
    return err
  }

  health(): ServiceHealth<JevCounters> {
    const counters = { ...this.counters, failuresByCode: { ...this.counters.failuresByCode } }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    return { status: this.client ? 'ok' : 'degraded', detail: this.client ? 'ready' : 'initializing', counters }
  }
}

export function classify(e: unknown): JevError {
  const name = (e as Error)?.name ?? ''
  const status = statusOf(e)
  const cause = redactValue(e)
  if (name === 'APIUserAbortError') return new JevError('aborted', 'judge aborted', { cause })
  if (status === 401 || status === 403) return new JevError('unauthorized', `TypeSafe API returned ${status}`, { cause })
  if (status === 429) return new JevError('rate_limited', 'TypeSafe API rate limited', { cause })
  if (status !== undefined && status >= 500) return new JevError('unavailable', `TypeSafe API returned ${status}`, { cause })
  if (status === 408) return new JevError('unavailable', 'TypeSafe API request timeout', { cause })
  if (name === 'APIConnectionError' || name === 'APITimeoutError' || name === 'TypeError') {
    return new JevError('unavailable', 'TypeSafe API is unreachable', { cause })
  }
  if (status !== undefined) return new JevError('bad_request', `TypeSafe API returned ${status}`, { cause })
  return new JevError('bad_request', `judge failed: ${(e as Error)?.message ?? String(e)}`, { cause })
}

export default JevService
