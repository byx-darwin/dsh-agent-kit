import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSendArgs } from '../../src/dingtalk/args.js'
import { DingtalkConfig } from '../../src/dingtalk/config.js'
import { parseDwsDeviceLogin, DingtalkService } from '../../src/dingtalk/service.js'
import { parseRecipientSearch } from '../../src/dingtalk/recipients.js'
import { parseErrorOutput, parseSendOutput } from '../../src/dingtalk/output.js'
import { createFakeDws } from '../../src/testing/fake-dws.js'
import { createRoot, type TestRoot } from '../helpers.js'

describe('DingTalk user-only send', () => {
  it('rejects removed identities', () => {
    expect(() => DingtalkConfig({ identity: 'bot' } as never)).toThrow()
    expect(() => DingtalkConfig({ identity: 'webhook' } as never)).toThrow()
    expect(DingtalkConfig({}).identity).toBe('user')
  })

  it('builds safe user arguments for group and single chat', () => {
    expect(buildSendArgs({ identity: 'user', target: { chatId: 'cidABC' }, text: 'hello', idempotencyKey: 'evt_1', dryRun: false }).args)
      .toEqual(['chat', '+messages-send', '--as=user', '--chat-id=cidABC', '--text=hello', '--idempotency-key=evt_1', '--yes', '--format=json'])
    expect(buildSendArgs({ identity: 'user', target: { userId: 'u1' }, text: 'hi', dryRun: true }).args).toContain('--user=u1')
    expect(buildSendArgs({ identity: 'user', target: { openDingtalkId: '$:LWCP_v1:$abc' }, text: 'hi', dryRun: true }).args).toContain('--open-dingtalk-id=$:LWCP_v1:$abc')
    expect(() => buildSendArgs({ identity: 'user', target: { chatId: '--yes' }, text: 'x', dryRun: false })).toThrow(/invalid chatId/)
    expect(() => buildSendArgs({ identity: 'user', text: 'x', dryRun: false })).toThrow(/target is required/)
  })

  it('parses single-send and dry-run results', () => {
    expect(parseSendOutput('{"ok":true,"result":{"messageId":"msg-1"}}', [{ chatId: 'cidA' }])).toMatchObject([{ ok: true, messageId: 'msg-1' }])
    expect(parseSendOutput('{"dry_run":true}', [{ chatId: 'cidA' }])).toMatchObject([{ ok: true }])
    expect(parseSendOutput('{"ok":false,"error":{"message":"denied"}}', [{ chatId: 'cidA' }])[0]?.error?.message).toBe('denied')
    expect(parseErrorOutput('{"error":{"category":"network","message":"down"}}')).toEqual({ category: 'network', message: 'down' })
  })

  it('parses a device-login link', () => {
    expect(parseDwsDeviceLogin('https://example.com/device?user_code=123 authorization code: 123 expire in 300 seconds')).toMatchObject({ userCode: '123', ttlMs: 300000 })
  })

  it('keeps stable recipient IDs and rejects unknown search responses', () => {
    expect(parseRecipientSearch('group', JSON.stringify({ chats: [
      { openConversationId: 'cidA', title: '研发群' }, { openConversationId: 'cidA', title: '研发群' },
    ], complete: true, hasMore: false }))).toEqual({ candidates: [{ name: '研发群', target: { chatId: 'cidA' } }], complete: true })
    expect(parseRecipientSearch('user', JSON.stringify({ success: true, result: [{ userId: 'uA', title: '张三' }, { openDingTalkId: 'openB', name: '李四' }] })))
      .toEqual({ candidates: [{ name: '张三', target: { userId: 'uA' } }, { name: '李四', target: { openDingtalkId: 'openB' } }], complete: false })
    expect(() => parseRecipientSearch('group', '{}')).toThrow(/unexpected result shape/)
  })
})

describe('DingtalkService', () => {
  let root: TestRoot
  let dws: ReturnType<typeof createFakeDws>
  const savedEnv = { ...process.env }
  beforeEach(() => {
    root = createRoot()
    dws = createFakeDws()
    process.env.DWS_CONFIG_DIR = dws.dir
  })
  afterEach(async () => {
    await root.dispose()
    dws.cleanup()
    process.env = { ...savedEnv }
  })

  it('checks user login and sends through dws', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, defaultTarget: { chatId: 'cidA' } })
    const service = root.root.get('dingtalk')!
    expect(await service.status()).toMatchObject({ identity: 'user', online: true })
    expect((await service.send({ text: 'hello' })).results[0]).toMatchObject({ ok: true })
    expect(dws.calls().some((call) => call.args.includes('--as=user'))).toBe(true)
  })

  it('allows dry-run without login preflight', async () => {
    await root.root.plugin(DingtalkService, { dwsPath: dws.path, dryRun: true, defaultTarget: { chatId: 'cidA' } })
    expect((await root.root.get('dingtalk')!.send({ text: 'hello' })).results[0]?.ok).toBe(true)
    expect(dws.calls().some((call) => call.args[0] === 'auth')).toBe(false)
  })

  it('searches group and personal recipients using the same logged-in profile', async () => {
    dws.setScenario({ groupSearch: [{ openConversationId: 'cidA', title: '研发群' }], personSearch: [{ userId: 'uA', title: '张三' }] })
    await root.root.plugin(DingtalkService, { dwsPath: dws.path })
    const service = root.root.get('dingtalk')!
    expect(await service.searchRecipients('group', '研发')).toEqual({ candidates: [{ name: '研发群', target: { chatId: 'cidA' } }], complete: true })
    expect(await service.searchRecipients('user', '张三')).toEqual({ candidates: [{ name: '张三', target: { userId: 'uA' } }], complete: true })
    const searches = dws.calls().filter((call) => call.args[1] === '+chat-search' || call.args[0] === 'aisearch')
    expect(searches).toHaveLength(2)
    expect(searches.every((call) => call.args.slice(-2).join(' ') === '--profile dingcorp:u1')).toBe(true)
    await expect(service.searchRecipients('group', 'x')).rejects.toThrow(/2–80/)
  })
})
