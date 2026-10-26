import type { ChannelAtMessage, ChannelMessageHandler, ChannelMessageRoute, ChannelReplyOptions, ChannelSendResult } from './channel.js'
import type { ServiceName } from './errors.js'
import { replyUnsupported } from './reply.js'
import type { KitLogger } from './logger.js'
import { redact } from './redact.js'

export const MAX_QUEUE = 256
export const MAX_SEEN = 2048
export const HANDLER_TIMEOUT_MS = 30_000

export interface MessageRouterCounts {
  received: number
  dispatched: number
  unmatched: number
  duplicate: number
  dropped: number
  handlerErrors: number
}

/** 由渠道提供：为一条收到的消息生成回复函数。 */
export type ReplyFactory<M extends ChannelAtMessage> = (message: M) => (options: ChannelReplyOptions) => Promise<ChannelSendResult>

export interface MessageRouterOptions<M extends ChannelAtMessage> {
  /** 日志前缀，如 `dingtalk`。 */
  channel: string
  logger: KitLogger
  /** 未命中任何路由时调用；失败只记日志。 */
  onUnmatched: (message: M) => Promise<void>
  /** 会话 ID → 插件 ID；配置了的会话只投递给该插件，不再看 `register()` 的路由。 */
  pluginRoutes?: ReadonlyMap<string, string>
  handlerTimeoutMs?: number
  /** 渠道的回复实现；未提供时 `reply()` 返回 `reply_unsupported` 失败结果。 */
  replyFor?: ReplyFactory<M>
}

type Route<M extends ChannelAtMessage> = { id: number; config: ChannelMessageRoute<M>; handler: ChannelMessageHandler<M>; controller: AbortController }
type PluginHandler<M extends ChannelAtMessage> = { handler: ChannelMessageHandler<M>; controller: AbortController }

/**
 * 与渠道无关的群内 @ 消息路由：按 `eventId` 去重、有界队列、优先级路由、插件路由与 handler 超时。
 * 连接（子进程、长连接）由各渠道负责：解析出消息后 `accept()`，就绪时 `setReady(true)`，断开时 `setReady(false)`，停止时 `reset()`。
 * 每条消息只投递给一个处理器，按顺序逐条处理。
 */
export class MessageRouter<M extends ChannelAtMessage> {
  private readonly routes = new Map<number, Route<M>>()
  private readonly plugins = new Map<string, PluginHandler<M>>()
  private nextId = 0
  private readonly queue: M[] = []
  private readonly seen = new Set<string>()
  private processing = false
  private ready = false
  private controller = new AbortController()
  private readonly counts: MessageRouterCounts = { received: 0, dispatched: 0, unmatched: 0, duplicate: 0, dropped: 0, handlerErrors: 0 }

  constructor(private readonly options: MessageRouterOptions<M>) {}

  private replyTo(message: M, signal: AbortSignal): (options: ChannelReplyOptions) => Promise<ChannelSendResult> {
    const send = this.options.replyFor?.(message)
    if (!send) return () => replyUnsupported(this.options.channel as ServiceName)
    return (options) => send({ ...options, signal: options.signal ?? signal })
  }

  /** 已注册的路由与插件处理器总数。 */
  get size(): number {
    return this.routes.size + this.plugins.size
  }

  counters(): MessageRouterCounts {
    return { ...this.counts }
  }

  /** 注册路由；返回幂等的注销函数，注销时中止该路由进行中的 handler。 */
  register(config: ChannelMessageRoute<M>, handler: ChannelMessageHandler<M>): () => void {
    if (!config.conversationId || typeof config.conversationId !== 'string') throw new TypeError('conversationId is required')
    if (config.match !== undefined && typeof config.match !== 'function') throw new TypeError('match must be a function')
    if (config.priority !== undefined && !Number.isFinite(config.priority)) throw new TypeError('priority must be finite')
    if (typeof handler !== 'function') throw new TypeError('handler must be a function')
    const id = ++this.nextId
    const route = { id, config, handler, controller: new AbortController() }
    this.routes.set(id, route)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      route.controller.abort()
      this.routes.delete(id)
    }
  }

  /** 注册业务插件处理器；`pluginRoutes` 指向该插件的会话才会投递给它。 */
  registerPlugin(pluginId: string, handler: ChannelMessageHandler<M>): () => void {
    if (!pluginId.trim()) throw new TypeError('pluginId is required')
    if (typeof handler !== 'function') throw new TypeError('handler must be a function')
    if (this.plugins.has(pluginId)) throw new TypeError(`pluginId already registered: ${pluginId}`)
    const plugin = { handler, controller: new AbortController() }
    this.plugins.set(pluginId, plugin)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      plugin.controller.abort()
      if (this.plugins.get(pluginId) === plugin) this.plugins.delete(pluginId)
    }
  }

  /** 记一条无法解析的输入。 */
  drop(): void {
    this.counts.dropped++
  }

  accept(message: M): void {
    this.counts.received++
    if (this.seen.has(message.eventId)) {
      this.counts.duplicate++
      return
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.counts.dropped++
      this.options.logger.warn(`${this.options.channel} event queue full; message dropped`, { eventId: message.eventId })
      return
    }
    this.seen.add(message.eventId)
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!)
    this.queue.push(message)
    if (this.ready) void this.pump()
  }

  setReady(ready: boolean): void {
    this.ready = ready
    if (ready) void this.pump()
  }

  reset(): void {
    this.ready = false
    this.controller.abort()
    this.controller = new AbortController()
    this.queue.length = 0
  }

  private select(message: M): Pick<Route<M>, 'handler' | 'controller'> | undefined {
    const pluginId = this.options.pluginRoutes?.get(message.conversationId)
    if (pluginId) return this.plugins.get(pluginId)
    const routes = [...this.routes.values()]
      .filter((route) => route.config.conversationId === message.conversationId)
      .sort((a, b) => (b.config.priority ?? 0) - (a.config.priority ?? 0) || a.id - b.id)
    for (const route of routes) {
      try {
        if (!route.config.match || route.config.match(message)) return route
      } catch (error) {
        this.counts.handlerErrors++
        this.options.logger.warn(`${this.options.channel} route matcher failed`, { eventId: message.eventId, error: redact(String(error)) })
      }
    }
    return undefined
  }

  private async pump(): Promise<void> {
    if (this.processing || !this.ready) return
    this.processing = true
    try {
      while (this.queue.length && this.ready) {
        const message = this.queue.shift()!
        const selected = this.select(message)
        if (!selected) {
          this.counts.unmatched++
          try {
            await this.options.onUnmatched(message)
          } catch (error) {
            this.options.logger.warn(`failed to record unmatched ${this.options.channel} message`, { eventId: message.eventId, error: redact(String(error)) })
          }
          continue
        }
        const signal = AbortSignal.any([this.controller.signal, selected.controller.signal, AbortSignal.timeout(this.options.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS)])
        let onAbort: (() => void) | undefined
        try {
          await Promise.race([
            Promise.resolve().then(() => selected.handler(message, { signal, reply: this.replyTo(message, signal) })),
            new Promise<never>((_, reject) => {
              onAbort = () => reject(new Error('handler aborted or timed out'))
              if (signal.aborted) onAbort()
              else signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
          this.counts.dispatched++
        } catch (error) {
          this.counts.handlerErrors++
          this.options.logger.warn(`${this.options.channel} message handler failed`, { eventId: message.eventId, error: redact(String(error)) })
        } finally {
          if (onAbort) signal.removeEventListener('abort', onAbort)
        }
      }
    } finally {
      this.processing = false
    }
  }
}
