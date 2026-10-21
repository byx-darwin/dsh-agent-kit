import { describe, expect, it, vi } from 'vitest'
import { MessageRouter, MAX_QUEUE } from '../../src/common/inbox.js'
import type { ChannelAtMessage } from '../../src/common/channel.js'
import { until } from '../helpers.js'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const msg = (eventId: string, conversationId: string, content = ''): ChannelAtMessage => ({ eventId, conversationId, content })

function router(options: { pluginRoutes?: Map<string, string>; handlerTimeoutMs?: number } = {}) {
  const unmatched: ChannelAtMessage[] = []
  const r = new MessageRouter<ChannelAtMessage>({ channel: 'test', logger, onUnmatched: async (m) => { unmatched.push(m) }, ...options })
  return { r, unmatched }
}

describe('MessageRouter', () => {
  it('dispatches each message to the highest-priority matching route, then registration order', async () => {
    const { r, unmatched } = router()
    const got: string[] = []
    r.register({ conversationId: 'c1' }, () => { got.push('low-first') })
    r.register({ conversationId: 'c1' }, () => { got.push('low-second') })
    r.register({ conversationId: 'c1', priority: 5, match: (m) => m.content === 'vip' }, () => { got.push('high') })
    r.setReady(true)
    r.accept(msg('e1', 'c1', 'vip'))
    r.accept(msg('e2', 'c1', 'plain'))
    r.accept(msg('e3', 'c2', 'other'))
    await until(() => r.counters().received === 3 && r.counters().dispatched === 2 && unmatched.length === 1)
    expect(got).toEqual(['high', 'low-first'])
    expect(unmatched.map((m) => m.eventId)).toEqual(['e3'])
  })

  it('counts a throwing matcher as a handler error and tries the next route', async () => {
    const { r } = router()
    const got: string[] = []
    r.register({ conversationId: 'c1', priority: 1, match: () => { throw new Error('bad') } }, () => { got.push('never') })
    r.register({ conversationId: 'c1' }, () => { got.push('fallback') })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    await until(() => got.length === 1)
    expect(got).toEqual(['fallback'])
    expect(r.counters().handlerErrors).toBe(1)
  })

  it('sends configured conversations only to their plugin and treats a missing plugin as unmatched', async () => {
    const { r, unmatched } = router({ pluginRoutes: new Map([['c1', 'orders'], ['c2', 'absent']]) })
    const got: string[] = []
    r.register({ conversationId: 'c1' }, () => { got.push('route') })
    r.registerPlugin('orders', () => { got.push('plugin') })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    r.accept(msg('e2', 'c2'))
    await until(() => got.length === 1 && unmatched.length === 1)
    expect(got).toEqual(['plugin'])
    expect(() => r.registerPlugin('orders', () => {})).toThrow(/already registered/)
  })

  it('drops duplicate event IDs and counts unparsable input', async () => {
    const { r } = router()
    r.register({ conversationId: 'c1' }, () => {})
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    r.accept(msg('e1', 'c1'))
    r.drop()
    await until(() => r.counters().dispatched === 1)
    expect(r.counters()).toMatchObject({ received: 2, duplicate: 1, dropped: 1 })
  })

  it('queues before ready and drops once the queue is full', async () => {
    const { r } = router()
    const handler = vi.fn()
    r.register({ conversationId: 'c1' }, handler)
    for (let i = 0; i <= MAX_QUEUE; i++) r.accept(msg(`e${i}`, 'c1'))
    expect(handler).not.toHaveBeenCalled()
    expect(r.counters().dropped).toBe(1)
    r.setReady(true)
    await until(() => r.counters().dispatched === MAX_QUEUE)
  })

  it('times out a slow handler and keeps dispatching', async () => {
    const { r } = router({ handlerTimeoutMs: 20 })
    const got: string[] = []
    r.register({ conversationId: 'c1' }, (m) => m.eventId === 'slow' ? new Promise(() => {}) : void got.push(m.eventId))
    r.setReady(true)
    r.accept(msg('slow', 'c1'))
    r.accept(msg('fast', 'c1'))
    await until(() => got.length === 1)
    expect(r.counters()).toMatchObject({ handlerErrors: 1, dispatched: 1 })
  })

  it('aborts an in-flight handler when its route closes', async () => {
    const { r } = router()
    const signals: AbortSignal[] = []
    const close = r.register({ conversationId: 'c1' }, (_m, { signal }) => { signals.push(signal); return new Promise(() => {}) })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    await until(() => signals.length === 1)
    close()
    expect(signals[0]!.aborted).toBe(true)
    expect(r.size).toBe(0)
    close()
  })

  it('reset aborts the in-flight handler, clears the queue, and dispatch resumes after setReady(true)', async () => {
    const { r } = router()
    const signals: AbortSignal[] = []
    const seen: string[] = []
    r.register({ conversationId: 'c1' }, (m, { signal }) => {
      if (m.eventId === 'e1') { signals.push(signal); return new Promise(() => {}) }
      seen.push(m.eventId)
    })
    r.setReady(true)
    r.accept(msg('e1', 'c1'))
    r.accept(msg('e2', 'c1'))
    await until(() => signals.length === 1)
    r.reset()
    expect(signals[0]!.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([])
    r.setReady(true)
    r.accept(msg('e3', 'c1'))
    await until(() => seen.length === 1)
    expect(seen).toEqual(['e3'])
  })

  it('rejects invalid routes', () => {
    const { r } = router()
    expect(() => r.register({ conversationId: '' }, () => {})).toThrow(/conversationId is required/)
    expect(() => r.register({ conversationId: 'c1', priority: Infinity }, () => {})).toThrow(/priority must be finite/)
    expect(() => r.registerPlugin(' ', () => {})).toThrow(/pluginId is required/)
  })
})
