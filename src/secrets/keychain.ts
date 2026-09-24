import { spawn } from 'node:child_process'
import { BASE_ENV_WHITELIST, pickEnv, runProcess } from '../common/process.js'

export interface Keychain {
  read(service: string, account: string): Promise<string | undefined>
  write(service: string, account: string, value: string): Promise<void>
  remove(service: string, account: string): Promise<void>
}

const SECURITY = '/usr/bin/security'
const env = () => pickEnv(BASE_ENV_WHITELIST)

/**
 * 构造一个 macOS 钥匙串适配器；`securityPath` 与 `writeTimeoutMs` 仅用于测试注入
 * （例如指向一个模拟慢速/挂起的可执行文件，验证 write 超时会被杀死并拒绝）。
 */
export function createMacosKeychain(securityPath: string = SECURITY, writeTimeoutMs = 5000): Keychain {
  return {
    async read(service, account) {
      const r = await runProcess(securityPath, ['find-generic-password', '-a', account, '-s', service, '-w'], { env: env(), timeoutMs: 5000, killGraceMs: 500, maxOutputBytes: 64 * 1024 })
      if (r.exitCode !== 0) return undefined
      const key = r.stdout.replace(/[\r\n]+$/, '')
      return key.trim() ? key : undefined
    },
    // -w 作为最后一个参数且不带值时，security 从标准输入读取密码（提示两次），值不会出现在进程参数中
    write(service, account, value) {
      return new Promise((resolve, reject) => {
        const child = spawn(securityPath, ['add-generic-password', '-a', account, '-s', service, '-U', '-w'], { env: env(), stdio: ['pipe', 'ignore', 'pipe'] })
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
          }, 500)
          reject(new Error(`security add-generic-password timed out after ${writeTimeoutMs}ms`))
        }, writeTimeoutMs)
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          code === 0 ? resolve() : reject(new Error(`security add-generic-password exited with ${code}: ${stderr.trim()}`))
        })
        child.stdin.end(`${value}\n${value}\n`)
      })
    },
    async remove(service, account) {
      await runProcess(securityPath, ['delete-generic-password', '-a', account, '-s', service], { env: env(), timeoutMs: 5000, killGraceMs: 500 })
    },
  }
}

export const macosKeychain: Keychain = createMacosKeychain()
