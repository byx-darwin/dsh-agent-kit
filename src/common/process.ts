import { spawn, spawnSync } from 'node:child_process'

/** 本包启动的子进程只继承这些环境变量。 */
export const BASE_ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'USER', 'LOGNAME'] as const

export function pickEnv(names: readonly string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

export interface RunProcessOptions {
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs: number
  killGraceMs: number
  signal?: AbortSignal
  /** stdout / stderr 各自保留的最大字节数。 */
  maxOutputBytes?: number
}

export interface RunProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

/**
 * 不经过 shell 启动子进程。超时或中止时先向进程组发 SIGTERM，
 * 宽限 `killGraceMs` 后发 SIGKILL；等到进程真正退出后才 resolve。
 */
export function runProcess(file: string, args: readonly string[], options: RunProcessOptions): Promise<RunProcessResult> {
  const maxOutput = options.maxOutputBytes ?? 1024 * 1024
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: true })
      return
    }
    const isScript = /\.(mjs|cjs|js)$/i.test(file)
    const spawnFile = isScript ? process.execPath : file
    const spawnArgs = isScript ? [file, ...args] : args
    const child = spawn(spawnFile, spawnArgs, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // 独立进程组，便于连同孙进程一起终止
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutSize = 0
    let stderrSize = 0
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutSize < maxOutput) stdout.push(chunk)
      stdoutSize += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSize < maxOutput) stderr.push(chunk)
      stderrSize += chunk.length
    })

    let timedOut = false
    let aborted = false
    let killTimer: NodeJS.Timeout | undefined
    const terminate = () => {
      if (killTimer || child.exitCode !== null || child.signalCode !== null) return
      killTree(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), options.killGraceMs)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs)
    const onAbort = () => {
      aborted = true
      terminate()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      clearTimeout(timeout)
      clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout)
      clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      // 父进程已退出，确保进程组中残留的孙进程也被回收
      if (timedOut || aborted) killTree(child.pid, 'SIGKILL')
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        aborted,
      })
    })
  })
}

export function killTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => void = (cmd, args) => void spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true }),
): void {
  if (pid === undefined) return
  if (platform === 'win32') {
    // Windows 没有进程组信号；/T 结束整个进程树，/F 强制。
    // 进程已退出时 taskkill 会以非零码退出，spawnSync 不会抛出，重复调用是安全的。
    run('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // 进程已退出
  }
}
