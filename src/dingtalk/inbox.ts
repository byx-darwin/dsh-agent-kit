import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { killTree } from '../common/process.js'
import type { KitLogger } from '../common/logger.js'
import { redact } from '../common/redact.js'

/** 来自当前 dws user 的群内 @ 消息。正文是外部输入，业务插件必须自行校验。 */
export interface DingtalkAtMessage {
  eventId: string
  messageId?: string
  conversationId: string
  senderOpenDingtalkId?: string
  content: string
  timestamp?: number
}

export interface DingtalkMessageRoute {
  /** 群的 openConversationId；不要用群名作持久路由键。 */
  conversationId: string
  /** 同群细分规则；省略表示匹配群内所有 @ 消息。 */
  match?: (message: DingtalkAtMessage) => boolean
  /** 数值大的规则优先；同优先级按注册顺序。默认 0。 */
  priority?: number
}

export type DingtalkMessageHandler = (message: DingtalkAtMessage, context: { signal: AbortSignal }) => void | Promise<void>

export interface DingtalkMessageSubscription {
  /** dws 发出 ready 标记后完成；监听启动失败时拒绝。 */
  ready: Promise<void>
  /** 手动注销；调用方插件卸载时也会自动注销。 */
  close(): Promise<void>
}

export interface DingtalkInboxStats {
  listener: 'idle' | 'starting' | 'ready' | 'failed'
  routes: number
  received: number
  dispatched: number
  unmatched: number
  duplicate: number
  dropped: number
  handlerErrors: number
}

type Route = { id: number; config: DingtalkMessageRoute; handler: DingtalkMessageHandler; controller: AbortController }
type PluginHandler = { pluginId: string; handler: DingtalkMessageHandler; controller: AbortController }
const EVENT_TYPE = 'user_im_message_receive_at'
const MAX_LINE = 1024 * 1024
const MAX_QUEUE = 256
const MAX_SEEN = 2048
const HANDLER_TIMEOUT_MS = 30_000

/** 从 dws 的扁平 NDJSON 中只提取已验证的路由字段。 */
export function parseAtMessage(line: string): DingtalkAtMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  if (data.type !== EVENT_TYPE) return undefined
  for (const key of ['event_id', 'conversation_id']) {
    if (typeof data[key] !== 'string' || !data[key]) return undefined
  }
  if (typeof data.content !== 'string') return undefined
  return {
    eventId: data.event_id as string,
    conversationId: data.conversation_id as string,
    content: data.content as string,
    ...(typeof data.message_id === 'string' && data.message_id ? { messageId: data.message_id } : {}),
    ...(typeof data.sender_open_dingtalk_id === 'string' && data.sender_open_dingtalk_id ? { senderOpenDingtalkId: data.sender_open_dingtalk_id } : {}),
    ...(typeof data.timestamp === 'number' && Number.isFinite(data.timestamp) ? { timestamp: data.timestamp } : {}),
  }
}

export class DingtalkInbox {
  private readonly routes = new Map<number, Route>()
  private readonly pluginHandlers = new Map<string, PluginHandler>()
  private nextId = 0
  private child?: ChildProcess
  private readyPromise?: Promise<void>
  private resolveReady?: () => void
  private rejectReady?: (error: Error) => void
  private closed?: Promise<void>
  private stopRequested = false
  private state: DingtalkInboxStats['listener'] = 'idle'
  private readonly queue: DingtalkAtMessage[] = []
  private processing = false
  private readonly seen = new Set<string>()
  private controller = new AbortController()
  private readonly counts = { received: 0, dispatched: 0, unmatched: 0, duplicate: 0, dropped: 0, handlerErrors: 0 }

  constructor(
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly killGraceMs: number,
    private readonly readyTimeoutMs: number,
    private readonly logger: KitLogger,
    private readonly onFailure: (detail: string) => void,
    private readonly onHealthy: () => void,
    private readonly onUnmatched: (message: DingtalkAtMessage) => Promise<void>,
    private readonly captureUnmatched = false,
    private readonly profile: () => string | undefined = () => undefined,
    private readonly groupRoutes: ReadonlyMap<string, string> = new Map(),
  ) {}

  stats(): DingtalkInboxStats {
    return { listener: this.state, routes: this.routes.size + this.pluginHandlers.size, ...this.counts }
  }

  /** 即使尚无业务路由，也保持 @ 订阅，用于发现需要新插件的群消息。 */
  startListening(): Promise<void> {
    return this.start()
  }

  register(config: DingtalkMessageRoute, handler: DingtalkMessageHandler): DingtalkMessageSubscription {
    if (!config.conversationId || typeof config.conversationId !== 'string') throw new TypeError('conversationId is required')
    if (config.match !== undefined && typeof config.match !== 'function') throw new TypeError('match must be a function')
    if (config.priority !== undefined && !Number.isFinite(config.priority)) throw new TypeError('priority must be finite')
    if (typeof handler !== 'function') throw new TypeError('handler must be a function')
    const id = ++this.nextId
    const route = { id, config, handler, controller: new AbortController() }
    this.routes.set(id, route)
    const ready = this.start()
    void ready.catch(() => {})
    let closed = false
    return {
      ready,
      close: async () => {
        if (closed) return
        closed = true
        route.controller.abort()
        this.routes.delete(id)
        if (this.routes.size === 0 && this.pluginHandlers.size === 0 && !this.captureUnmatched) await this.stop()
      },
    }
  }

  /** 注册业务插件处理器；设置页按群 ID 指定 pluginId 后才会向它投递。 */
  registerPlugin(pluginId: string, handler: DingtalkMessageHandler): DingtalkMessageSubscription {
    if (!pluginId.trim()) throw new TypeError('pluginId is required')
    if (typeof handler !== 'function') throw new TypeError('handler must be a function')
    if (this.pluginHandlers.has(pluginId)) throw new TypeError(`pluginId already registered: ${pluginId}`)
    const route = { pluginId, handler, controller: new AbortController() }
    this.pluginHandlers.set(pluginId, route)
    const ready = this.start()
    void ready.catch(() => {})
    let closed = false
    return {
      ready,
      close: async () => {
        if (closed) return
        closed = true
        route.controller.abort()
        if (this.pluginHandlers.get(pluginId) === route) this.pluginHandlers.delete(pluginId)
        if (this.routes.size === 0 && this.pluginHandlers.size === 0 && !this.captureUnmatched) await this.stop()
      },
    }
  }

  private start(): Promise<void> {
    if (this.stopRequested && this.closed) return this.closed.then(() => {
      if (this.routes.size === 0 && this.pluginHandlers.size === 0 && !this.captureUnmatched) throw new Error('dws event listener stopped')
      return this.start()
    })
    if (this.readyPromise) return this.readyPromise
    this.state = 'starting'
    this.stopRequested = false
    this.controller = new AbortController()
    const isScript = /\.(mjs|cjs|js)$/i.test(this.file)
    const profile = this.profile()
    const child = spawn(isScript ? process.execPath : this.file, [
      ...(isScript ? [this.file] : []),
      'event', '+listen-im', '--kind', 'at-me', '-f', 'ndjson',
      ...(profile ? ['--profile', profile] : []),
    ], {
      env: this.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // 调用方可以不 await ready；仍要避免未处理的 Promise rejection。
    void this.readyPromise.catch(() => {})

    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    let outLine = ''
    let errLine = ''
    let dropLine = false
    let forceTimer: NodeJS.Timeout | undefined
    const readyTimer = setTimeout(() => {
      if (this.state !== 'starting') return
      this.fail(`dws event listener did not become ready within ${this.readyTimeoutMs}ms`)
      killTree(child.pid, 'SIGTERM')
      forceTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), this.killGraceMs)
    }, this.readyTimeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      let text = stdout.write(chunk)
      let newline: number
      while ((newline = text.indexOf('\n')) >= 0) {
        const part = text.slice(0, newline)
        text = text.slice(newline + 1)
        if (dropLine) {
          this.counts.dropped++
          dropLine = false
        } else {
          outLine += part
          if (Buffer.byteLength(outLine) > MAX_LINE) this.counts.dropped++
          else if (outLine.trim()) this.accept(outLine.trim())
        }
        outLine = ''
      }
      if (!dropLine) {
        outLine += text
        if (Buffer.byteLength(outLine) > MAX_LINE) {
          dropLine = true
          outLine = ''
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errLine += stderr.write(chunk)
      const lines = errLine.split('\n')
      errLine = lines.pop() ?? ''
      if (errLine.length > MAX_LINE) errLine = ''
      for (const line of lines) {
        if (this.state === 'starting' && /^\[event\] ready\b/.test(line.trim())) {
          clearTimeout(readyTimer)
          this.state = 'ready'
          this.resolveReady?.()
          this.resolveReady = undefined
          this.rejectReady = undefined
          this.onHealthy()
          void this.pump()
        }
      }
    })
    child.on('error', (error) => this.fail(`dws event listener failed to start: ${redact(error.message)}`))
    this.closed = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        clearTimeout(readyTimer)
        clearTimeout(forceTimer)
        if (this.child === child) this.child = undefined
        this.readyPromise = undefined
        this.closed = undefined
        if (this.stopRequested || (this.routes.size === 0 && this.pluginHandlers.size === 0 && !this.captureUnmatched)) {
          this.state = 'idle'
          this.onHealthy()
        } else {
          this.fail(`dws event listener exited: ${code ?? signal ?? 'unknown'}`)
        }
        resolve()
      })
    })
    return this.readyPromise
  }

  private accept(line: string): void {
    const message = parseAtMessage(line)
    if (!message) {
      this.counts.dropped++
      this.logger.warn('invalid dws event line dropped')
      return
    }
    this.counts.received++
    if (this.seen.has(message.eventId)) {
      this.counts.duplicate++
      return
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.counts.dropped++
      this.logger.warn('dws event queue full; message dropped', { eventId: message.eventId })
      return
    }
    this.seen.add(message.eventId)
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!)
    this.queue.push(message)
    if (this.state === 'ready') void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.processing || this.state !== 'ready') return
    this.processing = true
    try {
      while (this.queue.length && this.state === 'ready') {
        const message = this.queue.shift()!
        const routes = [...this.routes.values()]
          .filter((route) => route.config.conversationId === message.conversationId)
          .sort((a, b) => (b.config.priority ?? 0) - (a.config.priority ?? 0) || a.id - b.id)
        const targetPluginId = this.groupRoutes.get(message.conversationId)
        let selected: Pick<Route, 'handler' | 'controller'> | undefined = targetPluginId ? this.pluginHandlers.get(targetPluginId) : undefined
        for (const route of targetPluginId ? [] : routes) {
          try {
            if (!route.config.match || route.config.match(message)) {
              selected = route
              break
            }
          } catch (error) {
            this.counts.handlerErrors++
            this.logger.warn('dingtalk route matcher failed', { eventId: message.eventId, error: redact(String(error)) })
          }
        }
        if (!selected) {
          this.counts.unmatched++
          try {
            await this.onUnmatched(message)
          } catch (error) {
            this.logger.warn('failed to record unmatched dingtalk message', { eventId: message.eventId, error: redact(String(error)) })
          }
          continue
        }
        const signal = AbortSignal.any([this.controller.signal, selected.controller.signal, AbortSignal.timeout(HANDLER_TIMEOUT_MS)])
        let onAbort: (() => void) | undefined
        try {
          await Promise.race([
            Promise.resolve().then(() => selected.handler(message, { signal })),
            new Promise<never>((_, reject) => {
              onAbort = () => reject(new Error('handler aborted or timed out'))
              if (signal.aborted) onAbort()
              else signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
          this.counts.dispatched++
        } catch (error) {
          this.counts.handlerErrors++
          this.logger.warn('dingtalk message handler failed', { eventId: message.eventId, error: redact(String(error)) })
        } finally {
          if (onAbort) signal.removeEventListener('abort', onAbort)
        }
      }
    } finally {
      this.processing = false
    }
  }

  private fail(detail: string): void {
    if (this.state === 'failed') return
    this.state = 'failed'
    this.rejectReady?.(new Error(detail))
    this.resolveReady = undefined
    this.rejectReady = undefined
    this.onFailure(detail)
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    this.controller.abort()
    this.queue.length = 0
    const child = this.child
    if (!child) {
      this.state = 'idle'
      this.onHealthy()
      return
    }
    this.rejectReady?.(new Error('dws event listener stopped'))
    this.resolveReady = undefined
    this.rejectReady = undefined
    // dws 会在合适的 stdin EOF 上清理本次创建的订阅；再用信号兜底。
    child.stdin?.end()
    const termTimer = setTimeout(() => killTree(child.pid, 'SIGTERM'), this.killGraceMs)
    const killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), this.killGraceMs * 2)
    try {
      await this.closed
    } finally {
      clearTimeout(termTimer)
      clearTimeout(killTimer)
    }
  }
}
