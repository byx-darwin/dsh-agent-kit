import { spawn } from 'node:child_process'
import { diffLines } from 'diff'
import { createCheckContext, runChecks } from '../checks/index.js'
import { previewKitEntries, readKitEntries, writeKitEntries, type KitChanges, type KitId } from '../profile/index.js'
import { SHARED_KEYCHAIN_SERVICE, defaultKeyTarget, describeTypesafeKey, saveTypesafeKey, type KeyStoreOptions, type KeyTarget } from '../secrets/index.js'
import { buildSendArgs } from '../dingtalk/args.js'
import type { CheckContext } from '../checks/index.js'
import { formatReport } from './doctor.js'
import * as msg from './messages.js'
import type { CliDeps, CliIO } from './main.js'
import { pickProfile } from './main.js'
import { inquirerPrompter, type Prompter } from './prompter.js'

type Config = Record<string, unknown>

export interface SetupDeps extends CliDeps {
  prompter?: Prompter
  runDws?: (args: string[]) => Promise<number>
  keyStore?: KeyStoreOptions
}

const nonEmpty = (v: string) => (v.trim() ? true : msg.NOT_EMPTY)

/** 逐行渲染 before/after 差异：未变化行前缀两个空格，新增前缀 `+ `，删除前缀 `- `。 */
function renderDiff(before: string, after: string): string {
  const lines: string[] = []
  for (const part of diffLines(before, after)) {
    const prefix = part.added ? '+ ' : part.removed ? '- ' : '  '
    const partLines = part.value.split('\n')
    if (partLines[partLines.length - 1] === '') partLines.pop()
    for (const l of partLines) lines.push(prefix + l)
  }
  return lines.join('\n')
}

/** 不经过 shell，交互式继承 stdio 运行 dws（用于 `dws auth login`）。脚本入口用 process.execPath 启动。 */
function runDwsInherit(dwsPath: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const isScript = /\.(mjs|cjs|js)$/i.test(dwsPath)
    const file = isScript ? process.execPath : dwsPath
    const spawnArgs = isScript ? [dwsPath, ...args] : args
    const child = spawn(file, spawnArgs, { stdio: 'inherit', shell: false })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/** 按群名搜索当前用户加入的群。dws 输出的条目字段按常见命名宽松读取。 */
export async function searchGroups(exec: CheckContext['exec'], dws: string, query: string): Promise<{ id: string; name: string }[]> {
  const r = await exec(dws, ['chat', '+chat-search', `--query=${query}`, '--limit=20', '--format=json'])
  if (r.exitCode !== 0) return []
  try {
    const data = JSON.parse(r.stdout) as { chats?: Array<Record<string, unknown>> }
    return (data.chats ?? [])
      .map((c) => ({
        id: String(c.openConversationId ?? c.conversationId ?? c.chatId ?? ''),
        name: String(c.title ?? c.name ?? c.chatName ?? ''),
      }))
      .filter((g) => g.id)
  } catch {
    return []
  }
}

/** 以配置的身份给当前 dws 登录用户发一条单聊测试消息（webhook 身份不支持）。 */
export async function sendSelfTestMessage(exec: CheckContext['exec'], dws: string, config: { identity: string; robotCode?: string }): Promise<{ ok: boolean; detail: string }> {
  if (config.identity === 'webhook') return { ok: false, detail: msg.DINGTALK_WEBHOOK_UNSUPPORTED_SELF_TEST }
  const auth = await exec(dws, ['auth', 'status', '--format=json'])
  const userId = (() => {
    try {
      return (JSON.parse(auth.stdout) as { user_id?: string }).user_id
    } catch {
      return undefined
    }
  })()
  if (!userId) return { ok: false, detail: msg.DINGTALK_CANNOT_RESOLVE_CURRENT_USER }
  const { args } = buildSendArgs({
    identity: config.identity as 'user' | 'bot',
    robotCode: config.robotCode,
    target: { userId },
    title: 'dsh-agent-kit',
    markdown: msg.dingtalkTestMarkdown(),
    dryRun: false,
  })
  const r = await exec(dws, args)
  return r.exitCode === 0 ? { ok: true, detail: msg.DINGTALK_TEST_MESSAGE_SENT } : { ok: false, detail: msg.dingtalkTestMessageFailed(r.stderr.trim() || String(r.exitCode)) }
}

async function configureDingtalk(p: Prompter, current: Config, deps: SetupDeps, io: CliIO, loggedIn: boolean, exec: CheckContext['exec'], dws: string | undefined): Promise<Config> {
  const identity = await p.select(msg.DINGTALK_IDENTITY_MESSAGE, msg.DINGTALK_IDENTITY_CHOICES, (current.identity as 'bot' | 'user' | 'webhook') ?? 'bot')
  const config: Config = { identity }
  if (identity === 'bot') config.robotCode = await p.input(msg.DINGTALK_ROBOT_CODE_MESSAGE, current.robotCode as string, nonEmpty)
  if (identity === 'webhook') config.webhookTokenEnv = await p.input(msg.DINGTALK_WEBHOOK_TOKEN_ENV_MESSAGE, (current.webhookTokenEnv as string) ?? msg.DINGTALK_WEBHOOK_TOKEN_ENV_DEFAULT, nonEmpty)
  if (identity !== 'webhook') {
    const kind = await p.select(msg.DINGTALK_DEFAULT_TARGET_MESSAGE, msg.DINGTALK_DEFAULT_TARGET_CHOICES)
    if (kind === 'search') {
      const query = await p.input(msg.DINGTALK_GROUP_QUERY_MESSAGE, undefined, nonEmpty)
      const groups = dws ? await searchGroups(exec, dws, query) : []
      if (groups.length === 0) {
        io.out(msg.DINGTALK_NO_GROUP_FOUND)
        config.defaultTarget = { chatId: await p.input(msg.DINGTALK_CHAT_ID_MESSAGE, undefined, nonEmpty) }
      } else {
        config.defaultTarget = { chatId: await p.select(msg.DINGTALK_SELECT_GROUP_MESSAGE, groups.map((g) => ({ value: g.id, name: `${g.name}（${g.id}）` }))) }
      }
    } else if (kind !== 'none') {
      config.defaultTarget = { [kind]: await p.input(kind === 'chatId' ? msg.DINGTALK_CHAT_ID_MESSAGE : msg.DINGTALK_USER_ID_MESSAGE, undefined, nonEmpty) }
    }
  }
  config.dryRun = await p.confirm(msg.DINGTALK_DRY_RUN_MESSAGE, (current.dryRun as boolean) ?? false)
  if (identity === 'user' && !loggedIn && (await p.confirm(msg.DINGTALK_LOGIN_CONFIRM_MESSAGE, true))) {
    const runDws = deps.runDws ?? (dws ? (args: string[]) => runDwsInherit(dws, args) : async () => 1)
    const code = await runDws(['auth', 'login'])
    if (code !== 0) io.err(msg.DINGTALK_LOGIN_FAILED)
  }
  return config
}

async function configureAgentTasks(p: Prompter, current: Config): Promise<Config> {
  const workspaceDir = await p.input(msg.AGENT_TASKS_WORKSPACE_DIR_MESSAGE, current.workspaceDir as string, (v) => (/^([a-zA-Z]:[\\/]|\/)/.test(v) ? true : msg.NOT_ABSOLUTE_PATH))
  const declared: Record<string, string> = { ...((current.declaredPermissions as Record<string, string>) ?? {}) }
  for (const provider of ['claude-code', 'codex']) {
    const level = await p.select(msg.agentTasksPermissionMessage(provider), msg.AGENT_TASKS_PERMISSION_CHOICES, (declared[provider] as 'read-only' | 'workspace-write') ?? 'read-only')
    if (level === 'none') delete declared[provider]
    else declared[provider] = level
  }
  return { ...current, workspaceDir, declaredPermissions: declared }
}

async function configureJev(p: Prompter, current: Config, keyStore: KeyStoreOptions, io: CliIO): Promise<Config> {
  const model = await p.input(msg.JEV_MODEL_MESSAGE, (current.model as string) ?? msg.JEV_MODEL_DEFAULT, nonEmpty)
  const config: Config = { ...current, model }
  const platform = keyStore.platform ?? process.platform
  if (platform === 'darwin') config.keychainService = [SHARED_KEYCHAIN_SERVICE, 'gitflow-cli-typesafe']
  const existing = await describeTypesafeKey({ ...keyStore, keychainService: config.keychainService as string[] | undefined })
  if (existing.configured && (await p.confirm(msg.jevKeyFoundMessage(existing.source!), true))) return config
  const key = await p.password(msg.JEV_KEY_PASSWORD_MESSAGE)
  const targets: { value: KeyTarget; name: string }[] = platform === 'darwin'
    ? msg.jevKeyTargetChoices(SHARED_KEYCHAIN_SERVICE)
    : [msg.JEV_KEY_TARGET_CHOICE_CREDENTIALS_ONLY]
  const target = await p.select(msg.JEV_KEY_TARGET_MESSAGE, targets, defaultKeyTarget(platform))
  await saveTypesafeKey(target, key, { ...keyStore, keychainService: SHARED_KEYCHAIN_SERVICE })
  io.out(msg.jevKeySavedMessage(target))
  return config
}

export async function runSetup(opts: { home: string; profileName?: string; io: CliIO; deps: SetupDeps }): Promise<number> {
  const { io, deps } = opts
  const p = deps.prompter ?? inquirerPrompter
  const keyStore = deps.keyStore ?? {}
  const profile = await pickProfile(opts.home, opts.profileName, p)
  if (!profile.hasKit) {
    io.err(msg.profileMissingKit(profile.name))
    return 1
  }
  const snap = await readKitEntries(profile.patchFile)
  const ctx = await createCheckContext(profile, deps.checkOverrides)
  const loggedIn = (await runChecks({ ...ctx, snapshot: { ...snap, entries: { ...snap.entries, 'agent-kit-dingtalk': { enabled: true, config: { identity: 'user' } } } } }))
    .results.some((r) => r.id === 'agent-kit-dingtalk.login' && r.status === 'pass')

  const dws = ctx.findExecutable('dws')
  const ids: KitId[] = ['agent-kit-ws', 'agent-kit-dingtalk', 'agent-kit-agent-tasks', 'agent-kit-jev']
  const enabled = await p.checkbox(msg.SELECT_SERVICES_MESSAGE, ids.map((id) => ({ value: id, name: msg.KIT_TITLES[id]!, checked: snap.entries[id].enabled })))

  const changes: KitChanges = {}
  for (const id of ids) {
    const current = (snap.entries[id].config ?? {}) as Config
    if (!enabled.includes(id)) {
      if (snap.entries[id].enabled) changes[id] = { enabled: false }
      continue
    }
    const config =
      id === 'agent-kit-dingtalk' ? await configureDingtalk(p, current, deps, io, loggedIn, ctx.exec, dws)
      : id === 'agent-kit-agent-tasks' ? await configureAgentTasks(p, current)
      : id === 'agent-kit-jev' ? await configureJev(p, current, keyStore, io)
      : current
    changes[id] = { enabled: true, config }
  }

  const { before, after } = await previewKitEntries(profile.patchFile, changes)
  io.out(`\n${renderDiff(before, after)}\n`)
  if (!(await p.confirm(msg.WRITE_CONFIRM_MESSAGE, true))) {
    io.out(msg.WRITE_CANCELLED)
    return 1
  }
  await writeKitEntries(profile.patchFile, changes, snap.version)
  io.out(profile.patchReload === 'live' ? msg.WRITE_DONE_LIVE : msg.WRITE_DONE_RESTART)
  const dingtalk = changes['agent-kit-dingtalk']
  if (dingtalk?.enabled && dws && (await p.confirm(msg.SEND_TEST_MESSAGE_CONFIRM, false))) {
    const r = await sendSelfTestMessage(ctx.exec, dws, dingtalk.config as { identity: string; robotCode?: string })
    io.out(`${r.detail}\n`)
  }
  const report = await runChecks(await createCheckContext(profile, deps.checkOverrides))
  io.out(formatReport(report))
  return report.ok ? 0 : 1
}
