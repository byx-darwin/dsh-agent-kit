import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 假 lark-cli 可执行脚本的绝对路径，可作为 feishu 的 `larkPath`。 */
export const fakeLarkPath = fileURLToPath(new URL('../../fixtures/fake-lark-cli.mjs', import.meta.url))

export type FakeLarkSendStep =
  | { mode: 'success'; failTargets?: never }
  | { mode: 'fail'; type?: string; subtype?: string; message?: string; exitCode?: number; failTargets?: string[] }
  | { mode: 'hang' }
  | { mode: 'bad_output' }

export interface FakeLarkScenario {
  /** 各身份是否可用；`not_configured` 模拟未运行过 `lark-cli config init`。 */
  auth?: { bot?: boolean; user?: boolean } | 'not_configured'
  user?: { openId?: string; userName?: string }
  /** `im +chat-search` 的数据源，按名称子串匹配。 */
  chats?: { chat_id: string; name: string }[]
  /** 按调用次序取，超出时重复最后一个。 */
  send?: FakeLarkSendStep[]
}

export interface FakeLarkCall {
  args: string[]
  /** 子进程收到的环境变量名（用于断言白名单）。 */
  env: string[]
}

/**
 * 为假 lark-cli 准备一个场景目录。假 lark-cli 从 `$LARKSUITE_CLI_CONFIG_DIR` 读取场景，
 * 因此返回的 `env` 需要设置到 `process.env`（该变量在白名单中）。
 */
export function createFakeLark(scenario: FakeLarkScenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-lark-'))
  const write = (s: FakeLarkScenario) => writeFileSync(join(dir, 'fake-lark.json'), JSON.stringify(s))
  write(scenario)
  return {
    path: fakeLarkPath,
    dir,
    env: { LARKSUITE_CLI_CONFIG_DIR: dir },
    setScenario: (s: FakeLarkScenario) => {
      write(s)
      rmSync(join(dir, 'send-count'), { force: true })
    },
    calls(): FakeLarkCall[] {
      const file = join(dir, 'calls.jsonl')
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeLarkCall)
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
