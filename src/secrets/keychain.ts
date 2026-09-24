import { spawn } from 'node:child_process'
import { BASE_ENV_WHITELIST, pickEnv, runProcess } from '../common/process.js'

export interface Keychain {
  read(service: string, account: string): Promise<string | undefined>
  write(service: string, account: string, value: string): Promise<void>
  remove(service: string, account: string): Promise<void>
}

const SECURITY = '/usr/bin/security'
const env = () => pickEnv(BASE_ENV_WHITELIST)

export const macosKeychain: Keychain = {
  async read(service, account) {
    const r = await runProcess(SECURITY, ['find-generic-password', '-a', account, '-s', service, '-w'], { env: env(), timeoutMs: 5000, killGraceMs: 500, maxOutputBytes: 64 * 1024 })
    if (r.exitCode !== 0) return undefined
    const key = r.stdout.replace(/[\r\n]+$/, '')
    return key.trim() ? key : undefined
  },
  // -w 作为最后一个参数且不带值时，security 从标准输入读取密码（提示两次），值不会出现在进程参数中
  write(service, account, value) {
    return new Promise((resolve, reject) => {
      const child = spawn(SECURITY, ['add-generic-password', '-a', account, '-s', service, '-U', '-w'], { env: env(), stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`security add-generic-password exited with ${code}: ${stderr.trim()}`))))
      child.stdin.end(`${value}\n${value}\n`)
    })
  },
  async remove(service, account) {
    await runProcess(SECURITY, ['delete-generic-password', '-a', account, '-s', service], { env: env(), timeoutMs: 5000, killGraceMs: 500 })
  },
}
