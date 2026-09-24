import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 假 dws 可执行脚本的绝对路径，可作为 dingtalk 的 `dwsPath`。 */
export const fakeDwsPath = fileURLToPath(new URL('../../fixtures/fake-dws.mjs', import.meta.url))

export type FakeDwsSendStep =
  | { mode: 'success' }
  | { mode: 'fail'; exitCode?: number; category?: string; message?: string }
  | { mode: 'hang' }
  | { mode: 'bad_output' }
  | { mode: 'partial'; failTargets?: string[] }

export interface FakeDwsScenario {
  auth?: 'ok' | 'expired' | 'error'
  /** `dws auth login --device` 的结果；approve 后 auth 变为 ok。 */
  login?: 'approve' | 'deny' | 'hang' | 'no_link'
  loginDelayMs?: number
  /** 按调用次序取，超出时重复最后一个。 */
  send?: FakeDwsSendStep[]
}

export interface FakeDwsCall {
  args: string[]
  /** 子进程收到的环境变量名（用于断言白名单）。 */
  env: string[]
}

/**
 * 为假 dws 准备一个场景目录。假 dws 从 `$DWS_CONFIG_DIR` 读取场景，
 * 因此返回的 `env` 需要设置到 `process.env`（DWS_CONFIG_DIR 在白名单中）。
 */
export function createFakeDws(scenario: FakeDwsScenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-'))
  const write = (s: FakeDwsScenario) => writeFileSync(join(dir, 'fake-dws.json'), JSON.stringify(s))
  write(scenario)
  return {
    path: fakeDwsPath,
    dir,
    env: { DWS_CONFIG_DIR: dir },
    setScenario: (s: FakeDwsScenario) => {
      write(s)
      rmSync(join(dir, 'send-count'), { force: true })
      rmSync(join(dir, 'auth-state.json'), { force: true })
    },
    calls(): FakeDwsCall[] {
      const file = join(dir, 'calls.jsonl')
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeDwsCall)
    },
    hangPids(): { pid: number; grandchild: number } | undefined {
      try {
        return JSON.parse(readFileSync(join(dir, 'hang-pids.json'), 'utf8'))
      } catch {
        return undefined
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
