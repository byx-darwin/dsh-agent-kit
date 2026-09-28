import { accessSync, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import { DEFAULT_LOGIN_TTL_MS, type ChannelStatus, type LoginSession } from '../common/channel.js'
import { ConfigError } from '../common/errors.js'
import { resolveExecutable } from '../common/executable.js'
import { BASE_ENV_WHITELIST, pickEnv, runProcess, type RunProcessResult } from '../common/process.js'
import { digest, redact } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import { buildSendArgs, type DingtalkAt, type DingtalkTarget } from './args.js'
import { DingtalkConfig } from './config.js'
import { DingtalkSendError } from './errors.js'
import { DingtalkInbox, type DingtalkInboxStats, type DingtalkMessageHandler, type DingtalkMessageRoute, type DingtalkMessageSubscription } from './inbox.js'
import { DingtalkUnmatchedStore, type DingtalkUnmatchedMessage } from './unmatched.js'
import { parseErrorOutput, parseSendOutput, type TargetResult } from './output.js'
import { parseRecipientSearch, type DingtalkRecipientKind, type DingtalkRecipientSearchResult } from './recipients.js'

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
  /** 透传为 `--idempotency-key`。 */
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
  inbox: DingtalkInboxStats
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dingtalk: DingtalkService
  }
}

export { resolveExecutable }

const RETRYABLE_CATEGORIES = new Set(['network', 'timeout', 'rate_limit', 'server', 'unavailable'])

interface DwsDeviceLogin {
  url: string
  userCode?: string
  ttlMs: number
}

/** 从 `dws auth login --device` 的输出（写在 stderr 的纯文本）中取授权链接、验证码与有效期。 */
export function parseDwsDeviceLogin(text: string): DwsDeviceLogin | undefined {
  const url = /(https:\/\/\S*user_code=\S+)/.exec(text)?.[1] ?? /(https:\/\/\S+)/.exec(text)?.[1]
  if (!url) return undefined
  const userCode = /authorization code:\s*([A-Za-z0-9-]+)/i.exec(text)?.[1]
  const seconds = Number(/expire in (\d+) seconds/i.exec(text)?.[1])
  return { url, ...(userCode ? { userCode } : {}), ttlMs: seconds > 0 ? seconds * 1000 : DEFAULT_LOGIN_TTL_MS }
}

export class DingtalkService extends KitService<DingtalkCounters> {
  static Config = DingtalkConfig
  readonly config: DingtalkConfig
  readonly dwsPath: string
  private readonly env: NodeJS.ProcessEnv
  private readonly controller = new AbortController()
  private readonly inbox: DingtalkInbox
  private unmatched: DingtalkUnmatchedStore
  private readonly unmatchedDir?: string
  private activeProfile?: string
  private loginSession?: LoginSession
  private lastSuccessAt: number | null = null
  private readonly counters: Omit<DingtalkCounters, 'inbox'> = {
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
      buildSendArgs({ identity: config.identity, target: config.defaultTarget, text: '', dryRun: true })
    }
    const groupRoutes = new Map<string, string>()
    for (const route of config.groupRoutes ?? []) {
      const conversationId = route.conversationId?.trim()
      const pluginId = route.pluginId?.trim()
      if (!conversationId || !pluginId) throw new ConfigError('dingtalk', 'group route requires conversationId and pluginId', { field: 'groupRoutes' })
      if (groupRoutes.has(conversationId)) throw new ConfigError('dingtalk', `duplicate group route: ${conversationId}`, { field: 'groupRoutes' })
      groupRoutes.set(conversationId, pluginId)
    }
    this.env = pickEnv([...BASE_ENV_WHITELIST, ...DWS_ENV_WHITELIST])
    const baseUrl = (ctx as Context & { baseUrl?: string }).baseUrl
    this.unmatchedDir = baseUrl ? join(dirname(fileURLToPath(new URL('./cordis.yml', baseUrl))), '.agent-kit', 'dingtalk-unmatched') : undefined
    this.unmatched = this.createUnmatchedStore()
    this.inbox = new DingtalkInbox(
      this.dwsPath,
      this.env,
      config.killGraceMs,
      config.timeoutMs,
      this.logger,
      (detail) => this.markFailed(detail),
      () => { if (this.counters.loginOk !== false) this.clearFailed() },
      (message) => this.unmatched.add(message),
      true,
      () => this.activeProfile,
      groupRoutes,
    )
    this.logger.info('dws resolved', { dwsPath: this.dwsPath, identity: config.identity, dryRun: config.dryRun })
    ctx.effect(() => () => {
      this.controller.abort()
      return this.inbox.stop()
    }, 'dingtalk.abortInFlight')
  }

  /** 按群 ID 注册 @ 消息处理器；每条消息只下发给优先级最高的首个匹配处理器。 */
  onMessage(route: DingtalkMessageRoute, handler: DingtalkMessageHandler): DingtalkMessageSubscription {
    if (this.config.dryRun) throw new ConfigError('dingtalk', 'cannot listen for messages in dryRun mode', { field: 'dryRun' })
    const subscription = this.inbox.register(route, handler)
    try {
      // Cordis 将此 effect 归属到调用方插件；插件卸载时自动取消它的路由。
      this.ctx.effect(() => () => subscription.close(), 'dingtalk.onMessage')
    } catch (error) {
      void subscription.close()
      throw error
    }
    return subscription
  }

  /** 业务插件以设置页使用的插件 ID 注册接收器；群到插件的映射由设置页配置。 */
  onPluginMessage(pluginId: string, handler: DingtalkMessageHandler): DingtalkMessageSubscription {
    if (this.config.dryRun) throw new ConfigError('dingtalk', 'cannot listen for messages in dryRun mode', { field: 'dryRun' })
    const subscription = this.inbox.registerPlugin(pluginId, handler)
    try {
      this.ctx.effect(() => () => subscription.close(), 'dingtalk.onPluginMessage')
    } catch (error) {
      void subscription.close()
      throw error
    }
    return subscription
  }

  /** 最近 200 条未命中记录（只保存 240 字预览），新记录在前。 */
  unmatchedMessages(): Promise<DingtalkUnmatchedMessage[]> {
    return this.unmatched.list()
  }

  /** 让业务插件以当前登录的 user/profile 查找群或个人，配置自身的转发目标。只返回候选，不自动选择。 */
  async searchRecipients(kind: DingtalkRecipientKind, query: string): Promise<DingtalkRecipientSearchResult> {
    if (kind !== 'group' && kind !== 'user') throw new TypeError('recipient kind must be group or user')
    const term = query?.trim()
    if (!term || term.length < 2 || term.length > 80) throw new TypeError('recipient search query must be 2–80 characters')
    if (!this.activeProfile) throw new Error('DingTalk user is not logged in')
    const args = kind === 'group'
      ? ['chat', '+chat-search', `--query=${term}`, '--page-all', '--page-limit=5', '--format=json']
      : ['aisearch', 'person', `--query=${term}`, '--dimension=name', '--format=json']
    const r = await this.exec([...args, '--profile', this.activeProfile], this.controller.signal)
    if (r.aborted) throw new Error('DingTalk recipient search aborted')
    if (r.timedOut) throw new Error('DingTalk recipient search timed out')
    if (r.exitCode !== 0) throw new Error(`DingTalk recipient search failed: ${parseErrorOutput(r.stderr).message}`)
    return parseRecipientSearch(kind, r.stdout)
  }

  private async groupName(conversationId: string, profile: string | undefined): Promise<string | undefined> {
    const r = await runProcess(this.dwsPath, ['chat', '+conversation-info', '--group', conversationId, '--format', 'json', ...(profile ? ['--profile', profile] : [])], {
      env: this.env,
      timeoutMs: this.config.timeoutMs,
      killGraceMs: this.config.killGraceMs,
      signal: this.controller.signal,
      maxOutputBytes: 64 * 1024,
    })
    if (r.exitCode !== 0 || r.timedOut || r.aborted) return undefined
    const data: unknown = JSON.parse(r.stdout)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
    const root = data as Record<string, unknown>
    const result = root.result && typeof root.result === 'object' && !Array.isArray(root.result) ? root.result as Record<string, unknown> : root
    const name = result.title ?? result.name
    return typeof name === 'string' && name.trim() ? name.trim() : undefined
  }

  async [Service.init](): Promise<void> {
    if (this.config.dryRun) return
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
    const r = await this.checkLogin()
    await this.useProfile(r.ok ? r.profile : undefined)
    this.recordLogin(r)
    return r.ok
  }

  private createUnmatchedStore(): DingtalkUnmatchedStore {
    // 不把明文组织/用户 ID 放到文件名；不同 dws 账号的记录互不混用。
    const profile = this.activeProfile
    const key = profile ? createHash('sha256').update(profile).digest('hex').slice(0, 24) : undefined
    const file = key && this.unmatchedDir ? join(this.unmatchedDir, `${key}.json`) : undefined
    return new DingtalkUnmatchedStore(
      file,
      (id) => this.groupName(id, profile),
      (error) => this.logger.warn('dingtalk unmatched metadata unavailable', { error: redact(String(error)) }),
    )
  }

  private async useProfile(profile: string | undefined): Promise<void> {
    if (profile === this.activeProfile) return
    await this.inbox.stop()
    this.activeProfile = profile
    this.unmatched = this.createUnmatchedStore()
    if (profile) void this.inbox.startListening().catch(() => {})
  }

  private async checkLogin(): Promise<{ ok: boolean; detail: string; account?: string; profile?: string }> {
    try {
      const r = await this.exec(['auth', 'status', '--format=json'], this.controller.signal)
      if (r.exitCode !== 0) return { ok: false, detail: `dws auth status exited with ${r.exitCode}: ${parseErrorOutput(r.stderr).message}` }
      const data = JSON.parse(r.stdout) as { authenticated?: boolean; token_valid?: boolean; refresh_token_valid?: boolean; user_name?: string; corp_name?: string; corp_id?: string; user_id?: string }
      const ok = data.authenticated === true && (data.token_valid === true || data.refresh_token_valid === true)
      const account = [data.user_name, data.corp_name].filter(Boolean).join(' @ ')
      // dws 的账号标识 corpId:userId，logout 用它只退出当前账号
      const profile = data.corp_id && data.user_id ? `${data.corp_id}:${data.user_id}` : undefined
      return { ok, detail: ok ? `logged in${account ? ` as ${account}` : ''}` : 'dws is not logged in', ...(account ? { account } : {}), ...(profile ? { profile } : {}) }
    } catch (e) {
      return { ok: false, detail: `dws auth status failed: ${(e as Error).message}` }
    }
  }

  private recordLogin(r: { ok: boolean; detail: string }): void {
    this.counters.loginOk = r.ok
    this.counters.lastPreflightAt = Date.now()
    if (r.ok && this.inbox.stats().listener !== 'failed') this.clearFailed()
    else this.markFailed(r.detail)
  }

  /** 实时检查登录状态。dryRun 下只报告，不改变 health()。 */
  async status(): Promise<ChannelStatus> {
    const base = { channel: 'dingtalk' as const, identity: this.config.identity }
    const r = await this.checkLogin()
    if (!this.config.dryRun) {
      await this.useProfile(r.ok ? r.profile : undefined)
      this.recordLogin(r)
    }
    return { ...base, online: r.ok, ...(r.account ? { account: r.account } : {}), detail: r.detail, checkedAt: Date.now() }
  }

  /**
   * 设备流登录（`dws auth login --device`）：拿到授权链接即返回，由调用方把链接交给要登录的人；dws 在后台
   * 轮询，对方授权后 `completed` 以新的状态 resolve。同一时间只进行一次登录，重复调用返回同一个会话。
   * 注意：dws 的登录态是本机共享的，登录成功后本机其他使用 dws 的程序也会看到这个账号。
   */
  async login(options: { signal?: AbortSignal } = {}): Promise<LoginSession> {
    if (this.loginSession) return this.loginSession
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, this.controller.signal, ...(options.signal ? [options.signal] : [])])
    let output = ''
    let found!: (info: DwsDeviceLogin) => void
    let failed!: (err: Error) => void
    const info = new Promise<DwsDeviceLogin>((resolve, reject) => ((found = resolve), (failed = reject)))
    const run = runProcess(this.dwsPath, ['auth', 'login', '--device', '--no-browser', '--format=json'], {
      env: this.env,
      timeoutMs: DEFAULT_LOGIN_TTL_MS + 60_000,
      killGraceMs: this.config.killGraceMs,
      signal,
      onOutput: (text) => {
        output += text
        const parsed = parseDwsDeviceLogin(output)
        if (parsed) found(parsed)
      },
    })
    run.then(
      (r) => failed(new DingtalkSendError('login_failed', `dws auth login ended before showing a link: ${parseErrorOutput(r.stderr).message}`)),
      (e) => failed(new DingtalkSendError('spawn_failed', `failed to start dws: ${(e as Error).message}`, { cause: e })),
    )
    const completed = run
      .catch(() => undefined)
      .then(async () => {
        this.loginSession = undefined
        const status = await this.status()
        this.logger.info('dingtalk login finished', { online: status.online })
        return status
      })
    const { url, userCode, ttlMs } = await info
    const session: LoginSession = { channel: 'dingtalk', verificationUrl: url, ...(userCode ? { userCode } : {}), expiresAt: Date.now() + ttlMs, completed, cancel: () => cancel.abort() }
    this.loginSession = session
    this.logger.info('dingtalk login started', { expiresAt: session.expiresAt })
    return session
  }

  /**
   * 退出当前钉钉账号（`dws auth logout --profile=<corpId>:<userId>`），返回退出后的状态。dws 不带
   * `--profile` 时会退出本机全部账号，所以取不到当前账号标识时不调用 logout，直接返回当前状态。
   */
  async logout(): Promise<ChannelStatus> {
    const current = await this.checkLogin()
    if (!current.profile) return this.status()
    const r = await this.exec(['auth', 'logout', `--profile=${current.profile}`, '--yes', '--format=json'], this.controller.signal)
    if (r.exitCode !== 0) throw new DingtalkSendError('exit_nonzero', `dws auth logout exited with ${r.exitCode}: ${parseErrorOutput(r.stderr).message}`)
    this.logger.info('dingtalk logged out')
    return this.status()
  }

  async send(options: DingtalkSendOptions): Promise<DingtalkSendResult> {
    const { identity } = this.config
    const traceId = options.traceId
    let built
    try {
      built = buildSendArgs({
        identity,
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

    const canRetry = options.idempotencyKey !== undefined
    const maxAttempts = canRetry ? this.config.retry.maxAttempts : 0
    const body = options.markdown ?? options.text ?? ''
    for (let attempt = 0; ; attempt++) {
      this.logger.info('dingtalk send', { traceId, attempt, identity, targets: built.targets.length, body: digest(body), dryRun: this.config.dryRun })
      try {
        const results = await this.sendOnce(built.args, built.targets, options.signal)
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

  private async sendOnce(args: string[], targets: TargetResult['target'][], signal?: AbortSignal): Promise<TargetResult[]> {
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
    const results = parseSendOutput(r.stdout, targets)
    if (results.some((x) => !x.ok)) throw results.find((x) => !x.ok)!.error!
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
    const counters = { ...this.counters, inbox: this.inbox.stats() }
    if (counters.inbox.listener === 'failed') return { status: 'failed', detail: this.failure ?? 'dws event listener failed', counters }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (!this.config.dryRun && counters.inbox.listener !== 'ready') return { status: 'degraded', detail: 'dws event listener is starting', counters }
    if (counters.inbox.dropped > 0) return { status: 'degraded', detail: `${counters.inbox.dropped} dws event(s) dropped`, counters }
    if (counters.lastFailureAt !== null && (this.lastSuccessAt === null || counters.lastFailureAt > this.lastSuccessAt)) {
      return { status: 'degraded', detail: `last send failed: ${counters.lastErrorCode}`, counters }
    }
    return {
      status: 'ok',
      detail: this.config.dryRun ? 'dry-run' : `ready; @ inbox listening (${counters.inbox.routes} route(s))`,
      counters,
    }
  }
}

export default DingtalkService
