import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { buildSendArgs } from '../../src/dingtalk/args.js'
import { parseErrorOutput, parseSendOutput } from '../../src/dingtalk/output.js'
import { DingtalkService, resolveExecutable } from '../../src/dingtalk/service.js'
import type { DingtalkConfig } from '../../src/dingtalk/config.js'
import { isKitError } from '../../src/common/errors.js'
import { clearSecretsForTesting } from '../../src/common/redact.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createRoot, until, type TestRoot } from '../helpers.js'

const fixture = (name: string) => readFileSync(new URL(`../fixtures/dws/${name}`, import.meta.url), 'utf8')

describe('buildSendArgs', () => {
  it('builds user group message args in --key=value form', () => {
    const { args, targets, batch } = buildSendArgs({
      identity: 'user',
      target: { chatId: 'cidABC+/=' },
      title: 't',
      markdown: '--yes -f table',
      idempotencyKey: 'evt_1',
      dryRun: false,
    })
    expect(args).toEqual([
      'chat',
      '+messages-send',
      '--as=user',
      '--chat-id=cidABC+/=',
      '--title=t',
      '--markdown=--yes -f table',
      '--idempotency-key=evt_1',
      '--yes',
      '--format=json',
    ])
    expect(targets).toEqual([{ chatId: 'cidABC+/=' }])
    expect(batch).toBe(false)
  })

  it('supports user single chats', () => {
    expect(buildSendArgs({ identity: 'user', target: { userId: 'u1' }, text: 'hi', dryRun: true }).args).toContain('--user=u1')
    expect(buildSendArgs({ identity: 'user', target: { openDingtalkId: '$:LWCP_v1:$abc' }, text: 'hi', dryRun: true }).args).toEqual(
      expect.arrayContaining(['--open-dingtalk-id=$:LWCP_v1:$abc', '--text=hi', '--dry-run']),
    )
  })

  it('builds bot multi-group args with de-duplication and ledger mode', () => {
    const r = buildSendArgs({ identity: 'bot', robotCode: 'ding123', target: { chatIds: ['cidA', 'cidB', 'cidA'] }, markdown: 'm', dryRun: false })
    expect(r.args).toEqual(expect.arrayContaining(['--as=bot', '--robot-code=ding123', '--groups=cidA,cidB']))
    expect(r.targets).toEqual([{ chatId: 'cidA' }, { chatId: 'cidB' }])
    expect(r.batch).toBe(true)
    expect(buildSendArgs({ identity: 'bot', robotCode: 'r', target: { userId: 'u1' }, text: 'x', dryRun: false }).args).toContain('--users=u1')
    expect(buildSendArgs({ identity: 'bot', robotCode: 'r', target: { openDingtalkId: 'o1' }, text: 'x', dryRun: false }).args).toContain('--open-dingtalk-ids=o1')
    expect(buildSendArgs({ identity: 'bot', robotCode: 'r', target: { chatId: 'c1' }, text: 'x', dryRun: false }).args).toContain('--groups=c1')
  })

  it('builds webhook args and requires no target', () => {
    const r = buildSendArgs({ identity: 'webhook', webhookToken: 'tok', text: 'x', at: { mobiles: ['13800000000'], all: true }, dryRun: false })
    expect(r.args).toEqual(expect.arrayContaining(['--as=webhook', '--webhook-token=tok', '--at-all', '--at-mobiles=13800000000']))
    expect(r.targets).toEqual([{ webhook: true }])
    expect(() => buildSendArgs({ identity: 'webhook', webhookToken: 'tok', target: { chatId: 'c' }, text: 'x', dryRun: false })).toThrow(/target must be omitted/)
    expect(() => buildSendArgs({ identity: 'webhook', text: 'x', dryRun: false })).toThrow(/token/)
  })

  it('maps @ parameters per identity', () => {
    expect(buildSendArgs({ identity: 'bot', robotCode: 'r', target: { chatId: 'c' }, text: 'x', at: { userIds: ['u1', 'u2'] }, dryRun: false }).args).toContain('--at-user-ids=u1,u2')
    expect(buildSendArgs({ identity: 'user', target: { chatId: 'c' }, text: 'x', at: { openDingtalkIds: ['o1'] }, dryRun: false }).args).toContain('--at-open-dingtalk-ids=o1')
    expect(() => buildSendArgs({ identity: 'user', target: { chatId: 'c' }, text: 'x', at: { userIds: ['u1'] }, dryRun: false })).toThrow(/openDingtalkIds/)
    expect(() => buildSendArgs({ identity: 'bot', robotCode: 'r', target: { chatId: 'c' }, text: 'x', at: { mobiles: ['1380000'] }, dryRun: false })).toThrow(/webhook/)
    expect(() => buildSendArgs({ identity: 'webhook', webhookToken: 't', text: 'x', at: { openDingtalkIds: ['o'] }, dryRun: false })).toThrow(/webhook/)
  })

  it('passes idempotency keys only for user identity', () => {
    expect(buildSendArgs({ identity: 'bot', robotCode: 'r', target: { chatId: 'c' }, text: 'x', idempotencyKey: 'k', dryRun: false }).args.join(' ')).not.toContain('idempotency')
  })

  it.each([
    [{ chatId: '-rf' }],
    [{ chatId: '--yes' }],
    [{ chatId: 'a b' }],
    [{ chatId: 'x;rm' }],
    [{ userId: '' }],
    [{ userId: 'u/1' }],
    [{ openDingtalkId: 'o 1' }],
  ])('rejects malformed target %j with invalid_target', (target) => {
    try {
      buildSendArgs({ identity: 'user', target: target as never, text: 'x', dryRun: false })
      expect.unreachable()
    } catch (e) {
      expect(isKitError(e) && e.code).toBe('invalid_target')
    }
  })

  it('rejects invalid combinations', () => {
    expect(() => buildSendArgs({ identity: 'user', target: { chatIds: ['a'] }, text: 'x', dryRun: false })).toThrow(/only supported for bot/)
    expect(() => buildSendArgs({ identity: 'user', text: 'x', dryRun: false })).toThrow(/target is required/)
    expect(() => buildSendArgs({ identity: 'bot', robotCode: 'r', text: 'x', dryRun: false })).toThrow(/target is required/)
    expect(() => buildSendArgs({ identity: 'bot', target: { chatId: 'c' }, text: 'x', dryRun: false })).toThrow(/robotCode/)
    expect(() => buildSendArgs({ identity: 'bot', robotCode: 'r', target: { chatIds: [] }, text: 'x', dryRun: false })).toThrow(/non-empty/)
    const many = Array.from({ length: 101 }, (_, i) => `cid${i}`)
    expect(() => buildSendArgs({ identity: 'bot', robotCode: 'r', target: { chatIds: many }, text: 'x', dryRun: false })).toThrow(/at most 100/)
    expect(() => buildSendArgs({ identity: 'user', target: { chatId: 'c' }, dryRun: false })).toThrow(/required/)
    expect(() => buildSendArgs({ identity: 'user', target: { chatId: 'c' }, text: 'a', markdown: 'b', dryRun: false })).toThrow(/mutually exclusive/)
    expect(() => buildSendArgs({ identity: 'user', target: { chatId: 'c' }, text: 'a', idempotencyKey: 'k k', dryRun: false })).toThrow(/idempotencyKey/)
  })
})

describe('dws output contract (recorded fixtures)', () => {
  it('parses user send output', () => {
    expect(parseSendOutput(fixture('user-success.json'), [{ chatId: 'cidTEST123' }], false)).toEqual([{ target: { chatId: 'cidTEST123' }, ok: true }])
  })

  it('parses bot batch ledger', () => {
    const r = parseSendOutput(fixture('bot-groups-success.json'), [{ chatId: 'cidA' }, { chatId: 'cidB' }], true)
    expect(r.map((x) => x.ok)).toEqual([true, true])
  })

  it('parses dry-run plans', () => {
    expect(parseSendOutput(fixture('user-dry-run.json'), [{ chatId: 'c' }], false)).toEqual([{ target: { chatId: 'c' }, ok: true }])
    expect(parseSendOutput(fixture('bot-groups-dry-run.json'), [{ chatId: 'cidA' }, { chatId: 'cidB' }], true).every((r) => r.ok)).toBe(true)
    expect(parseSendOutput(fixture('webhook-dry-run.json'), [{ webhook: true }], false)[0]!.ok).toBe(true)
  })

  it('parses stderr error JSON', () => {
    expect(parseErrorOutput(fixture('validation-error.stderr.json'))).toEqual({ category: 'validation', message: '--identity bot 必须指定 --robot-code' })
    expect(parseErrorOutput('plain text')).toEqual({ message: 'plain text' })
    expect(parseErrorOutput('')).toEqual({ message: 'dws failed' })
  })

  it('reports bad output and missing ledger targets', () => {
    expect(() => parseSendOutput('nope', [{ chatId: 'c' }], false)).toThrow(/not valid JSON/)
    expect(() => parseSendOutput('[1]', [{ chatId: 'c' }], false)).toThrow(/not a JSON object/)
    expect(() => parseSendOutput('{"contractVersion":"im.batch-write.v1"}', [{ chatId: 'c' }], true)).toThrow(/succeeded\/failures/)
    const r = parseSendOutput('{"succeeded":[],"failures":[]}', [{ chatId: 'c' }], true)
    expect(r[0]).toMatchObject({ ok: false })
    expect(r[0]!.error!.code).toBe('bad_output')
    const failed = parseSendOutput('{"ok":false,"error":{"message":"denied"}}', [{ chatId: 'c' }], false)
    expect(failed[0]!.error!.message).toBe('denied')
  })
})

describe('DingtalkService', () => {
  let t: TestRoot
  let dws: ReturnType<typeof createFakeDws>
  const savedEnv = { ...process.env }

  beforeEach(() => {
    t = createRoot()
    dws = createFakeDws()
    process.env.DWS_CONFIG_DIR = dws.dir
  })

  afterEach(async () => {
    await t.dispose()
    dws.cleanup()
    process.env = { ...savedEnv }
    clearSecretsForTesting()
  })

  async function setup(config: Partial<DingtalkConfig>) {
    await t.root.plugin(DingtalkService, { dwsPath: dws.path, ...config } as never)
    let consumer!: Context
    const fiber = await t.root.inject(['dingtalk'], (ctx) => {
      consumer = ctx
    })
    return { svc: () => consumer.dingtalk, fiber }
  }

  const sendCalls = () => dws.calls().filter((c) => c.args[0] === 'chat')

  it('applies defaults and checks login at startup', async () => {
    const { svc } = await setup({ identity: 'user' })
    expect(svc().config).toMatchObject({ timeoutMs: 15_000, killGraceMs: 5000, retry: { maxAttempts: 2 }, preflightIntervalMs: 3_600_000, dryRun: false })
    expect(dws.calls()[0]!.args).toEqual(['auth', 'status', '--format=json'])
    expect(svc().health()).toMatchObject({ status: 'ok', counters: { loginOk: true } })
  })

  it.each([
    [{ identity: 'bot' }, /robotCode is required/],
    [{ identity: 'webhook' }, /webhookTokenEnv is required/],
    [{ identity: 'webhook', webhookTokenEnv: 'AGENT_KIT_MISSING_TOKEN' }, /is not set/],
    [{ identity: 'user', dwsPath: 'dws' }, /absolute/],
    [{ identity: 'user', dwsPath: '/nonexistent/dws' }, /not executable/],
    [{ identity: 'nobody' }, /expected/],
    [{}, /identity|required/],
    [{ identity: 'user', timeoutMs: 10 }, /expected/],
    [{ identity: 'user', retry: { maxAttempts: 9 } }, /expected/],
    [{ identity: 'user', defaultTarget: { chatId: '-bad' } }, /invalid chatId/],
    [{ identity: 'user', defaultTarget: { chatIds: ['a'] } }, /only supported for bot/],
  ])('fails to start with invalid config %j', async (config, pattern) => {
    await expect(t.root.plugin(DingtalkService, { dwsPath: dws.path, ...config } as never)).rejects.toThrow(pattern)
  })

  it.skipIf(process.platform === 'win32')('resolves dws from PATH when dwsPath is omitted', () => {
    expect(resolveExecutable('node', `relative:${process.execPath.replace(/\/node$/, '')}`)).toBe(process.execPath)
    expect(resolveExecutable('definitely-not-a-binary-xyz')).toBeUndefined()
  })

  it('fails to start when dws is not in PATH', async () => {
    process.env.PATH = '/nonexistent'
    await expect(t.root.plugin(DingtalkService, { identity: 'user' })).rejects.toThrow(/not found in PATH/)
  })

  it('sends with the default target and per-call override', async () => {
    const { svc } = await setup({ identity: 'user', defaultTarget: { chatId: 'cidDefault' } })
    const r1 = await svc().send({ markdown: '## hi', title: 'T', traceId: 'evt_1' })
    expect(r1.results).toEqual([{ target: { chatId: 'cidDefault' }, ok: true, messageId: 'msg-1' }])
    await svc().send({ text: 'x', target: { userId: 'u1' } })
    const calls = sendCalls()
    expect(calls[0]!.args).toContain('--chat-id=cidDefault')
    expect(calls[1]!.args).toContain('--user=u1')
    expect(svc().health().counters.success).toBe(2)
  })

  it('only passes whitelisted env vars to dws', async () => {
    process.env.TYPESAFE_API_KEY = 'should-not-leak'
    process.env.SOME_TOKEN = 'nope'
    const { svc } = await setup({ identity: 'user', defaultTarget: { chatId: 'c' } })
    await svc().send({ text: 'x' })
    const env = sendCalls()[0]!.env
    expect(env).not.toContain('TYPESAFE_API_KEY')
    expect(env).not.toContain('SOME_TOKEN')
    expect(env).toContain('DWS_CONFIG_DIR')
  })

  it('bot multi-group partial failure does not throw', async () => {
    dws.setScenario({ send: [{ mode: 'partial', failTargets: ['cidB'] }] })
    const { svc } = await setup({ identity: 'bot', robotCode: 'ding1' })
    const { results } = await svc().send({ markdown: 'm', target: { chatIds: ['cidA', 'cidB'] } })
    expect(results.map((r) => [r.target, r.ok])).toEqual([
      [{ chatId: 'cidA' }, true],
      [{ chatId: 'cidB' }, false],
    ])
    expect(results[1]!.error).toMatchObject({ code: 'send_failed', service: 'dingtalk' })
    expect(svc().health().status).toBe('degraded')
  })

  it('warns once when idempotencyKey is used with a non-user identity', async () => {
    const { svc } = await setup({ identity: 'bot', robotCode: 'ding1', defaultTarget: { chatId: 'c' } })
    await svc().send({ text: 'a', idempotencyKey: 'k1' })
    await svc().send({ text: 'b', idempotencyKey: 'k2' })
    expect(t.logs.filter((l) => l.includes('idempotencyKey is ignored'))).toHaveLength(1)
    expect(sendCalls().every((c) => !c.args.some((a) => a.includes('idempotency')))).toBe(true)
  })

  it('retries retryable failures only for user identity with idempotencyKey', async () => {
    dws.setScenario({ send: [{ mode: 'fail', category: 'network' }, { mode: 'success' }] })
    const { svc } = await setup({ identity: 'user', defaultTarget: { chatId: 'c' } })
    const r = await svc().send({ text: 'x', idempotencyKey: 'evt_1' })
    expect(r.results[0]!.ok).toBe(true)
    expect(sendCalls()).toHaveLength(2)
    expect(sendCalls().every((c) => c.args.includes('--idempotency-key=evt_1'))).toBe(true)

    dws.setScenario({ send: [{ mode: 'fail', category: 'network' }, { mode: 'success' }] })
    await expect(svc().send({ text: 'x' })).rejects.toMatchObject({ code: 'exit_nonzero', retryable: true })
    expect(sendCalls()).toHaveLength(3)
  })

  it('does not retry non-retryable failures and stops after maxAttempts', async () => {
    dws.setScenario({ send: [{ mode: 'fail', category: 'validation', exitCode: 3 }] })
    const { svc } = await setup({ identity: 'user', defaultTarget: { chatId: 'c' }, retry: { maxAttempts: 1 } })
    await expect(svc().send({ text: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'exit_nonzero', retryable: false })
    expect(sendCalls()).toHaveLength(1)
    dws.setScenario({ send: [{ mode: 'fail', category: 'network' }] })
    await expect(svc().send({ text: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'exit_nonzero' })
    expect(sendCalls()).toHaveLength(3)
    expect(svc().health().counters).toMatchObject({ failure: 2, lastErrorCode: 'exit_nonzero' })
  })

  it('does not retry bot sends', async () => {
    dws.setScenario({ send: [{ mode: 'fail', category: 'network' }, { mode: 'success' }] })
    const { svc } = await setup({ identity: 'bot', robotCode: 'r', defaultTarget: { chatId: 'c' } })
    await expect(svc().send({ text: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'exit_nonzero' })
    expect(sendCalls()).toHaveLength(1)
  })

  it('reports bad_output and invalid_target', async () => {
    dws.setScenario({ send: [{ mode: 'bad_output' }] })
    const { svc } = await setup({ identity: 'user', defaultTarget: { chatId: 'c' } })
    await expect(svc().send({ text: 'x' })).rejects.toMatchObject({ code: 'bad_output' })
    await expect(svc().send({ text: 'x', target: { chatId: '-x' } })).rejects.toMatchObject({ code: 'invalid_target', retryable: false })
    expect(sendCalls()).toHaveLength(1)
  })

  it('kills a hanging dws (and its children) on timeout', async () => {
    dws.setScenario({ send: [{ mode: 'hang' }] })
    const { svc } = await setup({ identity: 'bot', robotCode: 'r', defaultTarget: { chatId: 'c' }, timeoutMs: 1000, killGraceMs: 200 })
    await expect(svc().send({ text: 'x' })).rejects.toMatchObject({ code: 'timeout', retryable: true })
    const pids = dws.hangPids()!
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await until(() => !alive(pids.pid) && !alive(pids.grandchild), 3000, 'dws process group still alive')
  })

  it('redacts the webhook token from errors and logs', async () => {
    process.env.AGENT_KIT_TEST_WEBHOOK = 'webhook-secret-token-123'
    dws.setScenario({ send: [{ mode: 'fail', message: 'bad token webhook-secret-token-123' }] })
    const { svc } = await setup({ identity: 'webhook', webhookTokenEnv: 'AGENT_KIT_TEST_WEBHOOK' })
    expect(svc().health().counters.loginOk).toBeNull() // webhook 不检查登录态
    const err = await svc().send({ markdown: 'secret body text' }).catch((e: unknown) => e)
    expect(isKitError(err)).toBe(true)
    expect(JSON.stringify((err as { toJSON(): unknown }).toJSON())).not.toContain('webhook-secret-token-123')
    expect(sendCalls()[0]!.args).toContain('--webhook-token=webhook-secret-token-123')
    const logs = t.logs.join('\n')
    expect(logs).not.toContain('webhook-secret-token-123')
    expect(logs).not.toContain('secret body text')
    expect(logs).toContain('prefer bot identity')
  })

  it('dryRun adds --dry-run and skips the login preflight', async () => {
    const { svc } = await setup({ identity: 'bot', robotCode: 'r', dryRun: true })
    const r = await svc().send({ text: 'x', target: { chatIds: ['a', 'b'] } })
    expect(r.results.every((x) => x.ok)).toBe(true)
    expect(dws.calls().some((c) => c.args[0] === 'auth')).toBe(false)
    expect(sendCalls()[0]!.args).toContain('--dry-run')
    expect(svc().health().detail).toBe('dry-run')
  })

  it('marks the service failed when dws is not logged in, and recovers', async () => {
    dws.setScenario({ auth: 'expired' })
    const { svc } = await setup({ identity: 'user', preflightIntervalMs: 0 })
    expect(svc().health()).toMatchObject({ status: 'failed', counters: { loginOk: false } })
    expect(t.failures).toEqual([expect.objectContaining({ service: 'dingtalk', detail: 'dws is not logged in' })])
    dws.setScenario({ auth: 'error' })
    expect(await svc().preflight()).toBe(false)
    expect(svc().health().detail).toContain('not logged in')
    expect(t.failures).toHaveLength(1)
    dws.setScenario({ auth: 'ok' })
    expect(await svc().preflight()).toBe(true)
    expect(svc().health().status).toBe('ok')
  })

  it('aborts in-flight sends when unloaded', async () => {
    dws.setScenario({ send: [{ mode: 'hang' }] })
    const { svc } = await setup({ identity: 'user', defaultTarget: { chatId: 'c' }, killGraceMs: 100 })
    const service = svc()
    const p = service.send({ text: 'x' })
    await until(() => dws.hangPids() !== undefined)
    await t.root.fiber.dispose()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
  })

  it('honours a caller signal', async () => {
    dws.setScenario({ send: [{ mode: 'hang' }] })
    const { svc } = await setup({ identity: 'user', defaultTarget: { chatId: 'c' }, killGraceMs: 100 })
    const controller = new AbortController()
    const p = svc().send({ text: 'x', signal: controller.signal, idempotencyKey: 'k' })
    await until(() => dws.hangPids() !== undefined)
    controller.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    expect(sendCalls()).toHaveLength(1)
  })
})
