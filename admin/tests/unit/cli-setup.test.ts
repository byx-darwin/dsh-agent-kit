import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/main.js'
import { scriptedPrompter } from '../../src/cli/prompter.js'
import { readCredential, resolveSecretRef } from '@baoyx/dsh-agent-kit/secrets'

let home: string
let patchFile: string
let out: string[]
const io = () => ({ out: (t: string) => void out.push(t), err: (t: string) => void out.push(t), env: {} })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const dir = join(home, 'profiles', 'kit')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@baoyx/dsh-agent-kit'], patchReload: 'live' } } }))
  patchFile = join(dir, 'cordis.patch.yml')
  writeFileSync(patchFile, '# mine\n')
  out = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const deps = (answers: unknown[], extra: Record<string, unknown> = {}) => ({
  home,
  prompter: scriptedPrompter(answers),
  keyStore: { env: {}, platform: 'linux' as const, credentialsFile: join(home, '.credentials.yaml') },
  checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, findExecutable: () => '/usr/bin/dws', exec: async () => ({ exitCode: 0, stdout: '{"authenticated":true,"token_valid":true}', stderr: '' }), keyStore: { env: {}, platform: 'linux' as const, credentialsFile: join(home, '.credentials.yaml') } },
  ...extra,
})

describe('setup', () => {
  it('configures dingtalk and jev end to end, then runs doctor', async () => {
    const answers = [
      ['agent-kit-dingtalk', 'agent-kit-jev'], // 启用哪些
      'chatId', // 默认目标类型
      'cidTest1', // 群 ID
      false, // 是否 dryRun
      'typesafe', // Jev 服务
      'jev-latest', // Jev 模型
      'ts-secret-key', // Key（password）
      'credentials', // 保存位置（linux 只有 credentials，仍会确认一次）
      true, // 确认写入
      false, // 不发送测试消息
    ]
    const code = await main(['setup', '--profile', 'kit'], io(), deps(answers))
    expect(code).toBe(0)
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toContain('# mine')
    expect(text).toMatch(/id: agent-kit-dingtalk\n\s+disabled: false\n\s+config:\n\s+identity: user/)
    expect(text).not.toContain('ts-secret-key')
    expect(await readCredential('TYPESAFE_API_KEY', join(home, '.credentials.yaml'))).toBe('ts-secret-key')
    const printed = out.join('')
    expect(printed).toContain('+ - id: agent-kit-dingtalk')
    expect(printed).toContain('全部检查通过')
    expect(printed).not.toContain('ts-secret-key')
  })

  it('writes nothing when the user declines the diff', async () => {
    const code = await main(['setup', '--profile', 'kit'], io(), deps([['agent-kit-ws'], false]))
    expect(code).toBe(1)
    expect(readFileSync(patchFile, 'utf8')).toBe('# mine\n')
  })

  it('re-asks on invalid input and keeps existing keys', async () => {
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  TYPESAFE_API_KEY: old\n', { mode: 0o600 })
    const answers = [['agent-kit-jev'], 'typesafe', 'jev-latest', true /* 保留已有 Key */, true]
    expect(await main(['setup', '--profile', 'kit'], io(), deps(answers))).toBe(0)
    expect(await readCredential('TYPESAFE_API_KEY', join(home, '.credentials.yaml'))).toBe('old')
  })

  it('configures jev with a local Laya server and saves the Laya key to the dsh credentials', async () => {
    const probed: string[] = []
    const answers = [
      ['agent-kit-jev'],
      'laya', // Jev 服务
      'http://127.0.0.1:18765', // Laya 地址
      'jev-latest', // 模型
      true, // Laya 开启了鉴权，保存 Key
      'laya-secret-key', // Key（password）
      true, // 确认写入
    ]
    const d = deps(answers)
    const code = await main(['setup', '--profile', 'kit'], io(), { ...d, checkOverrides: { ...d.checkOverrides, probeHttp: async (url: string) => (probed.push(url), true) } })
    expect(code).toBe(0)
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toMatch(/provider: laya/)
    expect(text).toMatch(/baseURL: http:\/\/127\.0\.0\.1:18765/)
    expect(text).not.toContain('keychainService')
    expect(text).not.toContain('laya-secret-key')
    expect(await readCredential('LAYA_API_KEY', join(home, '.credentials.yaml'))).toBe('laya-secret-key')
    expect(await readCredential('TYPESAFE_API_KEY', join(home, '.credentials.yaml'))).toBeUndefined()
    expect(probed).toEqual(['http://127.0.0.1:18765'])
    expect(out.join('')).not.toContain('laya-secret-key')
  })

  it('offers dws login for a logged-out user identity', async () => {
    const dwsCalls: string[][] = []
    const answers = [['agent-kit-dingtalk'], 'userId', 'u1', false, true /* 运行 dws auth login */, true, false /* 不发送测试消息 */]
    const code = await main(['setup', '--profile', 'kit'], io(), deps(answers, {
      runDws: async (args: string[]) => (dwsCalls.push(args), 0),
      checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, findExecutable: () => '/usr/bin/dws', exec: async () => ({ exitCode: 0, stdout: '{"authenticated":false}', stderr: '' }), keyStore: {} },
    }))
    expect(dwsCalls).toEqual([['auth', 'login']])
    expect(code).toBe(1) // 假 exec 仍报告未登录，doctor 失败
  })

  it('searches groups by name and sends a test message to the current user', async () => {
    const execCalls: string[][] = []
    const exec = async (_file: string, args: string[]) => {
      execCalls.push(args)
      if (args[1] === '+chat-search') return { exitCode: 0, stdout: JSON.stringify({ chats: [{ openConversationId: 'cidFound', title: '研发群' }] }), stderr: '' }
      if (args[0] === 'auth') return { exitCode: 0, stdout: JSON.stringify({ authenticated: true, token_valid: true, user_id: 'me123' }), stderr: '' }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { success: true } }), stderr: '' }
    }
    const answers = [['agent-kit-dingtalk'], 'search', '研发', 'cidFound', false, true, true /* 发送测试消息 */]
    const code = await main(['setup', '--profile', 'kit'], io(), deps(answers, {
      checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, findExecutable: () => '/usr/bin/dws', exec, keyStore: {} },
    }))
    expect(code).toBe(0)
    expect(readFileSync(patchFile, 'utf8')).toContain('chatId: cidFound')
    const send = execCalls.find((a) => a[1] === '+messages-send')!
    expect(send).toEqual(expect.arrayContaining(['--as=user', '--user=me123', '--yes', '--format=json']))
    expect(out.join('')).toContain('测试消息已发送')
  })


  it('configures feishu and selects it as the default notify channel', async () => {
    const answers = [
      ['agent-kit-feishu', 'agent-kit-notify'],
      'cli_x', // App ID
      'feishu', // 域名
      's3cret', // App Secret（password）
      'feishu', // 默认通知渠道
      true, // 确认写入
      false, // 不发送飞书测试消息
    ]
    const feishuProbe = async () => ({ ok: true, botName: 'bot', detail: 'ok' })
    const d = deps(answers, { feishuProbe })
    const code = await main(['setup', '--profile', 'kit'], io(), { ...d, checkOverrides: { ...d.checkOverrides, feishuProbe } })
    expect(code).toBe(0)
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toMatch(/id: agent-kit-feishu\n\s+disabled: false\n\s+config:\n\s+appId: cli_x/)
    expect(text).toMatch(/id: agent-kit-notify[\s\S]*channel: feishu/)
    expect(text).not.toContain('s3cret')
    expect((await resolveSecretRef('FEISHU_APP_SECRET', d.keyStore))?.value).toBe('s3cret')
    expect(out.join('')).toContain('飞书凭据有效')
  })
  it('configures wecom with an opt-in connection test and selects it as the default notify channel', async () => {
    const probeCalls: unknown[] = []
    const wecomProbe = async (input: unknown) => (probeCalls.push(input), { ok: true, detail: '认证成功' })
    const answers = [
      ['agent-kit-wecom', 'agent-kit-notify'],
      'bot1', // BotID
      's3cret', // Secret（password）
      true, // 确认连接测试
      'wecom', // 默认通知渠道
      true, // 确认写入
    ]
    const d = deps(answers, { wecomProbe })
    const code = await main(['setup', '--profile', 'kit'], io(), d)
    expect(code).toBe(0)
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toMatch(/id: agent-kit-wecom\n\s+disabled: false\n\s+config:\n\s+botId: bot1/)
    expect(text).toMatch(/id: agent-kit-notify[\s\S]*channel: wecom/)
    expect(text).not.toContain('s3cret')
    expect((await resolveSecretRef('WECOM_BOT_SECRET', d.keyStore))?.value).toBe('s3cret')
    expect(probeCalls).toEqual([expect.objectContaining({ botId: 'bot1', secret: 's3cret' })])
    expect(out.join('')).toContain('认证成功')
  })

  it('loads the WeCom SDK from the Profile for the connection test and warns that the running Agent will not reconnect', async () => {
    // Profile 里放一个假的 SDK（不联网）：connect 后立即认证成功
    const sdkDir = join(home, 'profiles', 'kit', 'node_modules', '@wecom', 'aibot-node-sdk')
    mkdirSync(sdkDir, { recursive: true })
    writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: '@wecom/aibot-node-sdk', version: '1.0.7', type: 'module', main: 'index.mjs' }))
    writeFileSync(join(sdkDir, 'index.mjs'), [
      "import { EventEmitter } from 'node:events'",
      'export class WSClient extends EventEmitter {',
      "  connect() { setImmediate(() => this.emit('authenticated')); return this }",
      '  disconnect() {}',
      '}',
    ].join('\n'))
    const confirms: Array<{ message: string; def: unknown }> = []
    const base = scriptedPrompter([['agent-kit-wecom'], 'bot1', 's3cret', true /* 确认连接测试 */, true])
    const prompter = { ...base, confirm: (m: string, def?: boolean) => (confirms.push({ message: m, def }), base.confirm(m, def)) }
    const code = await main(['setup', '--profile', 'kit'], io(), { ...deps([]), prompter })
    expect(code).toBe(0)
    expect(out.join('')).toContain('认证成功')
    const probeConfirm = confirms.find((c) => c.message.includes('测试连接'))!
    expect(probeConfirm.def).toBe(false)
    expect(probeConfirm.message).toMatch(/挤下线/)
    expect(probeConfirm.message).toMatch(/不会自动重连/)
    expect(probeConfirm.message).toMatch(/重载「企业微信」行/)
  })

  it('does not run the wecom connection test when the user declines', async () => {
    const probeCalls: unknown[] = []
    const wecomProbe = async (input: unknown) => (probeCalls.push(input), { ok: true, detail: '认证成功' })
    const answers = [['agent-kit-wecom'], 'bot1', 's3cret', false /* 不测试连接 */, true]
    const d = deps(answers, { wecomProbe })
    const code = await main(['setup', '--profile', 'kit'], io(), d)
    expect(code).toBe(0)
    expect(probeCalls).toEqual([])
    expect(readFileSync(patchFile, 'utf8')).toContain('botId: bot1')
  })
})
