import { afterEach, describe, expect, it } from 'vitest'
import { DeviceLogin, logout, parseAuthStatus, parseDeviceLogin, readAuthStatus } from '../../src/admin/dingtalk-auth.js'
import { createFakeDws } from '@mc/dsh-agent-kit/testing'

// dws v1.0.62 `auth login --device` 的真实输出（链接中的一次性参数已替换）
const DEVICE_OUTPUT = `● Step 1: Requesting device authorization code...

  authorization code: CNXH-VNPT
  Authorization code will expire in 900 seconds.

  Authorization link (code included):
https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=xyz&user_code=CNXH-VNPT

  Link for entering the code manually:
https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=xyz

● Step 2: Waiting for user authorization...
  (polling every 5 seconds)
`

describe('parseDeviceLogin', () => {
  it('extracts the code, both links and the expiry', () => {
    expect(parseDeviceLogin(DEVICE_OUTPUT)).toEqual({
      code: 'CNXH-VNPT',
      url: 'https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=xyz&user_code=CNXH-VNPT',
      manualUrl: 'https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&callerUmt=xyz',
      expiresInSec: 900,
    })
  })

  it('returns nothing before the links are printed', () => {
    expect(parseDeviceLogin('● Step 1: Requesting device authorization code...\n\n  authorization code: CNXH-VNPT\n')).toEqual({ code: 'CNXH-VNPT' })
  })
})

describe('parseAuthStatus', () => {
  it('treats a valid refresh token as signed in and keeps the account for logout', () => {
    const out = JSON.stringify({ authenticated: true, token_valid: false, refresh_token_valid: true, user_name: '张三', corp_name: '示例公司', corp_id: 'c1', user_id: 'u1', expires_at: 'a', refresh_expires_at: 'b' })
    expect(parseAuthStatus(out, 0)).toEqual({ authenticated: true, user: '张三', corp: '示例公司', expiresAt: 'a', refreshExpiresAt: 'b', account: 'c1:u1' })
  })

  it('is signed out on a non-zero exit, expired tokens or bad output', () => {
    expect(parseAuthStatus(JSON.stringify({ authenticated: true, token_valid: true }), 2).authenticated).toBe(false)
    expect(parseAuthStatus(JSON.stringify({ authenticated: true, token_valid: false, refresh_token_valid: false }), 0).authenticated).toBe(false)
    expect(parseAuthStatus('not json', 0)).toEqual({ authenticated: false })
  })
})

describe('dws auth against the fake dws', () => {
  let dws: ReturnType<typeof createFakeDws>
  const login = new DeviceLogin()
  afterEach(() => {
    login.cancel()
    dws?.cleanup()
  })
  const env = () => ({ ...process.env, ...dws.env })

  it('reports not installed without a dws path', async () => {
    expect(await readAuthStatus(undefined)).toEqual({ installed: false, authenticated: false })
  })

  it('reads the signed-in account', async () => {
    dws = createFakeDws({ auth: 'ok' })
    expect(await readAuthStatus(dws.path, env())).toMatchObject({ installed: true, authenticated: true, user: '张三', corp: '示例公司', account: 'dingcorp:u1' })
  })

  it('returns the code and link, then succeeds in the background', async () => {
    dws = createFakeDws({ login: 'success', loginDelayMs: 150 })
    const started = await login.start(dws.path, env())
    expect(started).toMatchObject({ state: 'waiting', code: 'FAKE-CODE', url: expect.stringContaining('user_code=FAKE-CODE') })
    await expect.poll(() => login.state?.state, { timeout: 3000 }).toBe('succeeded')
    expect(dws.calls().at(-1)!.args).toEqual(['auth', 'login', '--device', '--format', 'json'])
  })

  it('reports a failed authorization', async () => {
    dws = createFakeDws({ login: 'fail', loginDelayMs: 50 })
    await login.start(dws.path, env())
    await expect.poll(() => login.state?.state, { timeout: 3000 }).toBe('failed')
    expect(login.state?.message).toContain('authorization denied')
  })

  it('cancels a pending login and stops the dws process', async () => {
    dws = createFakeDws({ login: 'hang' })
    await login.start(dws.path, env())
    login.cancel()
    expect(login.state?.state).toBe('cancelled')
  })

  it('signs out only the given account', async () => {
    dws = createFakeDws()
    await logout(dws.path, 'dingcorp:u1', env())
    expect(dws.calls().at(-1)!.args).toEqual(['auth', 'logout', '--profile', 'dingcorp:u1', '--yes'])
  })
})
