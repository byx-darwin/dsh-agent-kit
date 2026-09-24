import { spawn, type ChildProcess } from 'node:child_process'
import { redact, runProcess } from '@mc/dsh-agent-kit'

/**
 * 设置页里钉钉的登录状态与登录 / 退出（dws auth）。登录用设备码流程（`dws auth login --device`）：页面
 * 显示验证码与授权链接，授权在任意设备的浏览器里完成，dws 进程在后台轮询；已有有效钉钉会话时通常几秒内
 * 自动完成。退出只针对当前账号（`--profile corpId:userId`），不用 dws 默认的「退出全部账号」。
 */
export interface DingtalkAuthStatus {
  /** 找不到 dws 时为 false，其余字段缺省。 */
  installed: boolean
  authenticated: boolean
  user?: string
  corp?: string
  /** access token 到期时间（ISO）。 */
  expiresAt?: string
  /** refresh token 到期时间（ISO）：此前 dws 会自动续期。 */
  refreshExpiresAt?: string
  /** 查询失败时的原因（已脱敏）。 */
  error?: string
  login?: DingtalkLoginState
}

export interface DingtalkLoginState {
  state: 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  code?: string
  /** 含验证码的授权链接。 */
  url?: string
  /** 需手动输入验证码的授权链接。 */
  manualUrl?: string
  /** 验证码过期时间（ISO）。 */
  expiresAt?: string
  message?: string
}

interface RawStatus {
  authenticated?: boolean
  token_valid?: boolean
  refresh_token_valid?: boolean
  expires_at?: string
  refresh_expires_at?: string
  user_name?: string
  corp_name?: string
  user_id?: string
  corp_id?: string
}

/** `dws auth status --format=json` 的输出；只要 access 或 refresh token 之一有效就算已登录（dws 会自动续期）。 */
export function parseAuthStatus(stdout: string, exitCode: number | null): Omit<DingtalkAuthStatus, 'installed' | 'login'> & { account?: string } {
  let raw: RawStatus
  try {
    raw = JSON.parse(stdout) as RawStatus
  } catch {
    return { authenticated: false }
  }
  const authenticated = exitCode === 0 && raw.authenticated === true && (raw.token_valid === true || raw.refresh_token_valid === true)
  return {
    authenticated,
    ...(raw.user_name ? { user: raw.user_name } : {}),
    ...(raw.corp_name ? { corp: raw.corp_name } : {}),
    ...(raw.expires_at ? { expiresAt: raw.expires_at } : {}),
    ...(raw.refresh_expires_at ? { refreshExpiresAt: raw.refresh_expires_at } : {}),
    ...(raw.corp_id && raw.user_id ? { account: `${raw.corp_id}:${raw.user_id}` } : {}),
  }
}

/**
 * 从 `dws auth login --device` 的文本输出里取验证码与链接（dws v1.0.62 的格式）：
 *
 * ```
 *   authorization code: ABCD-EFGH
 *   Authorization code will expire in 900 seconds.
 *   Authorization link (code included):
 * https://login.dingtalk.com/oauth2/device/verify.htm?...&user_code=ABCD-EFGH
 *   Link for entering the code manually:
 * https://login.dingtalk.com/oauth2/device/verify.htm?...
 * ```
 */
export function parseDeviceLogin(text: string): { code?: string; url?: string; manualUrl?: string; expiresInSec?: number } {
  const code = /authorization code:\s*([A-Z0-9-]{4,})/i.exec(text)?.[1]
  const expires = /expire in (\d+) seconds/i.exec(text)?.[1]
  const urlAfter = (label: RegExp) => {
    const m = label.exec(text)
    if (!m) return undefined
    return /https:\/\/\S+/.exec(text.slice(m.index + m[0].length))?.[0]
  }
  const url = urlAfter(/Authorization link \(code included\):/i)
  const manualUrl = urlAfter(/Link for entering the code manually:/i)
  return {
    ...(code ? { code } : {}),
    ...(url ? { url } : {}),
    ...(manualUrl ? { manualUrl } : {}),
    ...(expires ? { expiresInSec: Number(expires) } : {}),
  }
}

const STATUS_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 15 * 60_000
const LOGIN_START_TIMEOUT_MS = 30_000

export async function readAuthStatus(dwsPath: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<Omit<DingtalkAuthStatus, 'login'> & { account?: string }> {
  if (!dwsPath) return { installed: false, authenticated: false }
  try {
    const r = await runProcess(dwsPath, ['auth', 'status', '--format=json'], { env, timeoutMs: STATUS_TIMEOUT_MS, killGraceMs: 2000 })
    return { installed: true, ...parseAuthStatus(r.stdout, r.exitCode) }
  } catch (e) {
    return { installed: true, authenticated: false, error: redact((e as Error).message) }
  }
}

export async function logout(dwsPath: string, account: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = ['auth', 'logout', ...(account ? ['--profile', account] : []), '--yes']
  const r = await runProcess(dwsPath, args, { env, timeoutMs: STATUS_TIMEOUT_MS, killGraceMs: 2000 })
  if (r.exitCode !== 0) throw new Error(redact(r.stderr.trim() || r.stdout.trim() || `dws auth logout exited with ${r.exitCode}`))
}

/** 同一时刻最多一个设备码登录；新的登录会取消旧的。 */
export class DeviceLogin {
  private child?: ChildProcess
  private current?: DingtalkLoginState

  get state(): DingtalkLoginState | undefined {
    return this.current
  }

  /** 启动登录，拿到验证码与链接（或进程提前结束）后返回。 */
  start(dwsPath: string, env: NodeJS.ProcessEnv = process.env): Promise<DingtalkLoginState> {
    this.cancel()
    const isScript = /\.(mjs|cjs|js)$/i.test(dwsPath)
    const child = spawn(isScript ? process.execPath : dwsPath, [...(isScript ? [dwsPath] : []), 'auth', 'login', '--device', '--format', 'json'], {
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    const state: DingtalkLoginState = { state: 'waiting' }
    this.current = state
    let output = ''
    return new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(startTimer)
        resolve({ ...state })
      }
      const startTimer = setTimeout(() => {
        state.state = 'failed'
        state.message = 'dws 未在 30 秒内给出验证码'
        this.kill(child)
        settle()
      }, LOGIN_START_TIMEOUT_MS)
      const lifeTimer = setTimeout(() => {
        if (state.state !== 'waiting') return
        state.state = 'failed'
        state.message = '验证码已过期'
        this.kill(child)
      }, LOGIN_TIMEOUT_MS)
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-64 * 1024)
        if (state.code) return
        const parsed = parseDeviceLogin(output)
        if (parsed.code && parsed.url) {
          state.code = parsed.code
          state.url = parsed.url
          if (parsed.manualUrl) state.manualUrl = parsed.manualUrl
          if (parsed.expiresInSec) state.expiresAt = new Date(Date.now() + parsed.expiresInSec * 1000).toISOString()
          settle()
        }
      }
      child.stdout!.on('data', onData)
      child.stderr!.on('data', onData)
      child.on('error', (e) => {
        state.state = 'failed'
        state.message = redact(e.message)
        settle()
      })
      child.on('close', (code) => {
        clearTimeout(lifeTimer)
        if (this.child === child) this.child = undefined
        if (state.state === 'waiting') {
          const ok = code === 0 && /"success":\s*true/.test(output)
          state.state = ok ? 'succeeded' : 'failed'
          if (!ok) state.message = redact(output.trim().split('\n').slice(-3).join(' ').slice(0, 300)) || `dws 退出码 ${code}`
        }
        settle()
      })
    })
  }

  cancel(): void {
    if (this.child) this.kill(this.child)
    if (this.current?.state === 'waiting') {
      this.current.state = 'cancelled'
    }
  }

  private kill(child: ChildProcess): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM')
      else child.kill('SIGTERM')
    } catch {
      // 进程已退出
    }
  }
}
