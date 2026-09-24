import { spawn } from 'node:child_process'
import { diffLines } from 'diff'
import { createCheckContext, runChecks } from '../checks/index.js'
import { previewKitEntries, readKitEntries, writeKitEntries, type KitChanges, type KitId } from '../profile/index.js'
import { SHARED_KEYCHAIN_SERVICE, defaultKeyTarget, describeTypesafeKey, saveTypesafeKey, type KeyStoreOptions, type KeyTarget } from '@mc/dsh-agent-kit/secrets'
import { CHANNEL_CLIS, installArgs, installCommand, type ChannelCliId } from '../clis.js'
import { buildSendArgs } from '@mc/dsh-agent-kit/dingtalk'
import { buildFeishuArgs } from '@mc/dsh-agent-kit/feishu'
import { identityAvailable } from '@mc/dsh-agent-kit/feishu'
import { NOTIFY_CHANNELS, type NotifyChannel } from '@mc/dsh-agent-kit/notify'
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
  /** 交互式运行 lark-cli（`config init` / `auth login`），测试可替换。 */
  runLark?: (args: string[]) => Promise<number>
  /** 运行 `npm i -g <包>@<版本>`，测试可替换。 */
  runInstall?: (args: string[]) => Promise<number>
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

/**
 * 交互式运行 `npm i -g`。参数全部来自 {@link CHANNEL_CLIS} 的常量，不含用户输入；Windows 上 npm 是
 * `npm.cmd`，Node 不经过 shell 无法启动批处理，所以只在 win32 上借助 shell。
 */
function runNpmInherit(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    const child = spawn(win ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', shell: win })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/**
 * 检查已启用渠道需要的 CLI，缺哪个就列出哪个：多选（默认全选，可以只装一个），整体确认一次后
 * 依次安装。版本锁定到本包验证过的版本。安装失败或跳过都不影响后续配置，只提示手动命令。
 */
async function installMissingClis(p: Prompter, io: CliIO, deps: SetupDeps, find: (bin: string) => string | undefined, needed: ChannelCliId[]): Promise<void> {
  const missing = needed.filter((id) => !find(CHANNEL_CLIS[id].bin))
  if (missing.length === 0) return
  const picked = await p.checkbox(
    msg.INSTALL_CLIS_MESSAGE,
    missing.map((id) => ({ value: id, name: msg.installCliChoice(CHANNEL_CLIS[id].title, CHANNEL_CLIS[id].package, CHANNEL_CLIS[id].version), checked: true })),
  )
  const skipped = missing.filter((id) => !picked.includes(id))
  if (picked.length > 0) {
    if (await p.confirm(msg.installConfirmMessage(picked.map((id) => installCommand(CHANNEL_CLIS[id]))), true)) {
      const run = deps.runInstall ?? runNpmInherit
      for (const id of picked) {
        const cli = CHANNEL_CLIS[id]
        if ((await run(installArgs(cli))) !== 0) io.err(msg.installFailed(cli.title, installCommand(cli)))
        else if (!find(cli.bin)) io.err(msg.installedButNotFound(cli.title))
        else io.out(msg.installDone(cli.title, cli.next))
      }
    } else skipped.push(...picked)
  }
  if (skipped.length > 0) io.out(msg.installSkipped(skipped.map((id) => installCommand(CHANNEL_CLIS[id]))))
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
  // 从已有配置出发，只删掉与新选身份不兼容、或本流程接下来会重新询问的字段（I2）：否则从空对象
  // `{ identity }` 起步会把用户已经配置好的 dwsPath/timeoutMs/killGraceMs/retry/preflightIntervalMs
  // 等高级字段全部丢弃（这些字段 setup 交互流程从不询问，只能靠保留旧值或手工编辑 patch 文件）。
  const config: Config = { ...current, identity }
  if (identity !== 'bot') delete config.robotCode
  if (identity !== 'webhook') delete config.webhookTokenEnv
  if (identity === 'webhook') delete config.defaultTarget
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
    } else if (kind === 'none') {
      delete config.defaultTarget
    } else {
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

/** 按群名搜索飞书群（`lark-cli im +chat-search`）。 */
export async function searchFeishuChats(exec: CheckContext['exec'], lark: string, identity: string, query: string, profile?: string): Promise<{ id: string; name: string }[]> {
  const r = await exec(lark, [...(profile ? [`--profile=${profile}`] : []), 'im', '+chat-search', `--as=${identity}`, `--query=${query}`, '--format=json'])
  if (r.exitCode !== 0) return []
  try {
    const data = JSON.parse(r.stdout) as { data?: { chats?: Array<{ chat_id?: string; name?: string }> } }
    return (data.data?.chats ?? []).map((c) => ({ id: String(c.chat_id ?? ''), name: String(c.name ?? '') })).filter((c) => c.id)
  } catch {
    return []
  }
}

async function feishuIdentityReady(exec: CheckContext['exec'], lark: string, identity: 'bot' | 'user', profile?: string): Promise<{ configured: boolean; ok: boolean }> {
  const r = await exec(lark, [...(profile ? [`--profile=${profile}`] : []), 'auth', 'status', '--json']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  if (r.exitCode !== 0) return { configured: false, ok: false }
  return { configured: true, ok: identityAvailable(r.stdout, identity).ok }
}

const pattern = (re: RegExp, hint: string) => (v: string) => (re.test(v.trim()) ? true : hint)

async function configureFeishu(p: Prompter, current: Config, deps: SetupDeps, io: CliIO, exec: CheckContext['exec'], lark: string | undefined): Promise<Config> {
  const identity = await p.select(msg.FEISHU_IDENTITY_MESSAGE, msg.FEISHU_IDENTITY_CHOICES, (current.identity as 'bot' | 'user') ?? 'bot')
  // 同钉钉：保留 larkPath / profile / timeoutMs 等 setup 不询问的字段
  const config: Config = { ...current, identity }
  const profile = current.profile as string | undefined
  if (lark) {
    const runLark = deps.runLark ?? ((args: string[]) => runDwsInherit(lark, [...(profile ? [`--profile=${profile}`] : []), ...args]))
    let ready = await feishuIdentityReady(exec, lark, identity, profile)
    if (!ready.configured && (await p.confirm(msg.FEISHU_CONFIG_INIT_CONFIRM, true))) {
      if ((await runLark(['config', 'init'])) !== 0) io.err(msg.FEISHU_SETUP_FAILED)
      ready = await feishuIdentityReady(exec, lark, identity, profile)
    }
    if (ready.configured && !ready.ok && identity === 'user' && (await p.confirm(msg.FEISHU_LOGIN_CONFIRM, true))) {
      if ((await runLark(['auth', 'login', '--scope', 'im:message.send_as_user im:message'])) !== 0) io.err(msg.FEISHU_SETUP_FAILED)
    }
  }
  const kind = await p.select(msg.FEISHU_DEFAULT_TARGET_MESSAGE, msg.FEISHU_DEFAULT_TARGET_CHOICES)
  const chatId = () => p.input(msg.FEISHU_CHAT_ID_MESSAGE, undefined, pattern(/^oc_[A-Za-z0-9_-]+$/, msg.CHAT_ID_PATTERN_HINT))
  if (kind === 'search') {
    const query = await p.input(msg.FEISHU_GROUP_QUERY_MESSAGE, undefined, nonEmpty)
    const chats = lark ? await searchFeishuChats(exec, lark, identity, query, profile) : []
    if (chats.length === 0) {
      io.out(msg.FEISHU_NO_GROUP_FOUND)
      config.defaultTarget = { chatId: (await chatId()).trim() }
    } else {
      config.defaultTarget = { chatId: await p.select(msg.FEISHU_SELECT_GROUP_MESSAGE, chats.map((c) => ({ value: c.id, name: `${c.name}（${c.id}）` }))) }
    }
  } else if (kind === 'chatId') {
    config.defaultTarget = { chatId: (await chatId()).trim() }
  } else if (kind === 'userId') {
    config.defaultTarget = { userId: (await p.input(msg.FEISHU_USER_ID_MESSAGE, undefined, pattern(/^ou_[A-Za-z0-9_-]+$/, msg.OPEN_ID_PATTERN_HINT))).trim() }
  } else {
    delete config.defaultTarget
  }
  config.dryRun = await p.confirm(msg.FEISHU_DRY_RUN_MESSAGE, (current.dryRun as boolean) ?? false)
  return config
}

/** 通知渠道：单选；默认沿用现有配置，否则取第一个启用的渠道。 */
async function configureNotify(p: Prompter, current: Config, io: CliIO, enabledChannels: NotifyChannel[]): Promise<Config> {
  const existing = (current.channel as NotifyChannel | undefined) ?? enabledChannels[0] ?? 'dingtalk'
  const channel = await p.select(msg.NOTIFY_CHANNEL_MESSAGE, NOTIFY_CHANNELS.map((c) => ({ value: c, name: msg.NOTIFY_CHANNEL_TITLES[c]! })), existing)
  if (!enabledChannels.includes(channel)) io.out(msg.notifyChannelNotEnabled(msg.NOTIFY_CHANNEL_TITLES[channel]!))
  return { channel }
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

  const ids: KitId[] = ['agent-kit-ws', 'agent-kit-dingtalk', 'agent-kit-feishu', 'agent-kit-notify', 'agent-kit-agent-tasks', 'agent-kit-jev']
  const enabled = await p.checkbox(msg.SELECT_SERVICES_MESSAGE, ids.map((id) => ({ value: id, name: msg.KIT_TITLES[id]!, checked: snap.entries[id].enabled })))

  // 先装好渠道 CLI，后面的登录检查、按群名搜索才用得上
  const channelRows = { dingtalk: 'agent-kit-dingtalk', feishu: 'agent-kit-feishu' } as const
  const enabledChannels = NOTIFY_CHANNELS.filter((c) => enabled.includes(channelRows[c]))
  await installMissingClis(p, io, deps, ctx.findExecutable, enabledChannels)
  const dws = ctx.findExecutable('dws')
  const lark = ctx.findExecutable('lark-cli')
  const loggedIn =
    enabled.includes('agent-kit-dingtalk') &&
    (await runChecks({ ...ctx, snapshot: { ...snap, entries: { ...snap.entries, 'agent-kit-dingtalk': { enabled: true, config: { identity: 'user' } } } } })).results.some(
      (r) => r.id === 'agent-kit-dingtalk.login' && r.status === 'pass',
    )

  const changes: KitChanges = {}
  for (const id of ids) {
    const current = (snap.entries[id].config ?? {}) as Config
    if (!enabled.includes(id)) {
      if (snap.entries[id].enabled) changes[id] = { enabled: false }
      continue
    }
    const config =
      id === 'agent-kit-dingtalk' ? await configureDingtalk(p, current, deps, io, loggedIn, ctx.exec, dws)
      : id === 'agent-kit-feishu' ? await configureFeishu(p, current, deps, io, ctx.exec, lark)
      : id === 'agent-kit-notify' ? await configureNotify(p, current, io, enabledChannels)
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
  const feishu = changes['agent-kit-feishu']
  const feishuConfig = feishu?.config as { identity: 'bot' | 'user'; defaultTarget?: { chatId: string } | { userId: string }; profile?: string; dryRun?: boolean } | undefined
  if (feishu?.enabled && lark && feishuConfig?.defaultTarget && (await p.confirm(msg.FEISHU_TEST_MESSAGE_CONFIRM, false))) {
    const args = buildFeishuArgs({ identity: feishuConfig.identity, profile: feishuConfig.profile, target: feishuConfig.defaultTarget, title: 'dsh-agent-kit', text: msg.dingtalkTestMarkdown(), dryRun: feishuConfig.dryRun === true })
    const r = await ctx.exec(lark, args)
    io.out(`${r.exitCode === 0 ? msg.FEISHU_TEST_MESSAGE_SENT : msg.feishuTestMessageFailed(r.stderr.trim() || String(r.exitCode))}\n`)
  }
  const report = await runChecks(await createCheckContext(profile, deps.checkOverrides))
  io.out(formatReport(report))
  return report.ok ? 0 : 1
}
