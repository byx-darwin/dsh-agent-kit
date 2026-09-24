import { accessSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { ConfigError } from '../common/errors.js'
import { resolveExecutable } from '../common/executable.js'
import { BASE_ENV_WHITELIST, pickEnv, runProcess, type RunProcessResult } from '../common/process.js'
import { digest, redact, registerSecret } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import { buildSendArgs, type DingtalkAt, type DingtalkTarget } from './args.js'
import { DingtalkConfig } from './config.js'
import { DingtalkSendError } from './errors.js'
import { parseErrorOutput, parseSendOutput, type TargetResult } from './output.js'

/** dws 运行所需、允许传给子进程的额外环境变量。 */
export const DWS_ENV_WHITELIST = ['DWS_CONFIG_DIR', 'DWS_KEYCHAIN_DIR', 'DWS_DISABLE_KEYCHAIN', 'XDG_CONFIG_HOME'] as const

export interface DingtalkSendOptions {
  /** Markdown 正文，与 `text` 二选一。 */
  markdown?: string
  /** 纯文本正文，与 `markdown` 二选一。 */
  text?: string
  title?: string
  target?: DingtalkTarget
  at?: DingtalkAt
  /** 仅 user 身份透传为 `--idempotency-key`。 */
  idempotencyKey?: string
  traceId?: string
  signal?: AbortSignal
}

export interface DingtalkSendResult {
  results: TargetResult[]
}

export interface DingtalkCounters {
  success: number
  failure: number
  lastFailureAt: number | null
  lastErrorCode: string | null
  loginOk: boolean | null
  lastPreflightAt: number | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dingtalk: DingtalkService
  }
}

export { resolveExecutable }

const RETRYABLE_CATEGORIES = new Set(['network', 'timeout', 'rate_limit', 'server', 'unavailable'])

export class DingtalkService extends KitService<DingtalkCounters> {
  static Config = DingtalkConfig
  readonly config: DingtalkConfig
  readonly dwsPath: string
  private readonly webhookToken?: string
  private readonly env: NodeJS.ProcessEnv
  private readonly controller = new AbortController()
  private warnedIdempotency = false
  private lastSuccessAt: number | null = null
  private readonly counters: DingtalkCounters = {
    success: 0,
    failure: 0,
    lastFailureAt: null,
    lastErrorCode: null,
    loginOk: null,
    lastPreflightAt: null,
  }

  constructor(ctx: Context, config: DingtalkConfig) {
    super(ctx, 'dingtalk')
    this.config = config
    if (config.identity === 'bot' && !config.robotCode) {
      throw new ConfigError('dingtalk', 'robotCode is required for bot identity', { field: 'robotCode' })
    }
    if (config.identity === 'webhook') {
      if (!config.webhookTokenEnv) throw new ConfigError('dingtalk', 'webhookTokenEnv is required for webhook identity', { field: 'webhookTokenEnv' })
      const token = process.env[config.webhookTokenEnv]
      if (!token) throw new ConfigError('dingtalk', `environment variable ${config.webhookTokenEnv} is not set`, { field: 'webhookTokenEnv' })
      this.webhookToken = token
      ctx.effect(() => registerSecret(token), 'dingtalk.webhookToken')
      if (config.defaultTarget) throw new ConfigError('dingtalk', 'defaultTarget is not allowed for webhook identity', { field: 'defaultTarget' })
      this.logger.warn('webhook identity passes the token as a command-line argument (visible in ps); prefer bot identity')
    }
    if (config.dwsPath !== undefined) {
      if (!isAbsolute(config.dwsPath)) throw new ConfigError('dingtalk', 'dwsPath must be an absolute path', { field: 'dwsPath' })
      this.dwsPath = config.dwsPath
    } else {
      const found = resolveExecutable('dws')
      if (!found) {
        const hint = process.platform === 'win32' ? 'install dws or set dwsPath to the dws.js or dws.exe path' : 'install dws or set dwsPath'
        throw new ConfigError('dingtalk', `dws not found in PATH; ${hint}`, { field: 'dwsPath' })
      }
      this.dwsPath = found
    }
    try {
      accessSync(this.dwsPath, constants.X_OK)
    } catch {
      throw new ConfigError('dingtalk', 'dwsPath is not executable', { field: 'dwsPath' })
    }
    if (config.defaultTarget) {
      // 启动时校验默认目标的格式与身份组合
      buildSendArgs({ identity: config.identity, robotCode: config.robotCode, target: config.defaultTarget, text: '', dryRun: true })
    }
    this.env = pickEnv([...BASE_ENV_WHITELIST, ...DWS_ENV_WHITELIST])
    this.logger.info('dws resolved', { dwsPath: this.dwsPath, identity: config.identity, dryRun: config.dryRun })
    ctx.effect(() => () => this.controller.abort(), 'dingtalk.abortInFlight')
  }

  async [Service.init](): Promise<void> {
    if (this.config.identity === 'webhook' || this.config.dryRun) return
    await this.preflight()
    if (this.config.preflightIntervalMs > 0) {
      this.ctx.effect(() => {
        const timer = setInterval(() => void this.preflight(), this.config.preflightIntervalMs)
        return () => clearInterval(timer)
      }, 'dingtalk.preflight')
    }
  }

  /** 检查 dws 登录态（`dws auth status`），失效时 health() 返回 failed。 */
  async preflight(): Promise<boolean> {
    let ok = false
    let detail = ''
    try {
      const r = await this.exec(['auth', 'status', '--format=json'], this.controller.signal)
      if (r.exitCode === 0) {
        const data = JSON.parse(r.stdout) as { authenticated?: boolean; token_valid?: boolean; refresh_token_valid?: boolean }
        ok = data.authenticated === true && (data.token_valid === true || data.refresh_token_valid === true)
        detail = ok ? '' : 'dws is not logged in'
      } else {
        detail = `dws auth status exited with ${r.exitCode}: ${parseErrorOutput(r.stderr).message}`
      }
    } catch (e) {
      detail = `dws auth status failed: ${(e as Error).message}`
    }
    this.counters.loginOk = ok
    this.counters.lastPreflightAt = Date.now()
    if (ok) this.clearFailed()
    else this.markFailed(detail)
    return ok
  }

  async send(options: DingtalkSendOptions): Promise<DingtalkSendResult> {
    const { identity } = this.config
    const traceId = options.traceId
    if (options.idempotencyKey !== undefined && identity !== 'user' && !this.warnedIdempotency) {
      this.warnedIdempotency = true
      this.logger.warn(`idempotencyKey is ignored for ${identity} identity`, { traceId })
    }
    let built
    try {
      built = buildSendArgs({
        identity,
        robotCode: this.config.robotCode,
        webhookToken: this.webhookToken,
        target: options.target ?? this.config.defaultTarget,
        title: options.title,
        markdown: options.markdown,
        text: options.text,
        at: options.at,
        idempotencyKey: options.idempotencyKey,
        dryRun: this.config.dryRun,
      })
    } catch (e) {
      this.recordFailure(e as DingtalkSendError)
      throw e
    }

    const canRetry = identity === 'user' && options.idempotencyKey !== undefined
    const maxAttempts = canRetry ? this.config.retry.maxAttempts : 0
    const body = options.markdown ?? options.text ?? ''
    for (let attempt = 0; ; attempt++) {
      this.logger.info('dingtalk send', { traceId, attempt, identity, targets: built.targets.length, body: digest(body), dryRun: this.config.dryRun })
      try {
        const results = await this.sendOnce(built.args, built.targets, built.batch, options.signal)
        const failed = results.filter((r) => !r.ok)
        if (failed.length === 0) this.recordSuccess()
        else this.recordFailure(failed[0]!.error!)
        if (failed.length > 0) this.logger.warn('dingtalk send partially failed', { traceId, failed: failed.length, total: results.length })
        return { results }
      } catch (e) {
        const err = e as DingtalkSendError
        if (err.retryable && attempt < maxAttempts && !options.signal?.aborted && !this.controller.signal.aborted) {
          this.logger.warn('dingtalk send failed, retrying', { traceId, attempt, code: err.code })
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
          continue
        }
        this.recordFailure(err)
        this.logger.error('dingtalk send failed', { traceId, code: err.code, error: err })
        throw err
      }
    }
  }

  private async sendOnce(args: string[], targets: TargetResult['target'][], batch: boolean, signal?: AbortSignal): Promise<TargetResult[]> {
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    let r: RunProcessResult
    try {
      r = await this.exec(args, combined)
    } catch (e) {
      throw new DingtalkSendError('spawn_failed', `failed to start dws: ${(e as Error).message}`, { cause: e })
    }
    if (r.aborted) throw new DingtalkSendError('aborted', 'send aborted')
    if (r.timedOut) throw new DingtalkSendError('timeout', `dws timed out after ${this.config.timeoutMs}ms`, { retryable: true })
    if (r.exitCode !== 0) {
      const info = parseErrorOutput(r.stderr)
      throw new DingtalkSendError('exit_nonzero', `dws exited with ${r.exitCode ?? r.signal}: ${info.message}`, {
        retryable: info.category !== undefined && RETRYABLE_CATEGORIES.has(info.category),
        details: { exitCode: r.exitCode, category: info.category, stderr: redact(r.stderr, 500) },
      })
    }
    const results = parseSendOutput(r.stdout, targets, batch)
    if (!batch && results.some((x) => !x.ok)) throw results.find((x) => !x.ok)!.error!
    return results
  }

  private exec(args: string[], signal: AbortSignal): Promise<RunProcessResult> {
    return runProcess(this.dwsPath, args, {
      env: this.env,
      timeoutMs: this.config.timeoutMs,
      killGraceMs: this.config.killGraceMs,
      signal,
    })
  }

  private recordSuccess(): void {
    this.counters.success++
    this.lastSuccessAt = Date.now()
  }

  private recordFailure(err: DingtalkSendError): void {
    this.counters.failure++
    this.counters.lastFailureAt = Date.now()
    this.counters.lastErrorCode = err.code
  }

  health(): ServiceHealth<DingtalkCounters> {
    const counters = { ...this.counters }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : 'ready', counters }
  }
}

export default DingtalkService
