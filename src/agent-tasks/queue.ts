export class QueueFullError extends Error {}
export class QueueAbortedError extends Error {}

interface Waiter {
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * FIFO 并发槽：同时最多 `maxConcurrency` 个持有者，其余排队；
 * 排队数达到 `maxQueueSize` 时新请求立即以 {@link QueueFullError} 失败。
 * 排队期中止的请求被移出队列，不占用并发槽。
 */
export class ConcurrencyQueue {
  private running = 0
  private readonly waiters: Waiter[] = []

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueueSize: number,
  ) {}

  get runningCount(): number {
    return this.running
  }

  get queuedCount(): number {
    return this.waiters.length
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new QueueAbortedError('aborted before start'))
    if (this.running < this.maxConcurrency && this.waiters.length === 0) {
      this.running++
      return Promise.resolve(this.releaser())
    }
    if (this.waiters.length >= this.maxQueueSize) return Promise.reject(new QueueFullError('queue full'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new QueueAbortedError('aborted while queued'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  /** 拒绝所有排队中的请求（卸载时调用）。 */
  rejectAll(err: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.reject(err)
    }
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
        next.resolve(this.releaser())
      } else {
        this.running--
      }
    }
  }
}
