/** 企业微信连接测试：建立一次长连接，认证成功或失败后立即断开。会把同一机器人的其他连接挤下线，调用方必须先征得确认。 */
export interface WecomProbeResult {
  ok: boolean
  detail: string
}

export type WecomProbe = (input: { botId: string; secret: string; wsUrl?: string; timeoutMs?: number }) => Promise<WecomProbeResult>

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

export const probeWecom: WecomProbe = async ({ botId, secret, wsUrl, timeoutMs = 10_000 }) => {
  let sdk: typeof import('@wecom/aibot-node-sdk')
  try {
    sdk = await import('@wecom/aibot-node-sdk')
  } catch {
    return { ok: false, detail: '未安装 @wecom/aibot-node-sdk' }
  }
  // 重连与认证重试次数为 0：第一次失败就放弃，不会无限重试
  const client = new sdk.WSClient({ botId, secret, ...(wsUrl ? { wsUrl } : {}), maxReconnectAttempts: 0, maxAuthFailureAttempts: 0, logger: quiet })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<WecomProbeResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, detail: `${timeoutMs / 1000} 秒内没有完成认证` }), timeoutMs)
      client.on('authenticated', () => resolve({ ok: true, detail: '认证成功' }))
      client.on('error', (e: Error) => resolve({ ok: false, detail: `认证失败：${e.message}` }))
      client.connect()
    })
  } finally {
    if (timer) clearTimeout(timer)
    client.disconnect()
  }
}
