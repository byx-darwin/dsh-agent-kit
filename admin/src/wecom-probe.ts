import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { redact, registerSecret } from '@baoyx/dsh-agent-kit'

/** 企业微信连接测试：建立一次长连接，认证成功或失败后立即断开。会把同一机器人的其他连接挤下线，调用方必须先征得确认。 */
export interface WecomProbeResult {
  ok: boolean
  detail: string
}

export type WecomProbe = (input: { botId: string; secret: string; wsUrl?: string; timeoutMs?: number }) => Promise<WecomProbeResult>

/** 探测用到的 WSClient 的最小形状，便于测试注入假实现。 */
export interface WecomProbeClient {
  on(event: string, listener: (...args: any[]) => void): unknown
  connect(): unknown
  disconnect(): unknown
}
export interface WecomProbeSdk {
  WSClient: new (options: Record<string, unknown>) => WecomProbeClient
}
export type WecomSdkLoader = () => Promise<WecomProbeSdk>

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DISCONNECTED = '连接被服务端断开（可能同一机器人在别处建立了连接，或 BotID / Secret 不正确）'

const defaultLoad: WecomSdkLoader = async () => (await import('@wecom/aibot-node-sdk')) as unknown as WecomProbeSdk

/**
 * 按 dsh 的解析规则从 Profile 目录加载 SDK（与 doctor 的检查一致）。
 * admin 经 npx 运行时，相对 admin 包的 import 找不到 Profile 里安装的 SDK。
 */
export function profileWecomSdkLoader(profileDir: string): WecomSdkLoader {
  return async () => {
    const resolved = createRequire(join(profileDir, 'package.json')).resolve('@wecom/aibot-node-sdk')
    return (await import(pathToFileURL(resolved).href)) as WecomProbeSdk
  }
}

/** 只有认证类错误才标为「认证失败」：SDK 的终态 WSAuthFailureError，或带 errcode 的认证响应。 */
function isAuthError(e: Error | undefined): boolean {
  if (e?.name === 'WSAuthFailureError') return true
  const message = String(e?.message ?? '')
  return /^Authentication failed\b/i.test(message) || /\(code: \d+\)|errcode[=:]\s*\d+/i.test(message)
}

function describeError(e: Error | undefined): string {
  if (e?.name === 'WSReconnectExhaustedError') return DISCONNECTED
  const message = e?.message ?? String(e)
  return isAuthError(e) ? `认证失败：${message}` : `连接失败：${message}`
}

export function createWecomProbe(load: WecomSdkLoader): WecomProbe {
  return async ({ botId, secret, wsUrl, timeoutMs = 10_000 }) => {
    let sdk: WecomProbeSdk
    try {
      sdk = await load()
    } catch {
      return { ok: false, detail: '未安装 @wecom/aibot-node-sdk' }
    }
    // 先登记 Secret，SDK 带出的任何文本都会经 redact 抹掉
    const unregister = registerSecret(secret)
    let client: WecomProbeClient | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<WecomProbeResult>((resolve) => {
        const done = (r: WecomProbeResult): void => resolve({ ok: r.ok, detail: redact(r.detail) })
        try {
          // 重连与认证重试次数为 0：第一次失败就放弃，不会无限重试
          client = new sdk.WSClient({ botId, secret, ...(wsUrl ? { wsUrl } : {}), maxReconnectAttempts: 0, maxAuthFailureAttempts: 0, logger: quiet })
          timer = setTimeout(() => done({ ok: false, detail: `${Math.ceil(timeoutMs / 1000)} 秒内没有完成认证` }), timeoutMs)
          client.on('authenticated', () => done({ ok: true, detail: '认证成功' }))
          client.on('error', (e: Error) => done({ ok: false, detail: describeError(e) }))
          client.on('disconnected', () => done({ ok: false, detail: DISCONNECTED }))
          client.connect()
        } catch (e) {
          done({ ok: false, detail: `连接失败：${e instanceof Error ? e.message : String(e)}` })
        }
      })
    } finally {
      if (timer) clearTimeout(timer)
      try {
        client?.disconnect()
      } catch {
        // 断开失败不影响结果
      }
      unregister()
    }
  }
}

/** 相对 admin 包加载 SDK；setup 用 {@link profileWecomSdkLoader}，此导出仅为兼容保留。 */
export const probeWecom: WecomProbe = createWecomProbe(defaultLoad)
