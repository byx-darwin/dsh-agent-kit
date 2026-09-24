import { parseArgs } from 'node:util'
import { createCheckContext, runChecks, type CheckContext } from '../checks/index.js'
import { listProfiles, locateProfile, resolveDshHome, type ProfileInfo } from '../profile/index.js'
import { formatReport } from './doctor.js'
import { USAGE } from './messages.js'

export interface CliIO {
  out(text: string): void
  err(text: string): void
  env: NodeJS.ProcessEnv
}
export interface CliDeps {
  home?: string
  checkOverrides?: Partial<CheckContext>
  prompter?: unknown
}

const defaultIO: CliIO = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t), env: process.env }

class UsageError extends Error {}

export async function pickProfile(home: string, requested: string | undefined, prompter?: unknown): Promise<ProfileInfo> {
  if (requested) return locateProfile(requested, home)
  const withKit: ProfileInfo[] = []
  for (const name of await listProfiles(home)) {
    const p = await locateProfile(name, home).catch(() => undefined)
    if (p?.hasKit) withKit.push(p)
  }
  if (withKit.length === 1) return withKit[0]!
  if (withKit.length === 0) throw new UsageError(`在 ${home} 中没有安装 @mc/dsh-agent-kit 的 Profile；请用 --profile 指定，或先运行 dsh plugin --profile <名字> add @mc/dsh-agent-kit\n`)
  if (prompter) {
    // Task 7 将实现真正的交互式选择；这里先保留占位以便类型兼容。
  }
  throw new UsageError(`有多个 Profile 安装了本包，请用 --profile 指定：${withKit.map((p) => p.name).join(', ')}\n`)
}

export async function main(argv: string[], io: CliIO = defaultIO, deps: CliDeps = {}): Promise<number> {
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE)
    return 0
  }
  try {
    const { values } = parseArgs({ args: rest, options: { profile: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: false })
    const home = deps.home ?? resolveDshHome(io.env)
    if (command === 'doctor') {
      const profile = await pickProfile(home, values.profile, deps.prompter)
      const report = await runChecks(await createCheckContext(profile, deps.checkOverrides))
      io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
      return report.ok ? 0 : 1
    }
    if (command === 'setup') {
      const { runSetup } = await import('./setup.js')
      return await runSetup()
    }
    throw new UsageError(USAGE)
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(e instanceof UsageError ? e.message : `${(e as Error).message}\n${USAGE}`)
      return 2
    }
    io.err(`错误：${(e as Error).message}\n`)
    return 1
  }
}
