import { describe, expect, it } from 'vitest'
import type { ChannelService } from '../../src/common/channel.js'
import { KitError } from '../../src/common/errors.js'
import { deliver, requireLogin, requireLogout } from '../../src/notify/deliver.js'

const ok = (messageId: string): ChannelService => ({
  send: async () => ({ results: [{ ok: true, messageId }] }),
  status: async () => ({ channel: 'dingtalk', identity: 'bot', online: true, detail: 'ok', checkedAt: 0 }),
  health: () => ({ status: 'ok', detail: 'ok' }),
})

describe('deliver', () => {
  it('sends to every planned channel in parallel and keeps plan order', async () => {
    const seen: unknown[] = []
    const a: ChannelService = { ...ok('a1'), send: async (o) => { seen.push(o.target); return { results: [{ ok: true, messageId: 'a1' }] } } }
    const r = await deliver([
      { channel: 'a', service: a, target: { chatId: 'x' } },
      { channel: 'b', service: ok('b1') },
    ], { text: 'hi', idempotencyKey: 'k' })
    expect(r).toEqual([
      { channel: 'a', results: [{ ok: true, messageId: 'a1' }] },
      { channel: 'b', results: [{ ok: true, messageId: 'b1' }] },
    ])
    expect(seen).toEqual([{ chatId: 'x' }])
  })

  it('turns a missing channel and a throwing channel into failed results of that channel only', async () => {
    const kitFail: ChannelService = { ...ok('x'), send: async () => { throw new KitError('dingtalk', 'invalid_target', 'bad target', { retryable: false }) } }
    const rawFail: ChannelService = { ...ok('x'), send: async () => { throw new Error('boom') } }
    const r = await deliver([
      { channel: 'gone', service: undefined },
      { channel: 'kit', service: kitFail },
      { channel: 'raw', service: rawFail },
      { channel: 'fine', service: ok('f1') },
    ], { text: 'hi' })
    expect(r[0]!.results[0]).toMatchObject({ ok: false, error: { code: 'channel_unavailable' } })
    expect(r[1]!.results[0]).toMatchObject({ ok: false, error: { code: 'invalid_target' } })
    expect(r[2]!.results[0]).toMatchObject({ ok: false, error: { code: 'send_failed', retryable: true } })
    expect(r[3]!.results[0]).toEqual({ ok: true, messageId: 'f1' })
  })

  it('rejects login and logout on channels that do not implement them', () => {
    expect(() => requireLogin('bot', ok('x'))).toThrow(expect.objectContaining({ code: 'login_unsupported' }))
    expect(() => requireLogout('bot', ok('x'))).toThrow(expect.objectContaining({ code: 'login_unsupported' }))
    const withLogin: ChannelService = { ...ok('x'), login: async () => { throw new Error('called') } }
    expect(typeof requireLogin('user', withLogin)).toBe('function')
  })
})
