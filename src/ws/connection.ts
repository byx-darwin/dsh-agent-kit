import WebSocket, { type RawData } from 'ws'
import { KitError } from '../common/errors.js'
import type { KitLogger } from '../common/logger.js'
import { digest, redactValue, registerSecret } from '../common/redact.js'
import type { WsConfig } from './config.js'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed'

export type HeadersInit = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)

export interface MessageContext {
  /** 连接关闭或调用方插件卸载时中止。 */
  signal: AbortSignal
}

export interface ConnectOptions<TIn = JsonValue> {
  url: string
  headers?: HeadersInit
  /** 把 JsonValue 转成业务类型；抛错则丢弃该帧。 */
  parse?: (value: JsonValue) => TIn
  onMessage: (frame: TIn, context: MessageContext) => void | Promise<void>
  onError?: (err: unknown, frame: TIn) => void
  onStateChange?: (state: ConnectionState) => void
  /** 以这些关闭码断开时视为鉴权或配置错误，进入 `failed`。 */
  fatalCloseCodes?: number[]
  /** 同时执行的 `onMessage` 上限，默认 1（按到达顺序串行）。 */
  concurrency?: number
  traceId?: string
}

export class WsError extends KitError {
  constructor(code: 'not_open' | 'closed' | 'aborted' | 'invalid_url' | 'invalid_options', message: string, retryable = false) {
    super('agentWs', code, message, { retryable })
    this.name = 'WsError'
  }
}

export interface ConnectionStats {
  url: string
  state: ConnectionState
  reconnects: number
  lastFrameAt: number | null
  pendingMessages: number
  failureReason?: string
}

export interface ConnectionHooks {
  logger: KitLogger
  onFailed(conn: AgentWsConnection<any>, reason: string): void
  onStateChange(conn: AgentWsConnection<any>): void
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function validateUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new WsError('invalid_url', 'invalid WebSocket URL')
  }
  if (parsed.protocol === 'wss:') return parsed
  if (parsed.protocol === 'ws:' && LOCAL_HOSTS.has(parsed.hostname)) return parsed
  throw new WsError('invalid_url', 'only wss:// is allowed (ws:// only for localhost)')
}

/** 第 `attempt` 次重连（从 0 开始）的延迟：指数退避，封顶 `maxDelayMs`，再向下抖动。 */
export function backoffDelay(attempt: number, reconnect: WsConfig['reconnect'], random = Math.random): number {
  const base = Math.min(reconnect.maxDelayMs, reconnect.initialDelayMs * 2 ** Math.min(attempt, 30))
  return Math.max(0, Math.round(base * (1 - reconnect.jitter * random())))
}

export class AgentWsConnection<TIn = JsonValue> {
  private _state: ConnectionState = 'connecting'
  private ws?: WebSocket
  private attempt = 0
  private reconnects = 0
  private lastFrameAt: number | null = null
  private failureReason?: string
  private readonly url: URL
  private readonly controller = new AbortController()
  private readonly queue: TIn[] = []
  private active = 0
  private paused = false
  private readonly concurrency: number
  private readonly fatalCloseCodes: Set<number>
  private readonly secretDisposers: Array<() => void> = []
  private reconnectTimer?: NodeJS.Timeout
  private pingTimer?: NodeJS.Timeout
  private readTimer?: NodeJS.Timeout
  private stableTimer?: NodeJS.Timeout
  private openWaiters = new Set<{ resolve: () => void; reject: (err: unknown) => void }>()
  private closePromise?: Promise<void>

  constructor(
    private readonly options: ConnectOptions<TIn>,
    private readonly config: WsConfig,
    private readonly hooks: ConnectionHooks,
  ) {
    this.url = validateUrl(options.url)
    const concurrency = options.concurrency ?? 1
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new WsError('invalid_options', 'concurrency must be an integer >= 1')
    this.concurrency = concurrency
    this.fatalCloseCodes = new Set(options.fatalCloseCodes ?? [])
    if (typeof options.onMessage !== 'function') throw new WsError('invalid_options', 'onMessage is required')
  }

  get state(): ConnectionState {
    return this._state
  }

  /** 当前待处理（排队 + 执行中）的消息数。 */
  get pendingMessages(): number {
    return this.queue.length + this.active
  }

  stats(): ConnectionStats {
    return {
      url: `${this.url.protocol}//${this.url.host}${this.url.pathname}`,
      state: this._state,
      reconnects: this.reconnects,
      lastFrameAt: this.lastFrameAt,
      pendingMessages: this.pendingMessages,
      ...(this.failureReason ? { failureReason: this.failureReason } : {}),
    }
  }

  /** @internal 由 Service 调用，开始第一次连接。 */
  start(): void {
    try {
      this.options.onStateChange?.('connecting')
    } catch (e) {
      this.hooks.logger.warn('onStateChange threw', { error: redactValue(e), traceId: this.options.traceId })
    }
    void this.open()
  }

  whenOpen(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this._state === 'open') return Promise.resolve()
    if (this._state === 'closed') return Promise.reject(new WsError('closed', 'connection is closed'))
    if (options.signal?.aborted) return Promise.reject(new WsError('aborted', 'aborted'))
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          cleanup()
          resolve()
        },
        reject: (err: unknown) => {
          cleanup()
          reject(err)
        },
      }
      const onAbort = () => waiter.reject(new WsError('aborted', 'aborted'))
      const cleanup = () => {
        this.openWaiters.delete(waiter)
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.openWaiters.add(waiter)
    })
  }

  /** 写入 socket 缓冲区后 resolve；连接未处于 `open` 时 reject（不做内部排队）。 */
  send(frame: unknown): Promise<void> {
    const ws = this.ws
    if (this._state !== 'open' || !ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new WsError('not_open', `connection is ${this._state}`, true))
    }
    let data: string
    try {
      data = JSON.stringify(frame)
    } catch (e) {
      return Promise.reject(new WsError('invalid_options', `frame is not JSON serializable: ${(e as Error).message}`))
    }
    return new Promise((resolve, reject) => {
      ws.send(data, (err) => {
        if (err) reject(new WsError('not_open', `send failed: ${err.message}`, true))
        else resolve()
      })
    })
  }

  close(code = 1000): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.setState('closed')
    this.clearTimers()
    this.controller.abort(new WsError('closed', 'connection closed'))
    this.queue.length = 0
    for (const waiter of [...this.openWaiters]) waiter.reject(new WsError('closed', 'connection is closed'))
    for (const dispose of this.secretDisposers.splice(0)) dispose()
    const ws = this.ws
    this.ws = undefined
    this.closePromise = new Promise<void>((resolve) => {
      if (!ws || ws.readyState === WebSocket.CLOSED) return resolve()
      const timer = setTimeout(() => {
        ws.terminate()
        resolve()
      }, 2000)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
      else ws.close(code)
    })
    return this.closePromise
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return
    this._state = state
    if (state === 'open') {
      this.failureReason = undefined
      for (const waiter of [...this.openWaiters]) waiter.resolve()
    }
    this.hooks.onStateChange(this)
    try {
      this.options.onStateChange?.(state)
    } catch (e) {
      this.hooks.logger.warn('onStateChange threw', { error: redactValue(e), traceId: this.options.traceId })
    }
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    const init = this.options.headers
    const headers = typeof init === 'function' ? await init() : { ...(init ?? {}) }
    // 鉴权头的值登记为密钥，日志与错误中出现时会被替换
    for (const dispose of this.secretDisposers.splice(0)) dispose()
    for (const value of Object.values(headers)) this.secretDisposers.push(registerSecret(value))
    return headers
  }

  private async open(): Promise<void> {
    if (this._state === 'closed') return
    let headers: Record<string, string>
    try {
      headers = await this.resolveHeaders()
    } catch (e) {
      this.hooks.logger.warn('failed to resolve headers', { error: redactValue(e), traceId: this.options.traceId })
      this.scheduleReconnect()
      return
    }
    if ((this._state as ConnectionState) === 'closed') return

    let fatal: string | undefined
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, {
        headers,
        followRedirects: false,
        maxPayload: this.config.maxPayloadBytes,
        handshakeTimeout: this.config.readTimeoutMs,
        perMessageDeflate: false,
      })
    } catch (e) {
      // 例如 headers() 返回了非法的请求头
      this.hooks.logger.warn('failed to create websocket', { error: redactValue(e), traceId: this.options.traceId })
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.on('unexpected-response', (req, res) => {
      const status = res.statusCode ?? 0
      if (status === 401 || status === 403) fatal = `handshake rejected with HTTP ${status}`
      else this.hooks.logger.warn('unexpected handshake response', { status, traceId: this.options.traceId })
      res.resume()
      req.destroy()
      // ws 在 unexpected-response 有监听时不会自行清理
      ws.terminate()
    })
    ws.on('open', () => this.onOpen(ws))
    ws.on('message', (data, isBinary) => this.onFrame(ws, data, isBinary))
    ws.on('pong', () => this.touch(ws))
    ws.on('ping', () => this.touch(ws))
    ws.on('error', (err) => {
      this.hooks.logger.warn('websocket error', { error: redactValue(err), traceId: this.options.traceId })
    })
    ws.on('close', (code) => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.clearTimers()
      if (this._state === 'closed') return
      if (fatal) return this.fail(fatal)
      if (this.fatalCloseCodes.has(code)) return this.fail(`closed with fatal code ${code}`)
      this.hooks.logger.info('websocket disconnected', { code, traceId: this.options.traceId })
      this.scheduleReconnect()
    })
  }

  private onOpen(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.setState('open')
    this.hooks.logger.info('websocket open', { url: this.stats().url, traceId: this.options.traceId })
    if (this.config.stableResetMs === 0) this.attempt = 0
    else this.stableTimer = setTimeout(() => (this.attempt = 0), this.config.stableResetMs)
    this.pingTimer = setInterval(() => {
      if (!this.paused && ws.readyState === WebSocket.OPEN) ws.ping()
    }, this.config.pingIntervalMs)
    if (this.paused) ws.pause()
    this.armReadTimer(ws)
  }

  private touch(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.lastFrameAt = Date.now()
    this.armReadTimer(ws)
  }

  private armReadTimer(ws: WebSocket): void {
    clearTimeout(this.readTimer)
    // 背压暂停期间不读取 socket，读超时暂停计时
    if (this.paused) return
    this.readTimer = setTimeout(() => {
      this.hooks.logger.warn('read timeout, reconnecting', { traceId: this.options.traceId })
      ws.terminate()
    }, this.config.readTimeoutMs)
  }

  private onFrame(ws: WebSocket, data: RawData, isBinary: boolean): void {
    this.touch(ws)
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    if (isBinary) {
      this.hooks.logger.warn('dropped binary frame', { frame: digest(buf), traceId: this.options.traceId })
      return
    }
    let value: JsonValue
    try {
      value = JSON.parse(buf.toString('utf8')) as JsonValue
    } catch {
      this.hooks.logger.warn('dropped non-JSON frame', { frame: digest(buf), traceId: this.options.traceId })
      return
    }
    let frame: TIn
    try {
      frame = this.options.parse ? this.options.parse(value) : (value as TIn)
    } catch (e) {
      this.hooks.logger.warn('dropped frame rejected by parse()', {
        frame: digest(buf),
        error: redactValue(e instanceof Error ? e.name : 'Error'),
        traceId: this.options.traceId,
      })
      return
    }
    this.queue.push(frame)
    this.updateBackpressure()
    this.drain()
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0 && this._state !== 'closed') {
      const frame = this.queue.shift() as TIn
      this.active++
      void this.handle(frame).finally(() => {
        this.active--
        this.updateBackpressure()
        this.drain()
      })
    }
  }

  private async handle(frame: TIn): Promise<void> {
    try {
      await this.options.onMessage(frame, { signal: this.controller.signal })
    } catch (err) {
      if (this.options.onError) {
        try {
          this.options.onError(err, frame)
        } catch (e) {
          this.hooks.logger.error('onError threw', { error: redactValue(e), traceId: this.options.traceId })
        }
      } else {
        this.hooks.logger.error('onMessage failed', { error: redactValue(err), traceId: this.options.traceId })
      }
    }
  }

  private updateBackpressure(): void {
    const pending = this.pendingMessages
    const ws = this.ws
    if (!this.paused && pending > this.config.maxPendingMessages) {
      this.paused = true
      this.hooks.logger.warn('backpressure: pausing socket reads', { pending, traceId: this.options.traceId })
      if (ws) {
        ws.pause()
        clearTimeout(this.readTimer)
      }
    } else if (this.paused && pending < this.config.maxPendingMessages) {
      this.paused = false
      this.hooks.logger.info('backpressure: resuming socket reads', { pending, traceId: this.options.traceId })
      if (ws) {
        ws.resume()
        if (ws.readyState === WebSocket.OPEN) this.armReadTimer(ws)
      }
    }
  }

  private scheduleReconnect(): void {
    if (this._state === 'closed') return
    this.setState('reconnecting')
    const delay = backoffDelay(this.attempt, this.config.reconnect)
    this.attempt++
    this.reconnects++
    this.hooks.logger.info('reconnect scheduled', { delayMs: delay, attempt: this.attempt, traceId: this.options.traceId })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.open()
    }, delay)
  }

  private fail(reason: string): void {
    this.failureReason = reason
    this.setState('failed')
    this.hooks.logger.error('websocket failed', { reason, traceId: this.options.traceId })
    this.hooks.onFailed(this, reason)
    if (this.config.fatalRetryDelayMs > 0) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        if (this._state !== 'failed') return
        this.reconnects++
        this.setState('connecting')
        void this.open()
      }, this.config.fatalRetryDelayMs)
    }
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer)
    clearInterval(this.pingTimer)
    clearTimeout(this.readTimer)
    clearTimeout(this.stableTimer)
    this.reconnectTimer = this.pingTimer = this.readTimer = this.stableTimer = undefined
  }
}
