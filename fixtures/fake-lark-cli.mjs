#!/usr/bin/env node
// 假 lark-cli：供 @mc/dsh-agent-kit/testing 与本包测试使用，输出信封照录自 @larksuite/cli 1.0.96：
// 成功写 stdout `{ ok: true, identity, data }`（退出码 0），失败写 stderr `{ ok: false, identity, error }`（非 0）。
// 场景从 $LARKSUITE_CLI_CONFIG_DIR/fake-lark.json 读取（该变量在子进程环境变量白名单中），
// 每次调用的参数追加写入 $LARKSUITE_CLI_CONFIG_DIR/calls.jsonl。
//
// fake-lark.json:
// {
//   "auth": { "bot": true, "user": false } | "not_configured",
//   "user": { "openId": "ou_me", "userName": "Me" },
//   "chats": [ { "chat_id": "oc_1", "name": "告警群" } ],
//   "login": "approve" | "deny" | "hang" | "start_fail",   // user 身份的设备流登录；approve 后 user 可用
//   "loginDelayMs": 300,
//   "send": [ { "mode": "success" | "fail" | "hang" | "bad_output", "type": "network", "failTargets": ["oc_2"] }, ... ]  // 按调用次序取，超出时重复最后一个
// }
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.LARKSUITE_CLI_CONFIG_DIR
const raw = process.argv.slice(2)
const args = raw.filter((a) => !a.startsWith('--profile='))
const scenarioPath = dir ? join(dir, 'fake-lark.json') : undefined
const scenario = scenarioPath && existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : {}
if (dir) appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ args: raw, env: Object.keys(process.env).sort() })}\n`)

const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`)
const fail = (identity, error, code = 3) => {
  process.stderr.write(`${JSON.stringify({ ok: false, identity, error }, null, 2)}\n`)
  process.exit(code)
}
const flag = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true
}
const identity = flag('as') ?? 'bot'

if (scenario.auth === 'not_configured') {
  fail(undefined, { type: 'config', subtype: 'not_configured', message: 'not configured', hint: 'run `lark-cli config init --new`' })
}

// 登录 / 退出改变的状态写在 auth-state.json，覆盖场景里的 auth.user
const statePath = dir ? join(dir, 'auth-state.json') : undefined
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const setUser = (user) => statePath && writeFileSync(statePath, JSON.stringify({ user }))

if (args[0] === 'auth' && args[1] === 'login') {
  const mode = scenario.login ?? 'approve'
  if (flag('no-wait')) {
    if (mode === 'start_fail') fail('user', { type: 'network', message: 'request device code failed' }, 1)
    out({ ok: true, data: { verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-EFGH', device_code: 'dc_fake', user_code: 'ABCD-EFGH', expires_in: 600 } })
    process.exit(0)
  }
  if (flag('device-code') !== 'dc_fake') fail('user', { type: 'validation', message: 'unknown device code' }, 2)
  if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000))
  await new Promise((r) => setTimeout(r, scenario.loginDelayMs ?? 300))
  if (mode === 'deny') fail('user', { type: 'authentication', subtype: 'access_denied', message: 'user denied the authorization' }, 1)
  setUser(true)
  out({ ok: true, identity: 'user', data: { userName: scenario.user?.userName ?? 'Tester', openId: scenario.user?.openId ?? 'ou_fake_me' } })
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'logout') {
  setUser(false)
  out({ ok: true, data: { loggedOut: true } })
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'status') {
  const auth = { bot: true, user: false, ...(scenario.auth ?? {}), ...(state.user !== undefined ? { user: state.user } : {}) }
  const user = scenario.user ?? {}
  out({
    appId: 'cli_fake',
    brand: 'feishu',
    identities: {
      bot: auth.bot ? { status: 'ready', available: true, message: 'Bot identity: ready' } : { status: 'missing', available: false, message: 'Bot identity: missing' },
      user: auth.user
        ? { status: 'ok', available: true, message: 'User identity: ok', userName: user.userName ?? 'Tester', openId: user.openId ?? 'ou_fake_me' }
        : { status: 'missing', available: false, message: 'User identity: missing (no user logged in)' },
    },
    identity: auth.user ? 'user' : 'bot',
  })
  process.exit(0)
}

if (args[0] === 'im' && args[1] === '+chat-search') {
  const query = String(flag('query') ?? '')
  out({ ok: true, identity, data: { chats: (scenario.chats ?? []).filter((c) => c.name.includes(query)) } })
  process.exit(0)
}

if (args[0] !== 'im' || args[1] !== '+messages-send') fail(identity, { type: 'validation', message: `unknown command ${args.slice(0, 2).join(' ')}` }, 2)

let index = 0
if (dir) {
  const counter = join(dir, 'send-count')
  index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(index + 1))
}
const steps = scenario.send ?? [{ mode: 'success' }]
const step = steps[Math.min(index, steps.length - 1)] ?? { mode: 'success' }
const target = flag('chat-id') ?? flag('user-id')

if (identity === 'user' && !(state.user ?? (scenario.auth ?? {}).user)) {
  fail('user', { type: 'authentication', subtype: 'token_missing', message: 'need_user_authorization (user: )', hint: 'run `lark-cli auth login`' })
}
if (flag('dry-run')) {
  out({ ok: true, identity, dry_run: true, data: { api: [{ method: 'POST', url: '/open-apis/im/v1/messages', body: { receive_id: target } }] } })
  process.exit(0)
}
if (step.failTargets && !step.failTargets.includes(target)) {
  out({ ok: true, identity, data: { message_id: `om_${target}`, chat_id: target, create_time: '1700000000' } })
  process.exit(0)
}
switch (step.mode) {
  case 'hang':
    setInterval(() => {}, 1000)
    break
  case 'fail':
    fail(identity, { type: step.type ?? 'api', subtype: step.subtype ?? 'bot_not_in_chat', code: 230002, message: step.message ?? 'Bot/User can NOT be out of the chat.' }, step.exitCode ?? 1)
    break
  case 'bad_output':
    process.stdout.write('not json\n')
    process.exit(0)
    break
  default:
    out({ ok: true, identity, data: { message_id: `om_${target}`, chat_id: target, create_time: '1700000000' } })
    process.exit(0)
}
