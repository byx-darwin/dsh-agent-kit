import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, parseDocument } from 'yaml'
import { resolveDshHome } from '../common/dsh-home.js'

/** dsh-credentials-local 使用的文件：$DSH_HOME/.credentials.yaml（version 1，refs 映射）。 */
export function credentialsFile(home = resolveDshHome()): string {
  return join(home, '.credentials.yaml')
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw e
  }
}

export async function readCredential(ref: string, file = credentialsFile()): Promise<string | undefined> {
  const doc = parseDocument(await readText(file))
  const refs = doc.get('refs')
  const value = isMap(refs) ? refs.get(ref) : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `restrictWindowsAcl` 实际执行子进程的方式，测试可替换以模拟 win32、断言调用参数。 */
export type AclRunner = (file: string, args: readonly string[]) => { status: number | null } | Promise<{ status: number | null }>

const defaultAclRunner: AclRunner = (file, args) => spawnSync(file, args, { shell: false, timeout: 5000, windowsHide: true })

export interface RestrictAclOptions {
  /** 默认 `process.env.USERNAME`（Windows 上的当前用户名环境变量）。 */
  username?: string
  runner?: AclRunner
  /** ACL 收紧失败时的回调（不影响写入结果，属于 best-effort）；不传则静默吞掉失败。 */
  onWarning?: (message: string) => void
}

/**
 * Windows 专用：写完凭据文件后收紧其 ACL，只保留当前用户的完全控制权限，去掉继承来的其他权限
 * （`icacls <file> /inheritance:r /grant:r <USERNAME>:F`）。不经过 shell（避免路径里的空格/特殊
 * 字符被 shell 解释），5 秒超时。这是 best-effort：文件本身已经写成功，ACL 收紧失败不应该让整个
 * 写入操作失败（调用方已经把敏感值写进文件，回滚没有意义，反而会丢失刚保存的凭据）——失败时只通过
 * `onWarning` 回调告知调用方，从不抛出。
 */
export async function restrictWindowsAcl(file: string, options: RestrictAclOptions = {}): Promise<boolean> {
  const username = options.username ?? process.env.USERNAME
  if (!username) {
    options.onWarning?.('cannot restrict ACL: USERNAME environment variable is not set')
    return false
  }
  const runner = options.runner ?? defaultAclRunner
  try {
    const result = await runner('icacls', [file, '/inheritance:r', '/grant:r', `${username}:F`])
    if (result.status !== 0) {
      options.onWarning?.(`icacls exited with code ${result.status}`)
      return false
    }
    return true
  } catch (e) {
    options.onWarning?.(`icacls failed: ${(e as Error).message}`)
    return false
  }
}

export interface WriteCredentialOptions {
  platform?: NodeJS.Platform
  aclRunner?: AclRunner
  onWarning?: (message: string) => void
  /** 测试用：覆盖 `restrictWindowsAcl` 里 `process.env.USERNAME` 的取值。 */
  username?: string
}

/**
 * value 为 undefined 时删除该项。与 dsh 使用同一把跨进程锁，并以 0600 原子写入。Windows 上
 * `mode: 0o600` 对 NTFS 无效（Node 在 win32 上忽略 POSIX 权限位），写完后额外用
 * {@link restrictWindowsAcl} 收紧 ACL（I3）。
 */
export async function writeCredential(ref: string, value: string | undefined, file = credentialsFile(), options: WriteCredentialOptions = {}): Promise<void> {
  await withFileLock(file, async () => {
    const text = await readText(file)
    const doc = parseDocument(text || 'version: 1\nrefs: {}\n')
    doc.set('version', 1)
    if (value === undefined) doc.deleteIn(['refs', ref])
    else doc.setIn(['refs', ref], value)
    await writeFileAtomic(file, doc.toString(), { mode: 0o600, dirMode: 0o700 })
  })
  if ((options.platform ?? process.platform) === 'win32') {
    await restrictWindowsAcl(file, { runner: options.aclRunner, onWarning: options.onWarning, username: options.username ?? process.env.USERNAME })
  }
}
