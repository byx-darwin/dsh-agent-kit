#!/usr/bin/env node
// 假 dws：供 @mc/dsh-agent-kit/testing 与本包测试使用，输出结构来自录制的真实 dws 输出（tests/fixtures/dws）。
// 场景从 $DWS_CONFIG_DIR/fake-dws.json 读取（DWS_CONFIG_DIR 在子进程环境变量白名单中），
// 每次调用的参数追加写入 $DWS_CONFIG_DIR/calls.jsonl。
//
// fake-dws.json:
// {
//   "auth": "ok" | "expired" | "error",
//   "login": "approve" | "deny" | "hang" | "no_link",   // dws auth login --device；approve 后 auth 变为 ok（success / fail 为 approve / deny 的别名）
//   "loginDelayMs": 300,
//   "send": [ { "mode": "success" | "fail" | "hang" | "bad_output" | "partial", ... }, ... ]  // 按调用次序取，超出时重复最后一个
// }
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.DWS_CONFIG_DIR
const args = process.argv.slice(2)
const scenarioPath = dir ? join(dir, 'fake-dws.json') : undefined
const scenario = scenarioPath && existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : {}
if (dir) appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ args, env: Object.keys(process.env).sort() })}\n`)

const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`)
const err = (v, code) => {
  process.stderr.write(`${JSON.stringify(v, null, 2)}\n`)
  process.exit(code)
}
const flag = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true
}

// 登录 / 退出改变的状态写在 auth-state.json，覆盖场景里的 auth
const statePath = dir ? join(dir, 'auth-state.json') : undefined
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const setAuth = (auth) => statePath && writeFileSync(statePath, JSON.stringify({ auth }))

if (args[0] === 'auth' && args[1] === 'status') {
  const auth = state.auth ?? scenario.auth ?? 'ok'
  if (auth === 'error') err({ error: { category: 'auth', code: 2, message: 'not logged in' } }, 2)
  const ok = auth === 'ok'
  out({
    success: true,
    authenticated: ok,
    token_valid: ok,
    refresh_token_valid: ok,
    ...(ok
      ? { expires_at: '2026-09-24T21:30:00+08:00', refresh_expires_at: '2026-10-24T19:30:00+08:00', corp_id: 'dingcorp', corp_name: '示例公司', user_id: 'u1', user_name: '张三' }
      : { message: '未登录' }),
  })
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'login') {
  // 真实 dws 的设备流把验证码与链接以纯文本写在 stderr，然后同一进程每 5 秒轮询一次
  const mode = { success: 'approve', fail: 'deny' }[scenario.login] ?? scenario.login ?? 'approve'
  if (mode === 'no_link') err({ error: { category: 'network', code: 1, message: 'request device code failed' } }, 1)
  process.stderr.write('● Step 1: Requesting device authorization code...\n\n  authorization code: FAKE-CODE\n  Authorization code will expire in 900 seconds.\n\n  Authorization link (code included):\nhttps://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&user_code=FAKE-CODE\n\n  Link for entering the code manually:\nhttps://login.dingtalk.com/oauth2/device/verify.htm?caller=dws\n\n● Step 2: Waiting for user authorization...\n')
  if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000))
  await new Promise((r) => setTimeout(r, scenario.loginDelayMs ?? 300))
  if (mode === 'deny') err({ error: { category: 'auth', code: 1, message: 'authorization denied' } }, 1)
  setAuth('ok')
  out({ success: true, authenticated: true })
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'logout') {
  // 只退出 --profile 指定的账号时也清掉假 dws 唯一的账号
  setAuth('expired')
  out({ success: true, message: '已退出' })
  process.exit(0)
}

if (args[0] !== 'chat' || args[1] !== '+messages-send') err({ error: { category: 'validation', code: 3, message: `unknown command ${args.slice(0, 2).join(' ')}` } }, 3)

let index = 0
if (dir) {
  const counter = join(dir, 'send-count')
  index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(index + 1))
}
const steps = scenario.send ?? [{ mode: 'success' }]
const step = steps[Math.min(index, steps.length - 1)] ?? { mode: 'success' }
const identity = flag('as') ?? 'user'
const groups = typeof flag('groups') === 'string' ? flag('groups').split(',') : undefined
const tool = identity === 'bot' ? 'send_robot_group_message' : identity === 'webhook' ? 'send_message_by_custom_robot' : 'send_personal_message'

if (identity === 'bot' && !flag('robot-code')) err({ error: { category: 'validation', code: 3, message: '--identity bot 必须指定 --robot-code' } }, 3)

switch (step.mode) {
  case 'hang': {
    // 同时启动一个孙进程，验证超时后整个进程组被终止
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    if (dir) {
      // 原子写入，避免测试读到半截文件
      writeFileSync(join(dir, 'hang-pids.json.tmp'), JSON.stringify({ pid: process.pid, grandchild: child.pid }))
      renameSync(join(dir, 'hang-pids.json.tmp'), join(dir, 'hang-pids.json'))
    }
    setInterval(() => {}, 1000)
    break
  }
  case 'fail':
    err({ error: { category: step.category ?? 'server', code: step.exitCode ?? 1, message: step.message ?? 'send failed' } }, step.exitCode ?? 1)
    break
  case 'bad_output':
    process.stdout.write('not json\n')
    process.exit(0)
    break
  default: {
    if (flag('dry-run')) {
      const targets = groups ?? [undefined]
      out({
        actionCount: targets.length,
        actions: targets.map((t) => ({ arguments: {}, ...(t ? { target: t } : { identity }), tool })),
        ...(groups ? { contractVersion: 'im.batch-write.v1', requestedCount: groups.length } : {}),
        dry_run: true,
        executed: false,
        failedCount: 0,
        preview_kind: 'plan',
        tool,
      })
      process.exit(0)
    }
    const batchTargets = groups ?? (identity === 'bot' ? [flag('users') ?? flag('open-dingtalk-ids')] : undefined)
    if (batchTargets) {
      const failing = new Set(step.mode === 'partial' ? (step.failTargets ?? batchTargets.slice(-1)) : [])
      const succeeded = batchTargets.filter((t) => !failing.has(t)).map((target) => ({ result: { result: [], success: true, messageId: `msg-${target}` }, target }))
      const failures = batchTargets.filter((t) => failing.has(t)).map((target) => ({ error: { message: 'robot is not in the group' }, target }))
      out({
        contractVersion: 'im.batch-write.v1',
        failedCount: failures.length,
        failures,
        ok: failures.length === 0,
        partial: failures.length > 0 && succeeded.length > 0,
        requestedCount: batchTargets.length,
        succeeded,
        succeededCount: succeeded.length,
      })
      process.exit(0)
    }
    out({
      identity,
      ok: true,
      result: { result: [], success: true, messageId: 'msg-1' },
      sendReceipt: { contractVersion: 'im.message-send-receipt.v1', nextActions: [], openTaskId: '', readyForMessageActions: false },
      tool,
    })
    process.exit(0)
  }
}
