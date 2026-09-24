import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

export interface TestWsServer {
  /** `ws://127.0.0.1:<port>` */
  url: string
  readonly clients: WebSocket[]
  /** 每次握手（含被拒绝的）的请求头。 */
  readonly handshakes: IncomingMessage['headers'][]
  /** 下 N 次握手返回指定 HTTP 状态（例如 401）。 */
  rejectNext(status: number, times?: number): void
  /** 等待第 n 个（从 1 开始）连接建立；省略时返回最近的连接（没有则等待第一个）。 */
  waitForConnection(n?: number): Promise<WebSocket>
  /** 向所有连接发送 JSON 帧。 */
  broadcast(frame: unknown): void
  /** 收到的客户端帧（已解析 JSON）。 */
  readonly received: unknown[]
  /** 是否自动回复 ping（关闭后用于模拟读超时）。 */
  autoPong: boolean
  close(): Promise<void>
}

/** 在本机随机端口启动一个 WebSocket 测试服务端。 */
export async function startTestWsServer(options: { maxPayload?: number } = {}): Promise<TestWsServer> {
  let rejectStatus: number | undefined
  let rejectTimes = 0
  const clients: WebSocket[] = []
  const handshakes: IncomingMessage['headers'][] = []
  const received: unknown[] = []
  const waiters: Array<{ n: number; resolve: (ws: WebSocket) => void }> = []
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: options.maxPayload ?? 100 * 1024 * 1024,
    autoPong: false,
    verifyClient: (info, done) => {
      handshakes.push(info.req.headers)
      if (rejectTimes > 0 && rejectStatus !== undefined) {
        rejectTimes--
        done(false, rejectStatus)
      } else done(true)
    },
  })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const server: TestWsServer = {
    url: `ws://127.0.0.1:${port}`,
    clients,
    handshakes,
    received,
    autoPong: true,
    rejectNext(status, times = 1) {
      rejectStatus = status
      rejectTimes = times
    },
    waitForConnection(n = Math.max(1, clients.length)) {
      if (clients.length >= n) return Promise.resolve(clients[n - 1]!)
      return new Promise((resolve) => waiters.push({ n, resolve }))
    },
    broadcast(frame) {
      const data = JSON.stringify(frame)
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data)
    },
    close() {
      for (const ws of clients) ws.terminate()
      return new Promise((resolve) => wss.close(() => resolve()))
    },
  }
  wss.on('connection', (ws) => {
    clients.push(ws)
    // 手动回复 pong，便于测试中关闭以模拟读超时
    ws.on('ping', (data) => {
      if (server.autoPong) ws.pong(data)
    })
    ws.on('message', (data) => {
      try {
        received.push(JSON.parse(data.toString()))
      } catch {
        received.push(data.toString())
      }
    })
    for (const w of waiters.splice(0)) {
      if (clients.length >= w.n) w.resolve(clients[w.n - 1]!)
      else waiters.push(w)
    }
  })
  return server
}
