import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveExecutable } from '../../src/common/executable.js'
import { isKitError } from '../../src/common/errors.js'
import { buildFeishuArgs, resolveTargets, targetIdempotencyKey } from '../../src/feishu/args.js'
import type { FeishuConfig } from '../../src/feishu/config.js'
import { identityAvailable, parseFeishuError, parseFeishuOutput } from '../../src/feishu/output.js'
import { FeishuService } from '../../src/feishu/service.js'
import { createFakeLark } from '../../src/testing/fake-lark.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('buildFeishuArgs', () => {
  it('builds a bot markdown message to a chat in --key=value form', () => {
    expect(buildFeishuArgs({ identity: 'bot', target: { chatId: 'oc_abc' }, title: 'T', markdown: '--yes -f table', idempotencyKey: 'evt_1', dryRun: false })).toEqual([
      'im',
      '+messages-send',
      '--as=bot',
      '--chat-id=oc_abc',
      '--markdown=**T**\n\n--yes -f table',
      '--idempotency-key=evt_1',
      '--format=json',
    ])
  })

  it('supports user single chats, text with a title, @mentions, profile and dry-run', () => {
    const args = buildFeishuArgs({ identity: 'user', profile: 'prod', target: { userId: 'ou_1' }, title: 'T', text: 'hi', at: { userIds: ['ou_2'], all: true }, dryRun: true })
    expect(args).toEqual(['--profile=prod', 'im', '+messages-send', '--as=user', '--user-id=ou_1', '--text=T\nhi <at user_id="ou_2"></at> <at user_id="all"></at>', '--dry-run', '--format=json'])
  })

  it.each([
    [{ target: { chatId: '-oc_x' }, text: 'x' }, /invalid chatId/],
    [{ target: { chatId: 'cid123' }, text: 'x' }, /invalid chatId/],
    [{ target: { userId: 'u1' }, text: 'x' }, /invalid userId/],
    [{ target: { chatId: 'oc_1' } }, /markdown or text/],
    [{ target: { chatId: 'oc_1' }, text: 'a', markdown: 'b' }, /mutually exclusive/],
    [{ target: { chatId: 'oc_1' }, text: 'a', at: { userIds: ['ou_x"><at user_id="all'] } }, /invalid userId/],
  ])('rejects %j', (input, pattern) => {
    expect(() => buildFeishuArgs({ identity: 'bot', dryRun: false, ...(input as object) } as never)).toThrow(pattern)
  })
})

describe('targets and idempotency keys', () => {
  it('expands and de-duplicates targets', () => {
    expect(resolveTargets({ chatIds: ['oc_a', 'oc_b', 'oc_a'] })).toEqual([{ chatId: 'oc_a' }, { chatId: 'oc_b' }])
    expect(() => resolveTargets(undefined)).toThrow(/target is required/)
    expect(() => resolveTargets({ chatIds: [] })).toThrow(/non-empty/)
    expect(() => resolveTargets({ chatIds: Array.from({ length: 101 }, (_, i) => `oc_${i}`) })).toThrow(/at most 100/)
  })

  it('keeps a short single-target key and derives distinct keys per target', () => {
    expect(targetIdempotencyKey('evt_1', { chatId: 'oc_a' }, 1)).toBe('evt_1')
    const a = targetIdempotencyKey('evt_1', { chatId: 'oc_a' }, 2)
    const b = targetIdempotencyKey('evt_1', { chatId: 'oc_b' }, 2)
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    expect(a).not.toBe(b)
    expect(targetIdempotencyKey('x'.repeat(60), { chatId: 'oc_a' }, 1)).toHaveLength(40)
    expect(() => targetIdempotencyKey('bad key', { chatId: 'oc_a' }, 1)).toThrow(/invalid idempotencyKey/)
  })
})

describe('lark-cli output', () => {
  it('reads the success envelope, dry-run and errors', () => {
    expect(parseFeishuOutput('{"ok":true,"identity":"bot","data":{"message_id":"om_1","chat_id":"oc_1"}}')).toMatchObject({ ok: true, messageId: 'om_1' })
    expect(parseFeishuOutput('{"ok":true,"dry_run":true,"data":{"api":[]}}')).toMatchObject({ ok: true })
    expect(parseFeishuOutput('{"ok":false}')).toEqual({ ok: false })
    expect(() => parseFeishuOutput('nope')).toThrow(/not valid JSON/)
    expect(() => parseFeishuOutput('[1]')).toThrow(/not a JSON object/)
    expect(parseFeishuError('{"ok":false,"error":{"type":"config","subtype":"invalid_client","code":20048,"message":"The specified app does not exist.","hint":"run config init"}}')).toEqual({
      type: 'config',
      subtype: 'invalid_client',
      message: 'The specified app does not exist.',
      hint: 'run config init',
    })
    expect(parseFeishuError('boom\n')).toEqual({ message: 'boom' })
  })

  it('reads identity availability from auth status', () => {
    const status = JSON.stringify({ identities: { bot: { available: true, message: 'Bot identity: ready' }, user: { available: false, message: 'User identity: missing' } } })
    expect(identityAvailable(status, 'bot')).toMatchObject({ ok: true })
    expect(identityAvailable(status, 'user')).toEqual({ ok: false, detail: 'User identity: missing' })
    expect(identityAvailable('x', 'bot').ok).toBe(false)
  })
})

describe('resolveExecutable for lark-cli on win32', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('maps a lark-cli.cmd shim to @larksuite/cli/scripts/run.js', () => {
    dir = mkdtempSync(join(tmpdir(), 'lark-win32-'))
    writeFileSync(join(dir, 'lark-cli.cmd'), '@echo off\r\n')
    const scripts = join(dir, 'node_modules', '@larksuite', 'cli', 'scripts')
    mkdirSync(scripts, { recursive: true })
    writeFileSync(join(scripts, 'run.js'), '')
    expect(resolveExecutable('lark-cli', dir, 'win32')).toBe(join(scripts, 'run.js'))
  })
})

describe('FeishuService', () => {
  const savedEnv = { ...process.env }
  let t: TestRoot
  let lark: ReturnType<typeof createFakeLark>

  beforeEach(() => {
    t = createRoot()
    lark = createFakeLark()
    process.env.LARKSUITE_CLI_CONFIG_DIR = lark.dir
  })
  afterEach(async () => {
    await t.dispose()
    lark.cleanup()
    process.env = { ...savedEnv }
  })

  async function setup(config: Partial<FeishuConfig>) {
    await t.root.plugin(FeishuService, { larkPath: lark.path, ...config } as never)
    let consumer!: Context
    await t.root.inject(['feishu'], (ctx) => {
      consumer = ctx
    })
    return () => consumer.feishu
  }
  const sendCalls = () => lark.calls().filter((c) => c.args.includes('+messages-send'))

  it('applies defaults and checks the identity at startup', async () => {
    const svc = await setup({ identity: 'bot' })
    expect(svc().config).toMatchObject({ timeoutMs: 20_000, retry: { maxAttempts: 2 }, preflightIntervalMs: 3_600_000, dryRun: false })
    expect(lark.calls()[0]!.args).toEqual(['auth', 'status', '--json'])
    expect(svc().health()).toMatchObject({ status: 'ok', counters: { identityOk: true } })
  })

  it('marks failed when the configured identity is unavailable or lark-cli is not configured', async () => {
    const svc = await setup({ identity: 'user' })
    expect(svc().health()).toMatchObject({ status: 'failed', detail: expect.stringMatching(/user identity unavailable/) })
    lark.setScenario({ auth: 'not_configured' })
    await svc().preflight()
    expect(svc().health().detail).toMatch(/not configured/)
    expect(t.failures.map((f) => f.service)).toEqual(['feishu'])
  })

  it.each([
    [{ identity: 'bot', larkPath: 'lark-cli' }, /absolute/],
    [{ identity: 'bot', larkPath: '/nonexistent/lark-cli' }, /not executable/],
    [{ identity: 'webhook' }, /expected/],
    [{}, /identity|required/],
    [{ identity: 'bot', defaultTarget: { chatId: 'cid1' } }, /invalid chatId/],
    [{ identity: 'bot', profile: 'bad profile' }, /profile/],
  ])('fails to start with invalid config %j', async (config, pattern) => {
    await expect(t.root.plugin(FeishuService, { larkPath: lark.path, ...config } as never)).rejects.toThrow(pattern)
  })

  it('fails to start when lark-cli is not in PATH', async () => {
    process.env.PATH = '/nonexistent'
    await expect(t.root.plugin(FeishuService, { identity: 'bot' })).rejects.toThrow(/lark-cli not found in PATH/)
  })

  it('sends to the default target and a per-call override', async () => {
    const svc = await setup({ identity: 'bot', defaultTarget: { chatId: 'oc_default' }, profile: 'prod' })
    expect((await svc().send({ markdown: '## hi', title: 'T' })).results).toEqual([{ target: { chatId: 'oc_default' }, ok: true, messageId: 'om_oc_default' }])
    await svc().send({ text: 'x', target: { userId: 'ou_1' } })
    expect(sendCalls().map((c) => c.args.find((a) => a.startsWith('--chat-id') || a.startsWith('--user-id')))).toEqual(['--chat-id=oc_default', '--user-id=ou_1'])
    expect(sendCalls()[0]!.args[0]).toBe('--profile=prod')
    expect(svc().health().counters.success).toBe(2)
  })

  it('only passes whitelisted env vars and silences lark-cli notices', async () => {
    process.env.LARKSUITE_CLI_APP_SECRET = 'should-not-leak'
    process.env.SOME_OTHER_SECRET = 'x'
    const svc = await setup({ identity: 'bot', defaultTarget: { chatId: 'oc_1' } })
    await svc().send({ text: 'x' })
    const env = sendCalls()[0]!.env
    expect(env).toContain('LARKSUITE_CLI_CONFIG_DIR')
    expect(env).toContain('LARKSUITE_CLI_NO_UPDATE_NOTIFIER')
    expect(env).not.toContain('LARKSUITE_CLI_APP_SECRET')
    expect(env).not.toContain('SOME_OTHER_SECRET')
  })

  it('sends to several chats one by one with per-target idempotency keys and reports partial failures', async () => {
    lark.setScenario({ send: [{ mode: 'fail', failTargets: ['oc_b'] }] })
    const svc = await setup({ identity: 'bot' })
    const r = await svc().send({ text: 'x', target: { chatIds: ['oc_a', 'oc_b'] }, idempotencyKey: 'evt_1' })
    expect(r.results.map((x) => [x.target, x.ok])).toEqual([
      [{ chatId: 'oc_a' }, true],
      [{ chatId: 'oc_b' }, false],
    ])
    expect(r.results[1]!.error).toMatchObject({ code: 'exit_nonzero', details: { subtype: 'bot_not_in_chat' } })
    const keys = sendCalls().map((c) => c.args.find((a) => a.startsWith('--idempotency-key=')))
    expect(new Set(keys).size).toBe(2)
    expect(svc().health()).toMatchObject({ status: 'degraded' })
  })

  it('throws for a single failed target', async () => {
    lark.setScenario({ send: [{ mode: 'fail' }] })
    const svc = await setup({ identity: 'bot', defaultTarget: { chatId: 'oc_1' } })
    const err = await svc().send({ text: 'x' }).catch((e) => e)
    expect(isKitError(err) && err.service).toBe('feishu')
    expect(err.message).toMatch(/Bot\/User can NOT be out of the chat/)
  })

  it('retries retryable failures only when an idempotency key is given', async () => {
    lark.setScenario({ send: [{ mode: 'fail', type: 'network' }, { mode: 'success' }] })
    const svc = await setup({ identity: 'bot', defaultTarget: { chatId: 'oc_1' } })
    await expect(svc().send({ text: 'x' })).rejects.toMatchObject({ retryable: true })
    lark.setScenario({ send: [{ mode: 'fail', type: 'network' }, { mode: 'success' }] })
    expect((await svc().send({ text: 'x', idempotencyKey: 'evt_2' })).results[0]!.ok).toBe(true)
    expect(sendCalls()).toHaveLength(3)
  })

  it('reports bad output, timeouts and aborts', async () => {
    const svc = await setup({ identity: 'bot', defaultTarget: { chatId: 'oc_1' }, timeoutMs: 1000, killGraceMs: 100 })
    lark.setScenario({ send: [{ mode: 'bad_output' }] })
    await expect(svc().send({ text: 'x' })).rejects.toMatchObject({ code: 'bad_output' })
    lark.setScenario({ send: [{ mode: 'hang' }] })
    await expect(svc().send({ text: 'x' })).rejects.toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    const pending = svc().send({ text: 'x', signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  })

  it('does not call lark-cli for invalid input and skips preflight in dryRun', async () => {
    const svc = await setup({ identity: 'bot', dryRun: true })
    expect(lark.calls()).toEqual([])
    await expect(svc().send({ text: 'x' })).rejects.toThrow(/target is required/)
    expect((await svc().send({ text: 'x', target: { chatId: 'oc_1' } })).results[0]!.ok).toBe(true)
    expect(sendCalls()[0]!.args).toContain('--dry-run')
    // 之后的成功发送覆盖之前的参数错误
    expect(svc().health()).toMatchObject({ status: 'ok', detail: 'dry-run', counters: { failure: 1, success: 1 } })
  })
})

describe('FeishuService login state', () => {
  const savedEnv = { ...process.env }
  let t: TestRoot
  let lark: ReturnType<typeof createFakeLark>
  beforeEach(() => {
    t = createRoot()
    lark = createFakeLark()
    process.env.LARKSUITE_CLI_CONFIG_DIR = lark.dir
  })
  afterEach(async () => {
    await t.dispose()
    lark.cleanup()
    process.env = { ...savedEnv }
  })
  const start = async (config: Partial<FeishuConfig> = {}) => {
    await t.root.plugin(FeishuService, { larkPath: lark.path, identity: 'user', ...config } as never)
    return t.root.get('feishu') as unknown as FeishuService
  }

  it('logs a user in with the two-step device flow and out again', async () => {
    const svc = await start({ profile: 'prod' })
    expect(await svc.status()).toMatchObject({ channel: 'feishu', identity: 'user', online: false })
    const session = await svc.login()
    expect(session).toMatchObject({ verificationUrl: expect.stringContaining('ABCD-EFGH'), userCode: 'ABCD-EFGH' })
    expect(session.expiresAt).toBeGreaterThan(Date.now() + 500_000)
    expect(await svc.login()).toBe(session)
    expect(await session.completed).toMatchObject({ online: true, account: 'Tester' })
    const logins = lark.calls().filter((c) => c.args.includes('login')).map((c) => c.args)
    expect(logins).toEqual([
      ['--profile=prod', 'auth', 'login', '--scope=im:message.send_as_user im:message', '--no-wait', '--json'],
      ['--profile=prod', 'auth', 'login', '--device-code=dc_fake', '--json'],
    ])
    expect(await svc.logout()).toMatchObject({ online: false })
  })

  it('resolves completed offline when denied, and fails when the device code cannot be requested', async () => {
    lark.setScenario({ login: 'deny' })
    const svc = await start()
    expect(await (await svc.login()).completed).toMatchObject({ online: false })
    lark.setScenario({ login: 'start_fail' })
    await expect(svc.login()).rejects.toMatchObject({ code: 'login_failed', message: expect.stringMatching(/request device code failed/) })
  })

  it('reports the app for bot identity and rejects user login / logout there', async () => {
    const svc = await start({ identity: 'bot' })
    expect(await svc.status()).toMatchObject({ identity: 'bot', online: true, account: 'cli_fake' })
    await expect(svc.login()).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/config init/) })
    await expect(svc.logout()).rejects.toMatchObject({ code: 'unsupported' })
  })
})
