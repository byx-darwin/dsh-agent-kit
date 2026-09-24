import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ContentBlock,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentRuntime,
  SubagentStartRequest,
} from '../agent-tasks/subagent-types.js'

export type FakeSubagentHandler = (
  request: SubagentStartRequest,
  context: { signal: AbortSignal; cwd: string },
) => SubagentResult | string | Promise<SubagentResult | string>

export interface FakeSubagentProviderOptions {
  name?: string
  capabilities?: Partial<SubagentCapabilities>
  /** 返回字符串时视为 `stopReason: 'completed'` 的文本答案。 */
  handler?: FakeSubagentHandler
}

const NO_CAPABILITIES: SubagentCapabilities = { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false }

let runSeq = 0

/**
 * 假 subagent provider：结构与 dsh-subagent 的 `SubagentProvider` 一致，
 * 可注册到真实的 `ctx.subagents`（`ctx.subagents.registerProvider(provider)`）或 {@link FakeSubagentRuntime}。
 */
export class FakeSubagentProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext = false
  readonly requests: SubagentStartRequest[] = []
  handler: FakeSubagentHandler
  /** 当前运行中的任务数。 */
  running = 0
  maxRunning = 0

  constructor(options: FakeSubagentProviderOptions = {}) {
    this.name = options.name ?? 'fake'
    this.capabilities = { ...NO_CAPABILITIES, ...options.capabilities }
    this.handler = options.handler ?? (() => 'ok')
  }

  async start(request: SubagentStartRequest & { descriptor?: unknown }): Promise<SubagentRun> {
    this.requests.push(request)
    this.running++
    this.maxRunning = Math.max(this.maxRunning, this.running)
    const signal = request.signal
    const cwd = request.parent.session.header.cwd
    const result = (async (): Promise<SubagentResult> => {
      try {
        const aborted = new Promise<SubagentResult>((resolve) => {
          if (signal.aborted) resolve({ output: [], stopReason: 'aborted' })
          signal.addEventListener('abort', () => resolve({ output: [], stopReason: 'aborted' }), { once: true })
        })
        const handled = Promise.resolve(this.handler(request, { signal, cwd })).then((r) =>
          typeof r === 'string' ? { output: [{ type: 'text', text: r } as ContentBlock], stopReason: 'completed' as const } : r,
        )
        return await Promise.race([handled, aborted])
      } finally {
        this.running--
      }
    })()
    return {
      id: `fake-run-${++runSeq}`,
      result,
      dispose: async () => {},
    }
  }
}

/**
 * 没有安装 dsh-subagent 时使用的最小 `ctx.subagents` 实现，仅供测试与本地开发。
 * 真实 dsh 中请使用 `@deepseek-ai/dsh-subagent`。
 */
export class FakeSubagentRuntime extends Service implements SubagentRuntime {
  private readonly providers = new Map<string, SubagentProvider>()

  constructor(ctx: Context, config: { providers?: SubagentProvider[] } = {}) {
    super(ctx, 'subagents')
    for (const p of config.providers ?? []) this.providers.set(p.name, p)
  }

  registerProvider(provider: SubagentProvider): () => void {
    if (this.providers.has(provider.name)) throw new Error(`duplicate provider ${provider.name}`)
    this.providers.set(provider.name, provider)
    return () => this.providers.delete(provider.name)
  }

  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  list(): string[] {
    return [...this.providers.keys()]
  }

  start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (!provider) return Promise.reject(new Error(`no provider ${name}`))
    return provider.start({ ...request, descriptor: { mode: 'one-shot', provider: name, label: request.label } })
  }
}
