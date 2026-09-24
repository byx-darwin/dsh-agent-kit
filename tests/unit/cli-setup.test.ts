import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/main.js'
import { scriptedPrompter } from '../../src/cli/prompter.js'
import { readCredential } from '../../src/secrets/index.js'

let home: string
let patchFile: string
let out: string[]
const io = () => ({ out: (t: string) => void out.push(t), err: (t: string) => void out.push(t), env: {} })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const dir = join(home, 'profiles', 'kit')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@mc/dsh-agent-kit'], patchReload: 'live' } } }))
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
      'bot', // 钉钉身份
      'dingRobot1', // robotCode
      'chatId', // 默认目标类型
      'cidTest1', // 群 ID
      false, // 是否 dryRun
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
    expect(text).toMatch(/id: agent-kit-dingtalk\n\s+disabled: false\n\s+config:\n\s+identity: bot\n\s+robotCode: dingRobot1/)
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
    const answers = [['agent-kit-jev'], 'jev-latest', true /* 保留已有 Key */, true]
    expect(await main(['setup', '--profile', 'kit'], io(), deps(answers))).toBe(0)
    expect(await readCredential('TYPESAFE_API_KEY', join(home, '.credentials.yaml'))).toBe('old')
  })

  it('offers dws login for a logged-out user identity', async () => {
    const dwsCalls: string[][] = []
    const answers = [['agent-kit-dingtalk'], 'user', 'userId', 'u1', false, true /* 运行 dws auth login */, true, false /* 不发送测试消息 */]
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
    const answers = [['agent-kit-dingtalk'], 'user', 'search', '研发', 'cidFound', false, true, true /* 发送测试消息 */]
    const code = await main(['setup', '--profile', 'kit'], io(), deps(answers, {
      checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, findExecutable: () => '/usr/bin/dws', exec, keyStore: {} },
    }))
    expect(code).toBe(0)
    expect(readFileSync(patchFile, 'utf8')).toContain('chatId: cidFound')
    const send = execCalls.find((a) => a[1] === '+messages-send')!
    expect(send).toEqual(expect.arrayContaining(['--as=user', '--user=me123', '--yes', '--format=json']))
    expect(out.join('')).toContain('测试消息已发送')
  })

  /**
   * I2 回归测试：`configureDingtalk` 曾从 `{ identity }` 起步，把已有配置里 setup 交互流程
   * 从不询问、只能靠保留旧值的高级字段（`dwsPath`/`timeoutMs`/`killGraceMs`/`retry`/
   * `preflightIntervalMs`）全部丢弃。这里预先写入一份带这些字段的 dingtalk 配置，切换身份到
   * webhook 后重新保存，确认这些字段被保留，同时与新身份不兼容、或本轮流程重新询问过的字段
   * （`robotCode`、`defaultTarget`）被正确移除。
   */
  it('keeps unrelated advanced dingtalk fields and drops only identity-incompatible ones', async () => {
    writeFileSync(
      patchFile,
      [
        '- id: agent-kit-dingtalk',
        '  disabled: false',
        '  config:',
        '    identity: bot',
        '    robotCode: old-bot',
        '    dwsPath: /custom/dws',
        '    timeoutMs: 20000',
        '    killGraceMs: 8000',
        '    retry:',
        '      maxAttempts: 3',
        '    preflightIntervalMs: 999999',
        '    defaultTarget:',
        '      chatId: cidOld',
        '    dryRun: true',
        '',
      ].join('\n'),
    )
    const answers = [
      ['agent-kit-dingtalk'], // 启用哪些
      'webhook', // 切换身份为 webhook
      'DING_WEBHOOK_TOKEN', // webhookTokenEnv
      false, // dryRun
      true, // 确认写入
      false, // 不发送测试消息
    ]
    const code = await main(['setup', '--profile', 'kit'], io(), deps(answers, {
      checkOverrides: {
        nodeVersion: '24.1.0',
        resolveModule: () => true,
        findExecutable: () => '/usr/bin/dws',
        exec: async () => ({ exitCode: 0, stdout: '{"authenticated":true,"token_valid":true}', stderr: '' }),
        keyStore: {},
        env: { DING_WEBHOOK_TOKEN: 'x' },
      },
    }))
    expect(code).toBe(0)
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toContain('identity: webhook')
    expect(text).toContain('webhookTokenEnv: DING_WEBHOOK_TOKEN')
    // 保留的高级字段
    expect(text).toContain('dwsPath: /custom/dws')
    expect(text).toContain('timeoutMs: 20000')
    expect(text).toContain('killGraceMs: 8000')
    expect(text).toContain('maxAttempts: 3')
    expect(text).toContain('preflightIntervalMs: 999999')
    // 与新身份不兼容、或本轮重新询问过的字段被移除
    expect(text).not.toContain('robotCode')
    expect(text).not.toMatch(/defaultTarget:\s*\n\s*chatId: cidOld/)
  })
})
