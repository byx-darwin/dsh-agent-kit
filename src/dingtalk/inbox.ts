import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ChannelAtMessage, ChannelMessageHandler, ChannelMessageRoute, ChannelMessageSubscription } from '../common/channel.js'
import { MessageRouter, type MessageRouterCounts, type ReplyFactory } from '../common/inbox.js'
import { killTree } from '../common/process.js'
import type { KitLogger } from '../common/logger.js'
import { redact } from '../common/redact.js'

/** 来自当前 dws user 的群内 @ 消息。正文是外部输入，业务插件必须自行校验。 */
export interface DingtalkAtMessage extends ChannelAtMessage {
  senderOpenDingtalkId?: string
}

export type DingtalkMessageRoute = ChannelMessageRoute<DingtalkAtMessage>
export type DingtalkMessageHandler = ChannelMessageHandler<DingtalkAtMessage>
export type DingtalkMessageSubscription = ChannelMessageSubscription

export interface DingtalkInboxStats extends MessageRouterCounts {
  listener: 'idle' | 'starting' | 'ready' | 'failed'
  routes: number
}

const EVENT_TYPE = 'user_im_message_receive_at'
const MAX_LINE = 1024 * 1024

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
    ...(typeof data.sender_open_dingtalk_id === 'string' && data.sender_open_dingtalk_id
      ? { senderOpenDingtalkId: data.sender_open_dingtalk_id, senderId: data.sender_open_dingtalk_id }
      : {}),
    ...(typeof data.timestamp === 'number' && Number.isFinite(data.timestamp) ? { timestamp: data.timestamp } : {}),
  }
}

export class DingtalkInbox {
  private readonly router: MessageRouter<DingtalkAtMessage>
  private child?: ChildProcess
  private readyPromise?: Promise<void>
  private resolveReady?: () => void
  private rejectReady?: (error: Error) => void
  private closed?: Promise<void>
  private stopRequested = false
  private state: DingtalkInboxStats['listener'] = 'idle'

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
    private readonly replyFor?: ReplyFactory<DingtalkAtMessage>,
  ) {
    this.router = new MessageRouter<DingtalkAtMessage>({ channel: 'dingtalk', logger, onUnmatched, pluginRoutes: groupRoutes, replyFor })
  }

  stats(): DingtalkInboxStats {
    return { listener: this.state, routes: this.router.size, ...this.router.counters() }
  }

  /** 即使尚无业务路由，也保持 @ 订阅，用于发现需要新插件的群消息。 */
  startListening(): Promise<void> {
    return this.start()
  }

  register(config: DingtalkMessageRoute, handler: DingtalkMessageHandler): DingtalkMessageSubscription {
    return this.subscribe(this.router.register(config, handler))
  }

  /** 注册业务插件处理器；设置页按群 ID 指定 pluginId 后才会向它投递。 */
  registerPlugin(pluginId: string, handler: DingtalkMessageHandler): DingtalkMessageSubscription {
    return this.subscribe(this.router.registerPlugin(pluginId, handler))
  }

  private subscribe(dispose: () => void): DingtalkMessageSubscription {
    const ready = this.start()
    void ready.catch(() => {})
    let closed = false
    return {
      ready,
      close: async () => {
        if (closed) return
        closed = true
        dispose()
        if (this.router.size === 0 && !this.captureUnmatched) await this.stop()
      },
    }
  }

  private start(): Promise<void> {
    if (this.stopRequested && this.closed) return this.closed.then(() => {
      if (this.router.size === 0 && !this.captureUnmatched) throw new Error('dws event listener stopped')
      return this.start()
    })
    if (this.readyPromise) return this.readyPromise
    this.state = 'starting'
    this.stopRequested = false
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
          this.router.drop()
          dropLine = false
        } else {
          outLine += part
          if (Buffer.byteLength(outLine) > MAX_LINE) this.router.drop()
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
          this.router.setReady(true)
        }
      }
    })
    child.on('error', (error) => this.fail(`dws event listener failed to start: ${redact(error.message)}`))
    this.closed = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        this.router.setReady(false)
        clearTimeout(readyTimer)
        clearTimeout(forceTimer)
        if (this.child === child) this.child = undefined
        this.readyPromise = undefined
        this.closed = undefined
        if (this.stopRequested || (this.router.size === 0 && !this.captureUnmatched)) {
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
      this.router.drop()
      this.logger.warn('invalid dws event line dropped')
      return
    }
    this.router.accept(message)
  }

  private fail(detail: string): void {
    if (this.state === 'failed') return
    this.state = 'failed'
    this.router.setReady(false)
    this.rejectReady?.(new Error(detail))
    this.resolveReady = undefined
    this.rejectReady = undefined
    this.onFailure(detail)
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    this.router.reset()
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
