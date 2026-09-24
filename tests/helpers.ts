import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { ServiceFailedEvent } from '../src/common/service.js'

export interface TestRoot {
  root: Context
  logs: string[]
  failures: ServiceFailedEvent[]
  dispose(): Promise<void>
}

/** 创建一个 cordis 根上下文，捕获全部日志与 `agent-kit/service-failed` 事件。 */
export function createRoot(): TestRoot {
  const root = new Context()
  const logs: string[] = []
  const failures: ServiceFailedEvent[] = []
  root.logger.exporter({
    // cordis 默认只导出 error / info，测试中捕获全部级别
    levels: { default: 3 },
    export(message) {
      logs.push(`[${message.type}] ${message.name} ${format(...(message.args as [unknown, ...unknown[]]))}`)
    },
  })
  root.on('agent-kit/service-failed', (event) => {
    failures.push(event)
  })
  return {
    root,
    logs,
    failures,
    dispose: async () => {
      await root.fiber.dispose()
    },
  }
}

/** 不依赖（可能被伪造的）定时器，轮询直到条件成立。 */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000, message = 'condition not met'): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`until(): ${message}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** 在伪造定时器下推进时间，并让 I/O 回调有机会执行。 */
export async function flushIo(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
