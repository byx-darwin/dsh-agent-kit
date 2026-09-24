import type { Context } from '@deepseek-ai/cordis'
import { KitService, type ServiceHealth } from '../common/service.js'
import { AgentWsConnection, type ConnectOptions, type ConnectionState, type ConnectionStats, type JsonValue } from './connection.js'
import { WsConfig, assertWsConfig } from './config.js'

export interface AgentWsCounters {
  connections: ConnectionStats[]
  reconnects: number
  lastFrameAt: number | null
  pendingMessages: number
}

/** 连接句柄：业务包持有，随调用方插件卸载自动关闭。 */
export interface AgentWsHandle {
  readonly state: ConnectionState
  whenOpen(options?: { signal?: AbortSignal }): Promise<void>
  send(frame: unknown): Promise<void>
  close(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentWs: AgentWsService
  }
}

export class AgentWsService extends KitService<AgentWsCounters> {
  static Config = WsConfig
  private readonly connections = new Set<AgentWsConnection<any>>()
  readonly config: WsConfig

  constructor(ctx: Context, config: WsConfig) {
    super(ctx, 'agentWs')
    this.config = assertWsConfig(config)
  }

  /**
   * 建立一条自动重连的 WebSocket 连接。连接注册为调用方的 effect：
   * 调用方插件卸载时以 1001 关闭，正在执行的 `onMessage` 收到的 signal 被中止。
   */
  connect<TIn = JsonValue>(options: ConnectOptions<TIn>): AgentWsHandle {
    const conn = new AgentWsConnection<TIn>(options, this.config, {
      logger: this.logger,
      onFailed: (_, reason) => this.markFailed(`connection failed: ${reason}`),
      onStateChange: () => this.refreshFailed(),
    })
    // this.ctx 是调用方插件的上下文（cordis 为每个 inject 方创建独立视图）
    this.ctx.effect(() => {
      this.connections.add(conn)
      conn.start()
      return () => {
        this.connections.delete(conn)
        void conn.close(1001)
      }
    }, 'agentWs.connect()')
    return {
      get state() {
        return conn.state
      },
      whenOpen: (opts) => conn.whenOpen(opts),
      send: (frame) => conn.send(frame),
      close: () => conn.close(1000),
    }
  }

  health(): ServiceHealth<AgentWsCounters> {
    const connections = [...this.connections].map((c) => c.stats())
    const failed = connections.filter((c) => c.state === 'failed')
    const notOpen = connections.filter((c) => c.state !== 'open' && c.state !== 'closed')
    const counters: AgentWsCounters = {
      connections,
      reconnects: connections.reduce((n, c) => n + c.reconnects, 0),
      lastFrameAt: connections.reduce<number | null>((t, c) => (c.lastFrameAt !== null && (t === null || c.lastFrameAt > t) ? c.lastFrameAt : t), null),
      pendingMessages: connections.reduce((n, c) => n + c.pendingMessages, 0),
    }
    if (failed.length > 0) {
      return { status: 'failed', detail: `${failed.length} connection(s) failed: ${failed.map((c) => c.failureReason).join('; ')}`, counters }
    }
    if (notOpen.length > 0) return { status: 'degraded', detail: `${notOpen.length} connection(s) not open`, counters }
    return { status: 'ok', detail: `${connections.length} connection(s) open`, counters }
  }

  private refreshFailed(): void {
    if (![...this.connections].some((c) => c.state === 'failed')) this.clearFailed()
  }
}

export default AgentWsService
