import { parseArgs } from 'node:util'
import { collectEntries } from '../admin/registry.js'
import { createCheckContext, runChecks, type CheckContext } from '../checks/index.js'
import { listProfiles, locateProfile, resolveDshHome, type ProfileInfo } from '../profile/index.js'
import type { KeyStoreOptions } from '@mc/dsh-agent-kit/secrets'
import { formatReport } from './doctor.js'
import { USAGE, errorMessage, multipleProfiles, noProfile, unknownOption, SELECT_PROFILE_MESSAGE } from './messages.js'
import type { Prompter } from './prompter.js'

export interface CliIO {
  out(text: string): void
  err(text: string): void
  env: NodeJS.ProcessEnv
}
export interface CliDeps {
  home?: string
  checkOverrides?: Partial<CheckContext>
  prompter?: Prompter
  runDws?: (args: string[]) => Promise<number>
  keyStore?: KeyStoreOptions
}

const defaultIO: CliIO = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t), env: process.env }

class UsageError extends Error {}

export async function pickProfile(home: string, requested: string | undefined, prompter?: Prompter): Promise<ProfileInfo> {
  if (requested) return locateProfile(requested, home)
  const withKit: ProfileInfo[] = []
  for (const name of await listProfiles(home)) {
    const p = await locateProfile(name, home).catch(() => undefined)
    if (p?.hasKit) withKit.push(p)
  }
  if (withKit.length === 1) return withKit[0]!
  if (withKit.length === 0) throw new UsageError(noProfile(home))
  if (prompter) {
    const name = await prompter.select(SELECT_PROFILE_MESSAGE, withKit.map((p) => ({ value: p.name, name: p.name })))
    return withKit.find((p) => p.name === name)!
  }
  throw new UsageError(multipleProfiles(withKit.map((p) => p.name)))
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
      const profile = await pickProfile(home, values.profile)
      // 业务包通过静态清单登记的行（issue #1）；doctor 不加载插件，只能从清单发现
      const report = await runChecks(await createCheckContext(profile, deps.checkOverrides), await collectEntries(profile, []))
      io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
      return report.ok ? 0 : 1
    }
    if (command === 'setup') {
      const { runSetup } = await import('./setup.js')
      return await runSetup({ home, profileName: values.profile, io, deps })
    }
    throw new UsageError(USAGE)
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(e instanceof UsageError ? e.message : unknownOption((e as Error).message))
      return 2
    }
    io.err(errorMessage((e as Error).message))
    return 1
  }
}
