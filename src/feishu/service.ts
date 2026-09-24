import { accessSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { DEFAULT_LOGIN_TTL_MS, pick, type ChannelStatus, type LoginSession } from '../common/channel.js'
import { ConfigError } from '../common/errors.js'
import { resolveExecutable } from '../common/executable.js'
import { BASE_ENV_WHITELIST, pickEnv, runProcess, type RunProcessResult } from '../common/process.js'
import { digest, redact } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import { buildFeishuArgs, resolveTargets, targetIdempotencyKey, type FeishuAt, type FeishuResolvedTarget, type FeishuTarget } from './args.js'
import { FeishuConfig } from './config.js'
import { FeishuSendError } from './errors.js'
import { identityAvailable, parseFeishuError, parseFeishuOutput, type FeishuTargetResult } from './output.js'

/**
 * lark-cli 运行所需、允许传给子进程的额外环境变量。应用凭据与令牌类变量（`LARKSUITE_CLI_APP_SECRET`、
 * `*_ACCESS_TOKEN`）不在其中：凭据由 lark-cli 自己的配置（`lark-cli config init`）与系统钥匙串管理。
 */
export const LARK_ENV_WHITELIST = [
  'LARKSUITE_CLI_CONFIG_DIR',
  'LARKSUITE_CLI_PROFILE',
  'LARKSUITE_CLI_BRAND',
  'LARKSUITE_CLI_CA_PATH',
  'LARKSUITE_CLI_PROXY_ADDRESS',
  'LARKSUITE_CLI_PROXY_ENABLE',
  'XDG_CONFIG_HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const

/** 关掉 lark-cli 的更新 / skills 提示，避免它们混入 JSON 输出。 */
const QUIET_ENV = { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }

export interface FeishuSendOptions {
  /** Markdown 正文，与 `text` 二选一。 */
  markdown?: string
  /** 纯文本正文，与 `markdown` 二选一。 */
  text?: string
  /** 飞书 markdown 消息没有独立标题：作为加粗首行发送。 */
  title?: string
  target?: FeishuTarget
  at?: FeishuAt
  /** 透传为 `--idempotency-key`（多目标时逐目标派生）；给出时失败可重试。 */
  idempotencyKey?: string
  traceId?: string
  signal?: AbortSignal
}

export interface FeishuSendResult {
  results: FeishuTargetResult[]
}

export interface FeishuCounters {
  success: number
  failure: number
  lastFailureAt: number | null
  lastErrorCode: string | null
  identityOk: boolean | null
  lastPreflightAt: number | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishu: FeishuService
  }
}

const RETRYABLE_TYPES = new Set(['network', 'timeout', 'rate_limit', 'server', 'internal', 'unavailable'])

export class FeishuService extends KitService<FeishuCounters> {
  static Config = FeishuConfig
  readonly config: FeishuConfig
  readonly larkPath: string
  private readonly env: NodeJS.ProcessEnv
  private readonly controller = new AbortController()
  private lastSuccessAt: number | null = null
  private loginSession?: LoginSession
  private readonly counters: FeishuCounters = {
    success: 0,
    failure: 0,
    lastFailureAt: null,
    lastErrorCode: null,
    identityOk: null,
    lastPreflightAt: null,
  }

  constructor(ctx: Context, config: FeishuConfig) {
    super(ctx, 'feishu')
    this.config = config
    if (config.larkPath !== undefined) {
      if (!isAbsolute(config.larkPath)) throw new ConfigError('feishu', 'larkPath must be an absolute path', { field: 'larkPath' })
      this.larkPath = config.larkPath
    } else {
      const found = resolveExecutable('lark-cli')
      if (!found) throw new ConfigError('feishu', 'lark-cli not found in PATH; install @larksuite/cli or set larkPath', { field: 'larkPath' })
      this.larkPath = found
    }
    try {
      accessSync(this.larkPath, constants.X_OK)
    } catch {
      throw new ConfigError('feishu', 'larkPath is not executable', { field: 'larkPath' })
    }
    // 启动时校验默认目标的格式
    if (config.defaultTarget) resolveTargets(config.defaultTarget)
    this.env = { ...pickEnv([...BASE_ENV_WHITELIST, ...LARK_ENV_WHITELIST]), ...QUIET_ENV }
    this.logger.info('lark-cli resolved', { larkPath: this.larkPath, identity: config.identity, dryRun: config.dryRun })
    ctx.effect(() => () => this.controller.abort(), 'feishu.abortInFlight')
  }

  async [Service.init](): Promise<void> {
    if (this.config.dryRun) return
    await this.preflight()
    if (this.config.preflightIntervalMs > 0) {
      this.ctx.effect(() => {
        const timer = setInterval(() => void this.preflight(), this.config.preflightIntervalMs)
        return () => clearInterval(timer)
      }, 'feishu.preflight')
    }
  }

  /** 检查所配身份在 lark-cli 中是否可用（`lark-cli auth status --json`），不可用时 health() 返回 failed。 */
  async preflight(): Promise<boolean> {
    const r = await this.checkIdentity()
    this.recordIdentity(r)
    return r.ok
  }

  private async checkIdentity(): Promise<{ ok: boolean; detail: string; account?: string }> {
    const identity = this.config.identity
    try {
      const r = await this.exec([...this.profileArgs(), 'auth', 'status', '--json'], this.controller.signal)
      if (r.exitCode !== 0) return { ok: false, detail: `lark-cli auth status exited with ${r.exitCode}: ${parseFeishuError(r.stderr).message}` }
      const s = identityAvailable(r.stdout, identity)
      const account = identity === 'user' ? s.userName ?? s.openId : s.appId
      return { ok: s.ok, detail: s.ok ? s.detail : `lark-cli ${identity} identity unavailable: ${s.detail}`, ...(account ? { account } : {}) }
    } catch (e) {
      return { ok: false, detail: `lark-cli auth status failed: ${(e as Error).message}` }
    }
  }

  private recordIdentity(r: { ok: boolean; detail: string }): void {
    this.counters.identityOk = r.ok
    this.counters.lastPreflightAt = Date.now()
    if (r.ok) this.clearFailed()
    else this.markFailed(r.detail)
  }

  /** 实时检查所配身份是否可用。dryRun 下只报告，不改变 health()。 */
  async status(): Promise<ChannelStatus> {
    const r = await this.checkIdentity()
    if (!this.config.dryRun) this.recordIdentity(r)
    return { channel: 'feishu', identity: this.config.identity, online: r.ok, ...(r.account ? { account: r.account } : {}), detail: r.detail, checkedAt: Date.now() }
  }

  private assertUserIdentity(action: string): void {
    if (this.config.identity !== 'user') {
      throw new FeishuSendError('unsupported', `bot identity has no ${action}: it uses the app credentials configured with lark-cli config init`)
    }
  }

  /**
   * user 身份的设备流登录：`lark-cli auth login --no-wait --json` 立即给出授权链接，随后在后台运行
   * `lark-cli auth login --device-code` 等待授权完成，`completed` 以新的状态 resolve。同一时间只进行
   * 一次登录，重复调用返回同一个会话。bot 身份没有用户登录（由应用凭据决定），调用会报 `unsupported`。
   */
  async login(options: { signal?: AbortSignal } = {}): Promise<LoginSession> {
    this.assertUserIdentity('login')
    if (this.loginSession) return this.loginSession
    const start = await this.exec([...this.profileArgs(), 'auth', 'login', '--scope=im:message.send_as_user im:message', '--no-wait', '--json'], this.controller.signal)
    if (start.exitCode !== 0) throw new FeishuSendError('login_failed', `lark-cli auth login failed: ${parseFeishuError(start.stderr).message}`)
    let data: unknown
    try {
      data = JSON.parse(start.stdout)
    } catch {
      throw new FeishuSendError('bad_output', 'lark-cli auth login output is not valid JSON')
    }
    const url = pick(data, 'verification_url', 'verification_uri_complete', 'verification_uri')
    const deviceCode = pick(data, 'device_code')
    if (typeof url !== 'string' || typeof deviceCode !== 'string') throw new FeishuSendError('bad_output', 'lark-cli auth login did not return verification_url and device_code')
    const userCode = pick(data, 'user_code')
    const expiresIn = Number(pick(data, 'expires_in'))
    const ttlMs = expiresIn > 0 ? expiresIn * 1000 : DEFAULT_LOGIN_TTL_MS
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, this.controller.signal, ...(options.signal ? [options.signal] : [])])
    const completed = runProcess(this.larkPath, [...this.profileArgs(), 'auth', 'login', `--device-code=${deviceCode}`, '--json'], {
      env: this.env,
      timeoutMs: ttlMs + 60_000,
      killGraceMs: this.config.killGraceMs,
      signal,
    })
      .catch(() => undefined)
      .then(async () => {
        this.loginSession = undefined
        const status = await this.status()
        this.logger.info('feishu login finished', { online: status.online })
        return status
      })
    const session: LoginSession = {
      channel: 'feishu',
      verificationUrl: url,
      ...(typeof userCode === 'string' ? { userCode } : {}),
      expiresAt: Date.now() + ttlMs,
      completed,
      cancel: () => cancel.abort(),
    }
    this.loginSession = session
    this.logger.info('feishu login started', { expiresAt: session.expiresAt })
    return session
  }

  /** 退出 user 身份的登录（`lark-cli auth logout`），返回退出后的状态。bot 身份报 `unsupported`。 */
  async logout(): Promise<ChannelStatus> {
    this.assertUserIdentity('logout')
    const r = await this.exec([...this.profileArgs(), 'auth', 'logout', '--json'], this.controller.signal)
    if (r.exitCode !== 0) throw new FeishuSendError('exit_nonzero', `lark-cli auth logout exited with ${r.exitCode}: ${parseFeishuError(r.stderr).message}`)
    this.logger.info('feishu logged out')
    return this.status()
  }

  async send(options: FeishuSendOptions): Promise<FeishuSendResult> {
    const traceId = options.traceId
    let targets: FeishuResolvedTarget[]
    try {
      targets = resolveTargets(options.target ?? this.config.defaultTarget)
      // 提前校验参数组合（正文、@ 人、幂等键），避免逐目标发送到一半才失败
      buildFeishuArgs({ identity: this.config.identity, target: targets[0]!, title: options.title, markdown: options.markdown, text: options.text, at: options.at, dryRun: true })
      if (options.idempotencyKey !== undefined) targetIdempotencyKey(options.idempotencyKey, targets[0]!, targets.length)
    } catch (e) {
      this.recordFailure(e as FeishuSendError)
      throw e
    }
    const body = options.markdown ?? options.text ?? ''
    this.logger.info('feishu send', { traceId, identity: this.config.identity, targets: targets.length, body: digest(body), dryRun: this.config.dryRun })
    const results: FeishuTargetResult[] = []
    for (const target of targets) {
      try {
        results.push(await this.sendTarget(target, targets.length, options))
      } catch (e) {
        const err = e as FeishuSendError
        if (err.code === 'aborted' || targets.length === 1) {
          this.recordFailure(err)
          this.logger.error('feishu send failed', { traceId, code: err.code, error: err })
          throw err
        }
        results.push({ target, ok: false, error: err })
      }
    }
    const failed = results.filter((r) => !r.ok)
    if (failed.length === 0) this.recordSuccess()
    else {
      this.recordFailure(failed[0]!.error!)
      this.logger.warn('feishu send partially failed', { traceId, failed: failed.length, total: results.length })
    }
    return { results }
  }

  private async sendTarget(target: FeishuResolvedTarget, count: number, options: FeishuSendOptions): Promise<FeishuTargetResult> {
    const key = options.idempotencyKey !== undefined ? targetIdempotencyKey(options.idempotencyKey, target, count) : undefined
    const args = buildFeishuArgs({
      identity: this.config.identity,
      profile: this.config.profile,
      target,
      title: options.title,
      markdown: options.markdown,
      text: options.text,
      at: options.at,
      idempotencyKey: key,
      dryRun: this.config.dryRun,
    })
    // 只有带幂等键时才重试：没有键时重试可能重复发送
    const maxAttempts = key !== undefined ? this.config.retry.maxAttempts : 0
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce(args, target, options.signal)
      } catch (e) {
        const err = e as FeishuSendError
        if (err.retryable && attempt < maxAttempts && !options.signal?.aborted && !this.controller.signal.aborted) {
          this.logger.warn('feishu send failed, retrying', { traceId: options.traceId, attempt, code: err.code })
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
          continue
        }
        throw err
      }
    }
  }

  private async sendOnce(args: string[], target: FeishuResolvedTarget, signal?: AbortSignal): Promise<FeishuTargetResult> {
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    let r: RunProcessResult
    try {
      r = await this.exec(args, combined)
    } catch (e) {
      throw new FeishuSendError('spawn_failed', `failed to start lark-cli: ${(e as Error).message}`, { cause: e })
    }
    if (r.aborted) throw new FeishuSendError('aborted', 'send aborted')
    if (r.timedOut) throw new FeishuSendError('timeout', `lark-cli timed out after ${this.config.timeoutMs}ms`, { retryable: true })
    if (r.exitCode !== 0) {
      const info = parseFeishuError(r.stderr)
      throw new FeishuSendError('exit_nonzero', `lark-cli exited with ${r.exitCode ?? r.signal}: ${info.message}`, {
        retryable: info.type !== undefined && RETRYABLE_TYPES.has(info.type),
        details: { exitCode: r.exitCode, type: info.type, subtype: info.subtype, hint: info.hint, stderr: redact(r.stderr, 500) },
      })
    }
    const parsed = parseFeishuOutput(r.stdout)
    if (!parsed.ok) throw new FeishuSendError('send_failed', 'lark-cli reported ok: false')
    return { target, ok: true, ...(parsed.messageId ? { messageId: parsed.messageId } : {}) }
  }

  private profileArgs(): string[] {
    return this.config.profile ? [`--profile=${this.config.profile}`] : []
  }

  private exec(args: string[], signal: AbortSignal): Promise<RunProcessResult> {
    return runProcess(this.larkPath, args, {
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

  private recordFailure(err: FeishuSendError): void {
    this.counters.failure++
    this.counters.lastFailureAt = Date.now()
    this.counters.lastErrorCode = err.code
  }

  health(): ServiceHealth<FeishuCounters> {
    const counters = { ...this.counters }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return { status: 'ok', detail: this.config.dryRun ? 'dry-run' : 'ready', counters }
  }
}

export default FeishuService
