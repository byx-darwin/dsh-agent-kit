/** 飞书凭据检查与测试消息；doctor 与 setup 共用，不依赖飞书 SDK。 */
export interface FeishuProbeResult {
  ok: boolean
  botName?: string
  detail: string
}

export type FeishuProbe = (input: { appId: string; appSecret: string; domain: 'feishu' | 'lark' }) => Promise<FeishuProbeResult>

const BASE = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' } as const
const TIMEOUT_MS = 5000

async function tenantToken(input: { appId: string; appSecret: string; domain: 'feishu' | 'lark' }): Promise<{ token?: string; detail: string }> {
  const res = await fetch(`${BASE[input.domain]}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string }
  return data.code === 0 && data.tenant_access_token ? { token: data.tenant_access_token, detail: 'ok' } : { detail: `${data.code ?? res.status} ${data.msg ?? ''}`.trim() }
}

export const probeFeishu: FeishuProbe = async (input) => {
  try {
    const { token, detail } = await tenantToken(input)
    if (!token) return { ok: false, detail: `获取 tenant_access_token 失败：${detail}` }
    const res = await fetch(`${BASE[input.domain]}/open-apis/bot/v3/info`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const data = (await res.json()) as { code?: number; msg?: string; bot?: { app_name?: string } }
    if (data.code !== 0) return { ok: false, detail: `查询机器人信息失败（是否已开启机器人能力？）：${data.code ?? res.status} ${data.msg ?? ''}`.trim() }
    return { ok: true, ...(data.bot?.app_name ? { botName: data.bot.app_name } : {}), detail: '凭据有效' }
  } catch (e) {
    return { ok: false, detail: `请求飞书失败：${(e as Error).message}` }
  }
}

export async function sendFeishuTestMessage(input: { appId: string; appSecret: string; domain: 'feishu' | 'lark'; chatId: string; text: string }): Promise<{ ok: boolean; detail: string }> {
  try {
    const { token, detail } = await tenantToken(input)
    if (!token) return { ok: false, detail: `获取 tenant_access_token 失败：${detail}` }
    const res = await fetch(`${BASE[input.domain]}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ receive_id: input.chatId, msg_type: 'text', content: JSON.stringify({ text: input.text }) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = (await res.json()) as { code?: number; msg?: string }
    return data.code === 0 ? { ok: true, detail: '测试消息已发送' } : { ok: false, detail: `发送失败：${data.code ?? res.status} ${data.msg ?? ''}`.trim() }
  } catch (e) {
    return { ok: false, detail: `请求飞书失败：${(e as Error).message}` }
  }
}
