import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Ajv, type JSONSchemaType, type ValidateFunction } from 'ajv'
import { raceAbort } from '../common/abort.js'
import { ConfigError, KitError } from '../common/errors.js'
import { digest, redact } from '../common/redact.js'
import { KitService, type ServiceHealth } from '../common/service.js'
import { AgentTasksConfig, permissionAllows, type Permissions } from './config.js'
import { extractJson } from './extract-json.js'
import { ConcurrencyQueue, QueueAbortedError, QueueFullError } from './queue.js'
import type { ContentBlock, SubagentResult, SubagentRuntime, SubagentStartRequest } from './subagent-types.js'
import { renderPrompt, type PromptPart } from './untrusted.js'

export type AgentTaskErrorCode = 'provider_failed' | 'timeout' | 'invalid_output' | 'aborted' | 'queue_full' | 'unsupported_permissions'

export class AgentTaskError extends KitError {
  declare readonly code: AgentTaskErrorCode
  constructor(code: AgentTaskErrorCode, message: string, options: { retryable?: boolean; cause?: unknown; details?: Record<string, unknown> } = {}) {
    super('agentTasks', code, message, { retryable: options.retryable ?? (code === 'timeout' || code === 'queue_full'), ...options })
    this.name = 'AgentTaskError'
  }
}

export type AgentTaskEvent =
  | { type: 'queued'; taskId: string }
  | { type: 'started'; taskId: string; sessionId: string }
  | { type: 'finished'; taskId: string; outcome: 'ok' | AgentTaskErrorCode; durationMs: number }

interface RunOptionsBase {
  /** `ctx.subagents` 中已注册的 provider 名称，例如 `claude-code`、`codex`。 */
  provider: string
  title: string
  prompt: string | readonly PromptPart[]
  model?: string
  permissions?: Permissions
  timeoutMs?: number
  signal?: AbortSignal
  traceId?: string
  onEvent?: (event: AgentTaskEvent) => void
}

export interface RunOptionsWithSchema<T> extends RunOptionsBase {
  outputSchema: JSONSchemaType<T>
}

export interface AgentTaskResult<T> {
  sessionId: string
  taskId: string
  text: string
  output: T
  durationMs: number
}

export interface AgentTasksCounters {
  running: number
  queued: number
  completed: Partial<Record<'ok' | AgentTaskErrorCode, number>>
  durationMs: { count: number; p50: number | null; p95: number | null; max: number | null }
}

const DURATION_WINDOW = 200

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTasks: AgentTasksService
  }
}

export function outputText(output: readonly ContentBlock[]): string {
  return output
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function classifyDiagnostic(diagnostic: string | undefined): { retryable: boolean; auth: boolean } {
  const text = diagnostic ?? ''
  if (/rate.?limit|429|overloaded|too many requests|capacity/i.test(text)) return { retryable: true, auth: false }
  if (/unauthori[sz]ed|authenticat|401|403|log ?in|credential|api.?key|forbidden/i.test(text)) return { retryable: false, auth: true }
  return { retryable: false, auth: false }
}

export class AgentTasksService extends KitService<AgentTasksCounters> {
  static Config = AgentTasksConfig
  static inject = ['subagents']
  readonly config: AgentTasksConfig
  readonly workspaceDir: string
  private readonly queue: ConcurrencyQueue
  private readonly controller = new AbortController()
  private readonly ajv = new Ajv({ strict: false, allErrors: true })
  private readonly validators = new WeakMap<object, ValidateFunction>()
  private readonly completed: AgentTasksCounters['completed'] = {}
  private readonly durations: number[] = []
  private readonly warnedProviders = new Set<string>()

  constructor(ctx: Context, config: AgentTasksConfig) {
    super(ctx, 'agentTasks')
    this.config = config
    if (!isAbsolute(config.workspaceDir)) throw new ConfigError('agentTasks', 'workspaceDir must be an absolute path', { field: 'workspaceDir' })
    this.workspaceDir = resolve(config.workspaceDir)
    const rel = relative(this.workspaceDir, process.cwd())
    // 工作目录不能是当前进程目录或其祖先（通常是业务代码目录）
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new ConfigError('agentTasks', 'workspaceDir must be a dedicated directory, not the process working directory or its ancestor', { field: 'workspaceDir' })
    }
    this.queue = new ConcurrencyQueue(config.maxConcurrency, config.maxQueueSize)
    ctx.effect(
      () => () => {
        this.controller.abort()
        this.queue.rejectAll(new AgentTaskError('aborted', 'service disposed'))
      },
      'agentTasks.abortAll',
    )
  }

  async [Service.init](): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true, mode: 0o700 })
  }

  private get subagents(): SubagentRuntime {
    return (this.ctx as unknown as { subagents: SubagentRuntime }).subagents
  }

  run<T>(options: RunOptionsWithSchema<T>): Promise<AgentTaskResult<T>>
  run(options: RunOptionsBase): Promise<AgentTaskResult<undefined>>
  async run<T>(options: RunOptionsBase & { outputSchema?: JSONSchemaType<T> }): Promise<AgentTaskResult<T | undefined>> {
    const taskId = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
    const traceId = options.traceId
    const started = Date.now()
    const emit = (event: AgentTaskEvent) => {
      try {
        options.onEvent?.(event)
      } catch (e) {
        this.logger.warn('onEvent threw', { traceId, error: e })
      }
    }
    const finish = (outcome: 'ok' | AgentTaskErrorCode) => {
      const durationMs = Date.now() - started
      this.completed[outcome] = (this.completed[outcome] ?? 0) + 1
      this.durations.push(durationMs)
      if (this.durations.length > DURATION_WINDOW) this.durations.shift()
      emit({ type: 'finished', taskId, outcome, durationMs })
      return durationMs
    }
    const fail = (err: AgentTaskError): never => {
      finish(err.code)
      this.logger.warn('agent task failed', { traceId, taskId, provider: options.provider, code: err.code, error: err })
      throw err
    }

    if (options.signal?.aborted) fail(new AgentTaskError('aborted', 'aborted before start'))
    const permissions = options.permissions ?? 'read-only'
    const provider = this.subagents.getProvider(options.provider)
    if (!provider) fail(new AgentTaskError('provider_failed', `subagent provider ${JSON.stringify(options.provider)} is not registered`))
    const toolFilter = provider!.capabilities.toolFilter ? { allow: [...this.config.toolAllowlist[permissions]] } : undefined
    if (!toolFilter) {
      const declared = this.config.declaredPermissions[options.provider]
      if (!declared || !permissionAllows(declared, permissions)) {
        fail(
          new AgentTaskError(
            'unsupported_permissions',
            `provider ${options.provider} cannot enforce ${permissions}; declare its configured permission level in declaredPermissions`,
          ),
        )
      }
      if (!this.warnedProviders.has(options.provider)) {
        this.warnedProviders.add(options.provider)
        this.logger.info('provider has no tool filter; relying on declared permission level', { provider: options.provider, declared })
      }
    }
    const validate = options.outputSchema ? this.validator(options.outputSchema) : undefined
    const nativeSchema = !!options.outputSchema && provider!.capabilities.outputSchema && options.outputSchema.type === 'object'

    emit({ type: 'queued', taskId })
    let release: () => void
    try {
      release = await this.queue.acquire(options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal)
    } catch (e) {
      if (e instanceof QueueFullError) return fail(new AgentTaskError('queue_full', `queue is full (${this.config.maxQueueSize})`))
      if (e instanceof QueueAbortedError || (e as KitError).code === 'aborted') return fail(new AgentTaskError('aborted', 'aborted while queued'))
      throw e
    }

    const taskDir = join(this.workspaceDir, taskId)
    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const signals = [timeout.signal, this.controller.signal]
    if (options.signal) signals.push(options.signal)
    const signal = AbortSignal.any(signals)
    const abortedCode = (): AgentTaskErrorCode => (timeout.signal.aborted ? 'timeout' : 'aborted')

    try {
      await mkdir(taskDir, { recursive: false, mode: 0o700 })
      let promptText = renderPrompt(options.prompt)
      if (options.outputSchema && !nativeSchema) {
        promptText += [
          '',
          '',
          'When you are done, reply with your final answer as a single JSON value inside one ```json code block.',
          'The JSON value MUST conform to this JSON Schema:',
          '```',
          JSON.stringify(options.outputSchema),
          '```',
        ].join('\n')
      }
      const request: SubagentStartRequest = {
        label: options.title,
        prompt: [{ type: 'text', text: promptText }],
        parent: { id: `agent-kit-${taskId}`, session: { id: `agent-kit-${taskId}`, header: { cwd: taskDir } } },
        signal,
        ...(options.model && provider!.capabilities.agentOptions ? { agentOptions: { model: options.model } } : {}),
        ...(nativeSchema ? { outputSchema: options.outputSchema as object } : {}),
        ...(toolFilter ? { toolFilter } : {}),
      }
      this.logger.info('agent task started', { traceId, taskId, provider: options.provider, title: options.title, permissions, prompt: digest(promptText) })

      let result: SubagentResult
      let sessionId: string
      try {
        const run = await this.subagents.start(options.provider, request)
        sessionId = run.id
        emit({ type: 'started', taskId, sessionId })
        try {
          result = await raceAbort(run.result, signal, () =>
            abortedCode() === 'timeout' ? new AgentTaskError('timeout', `task timed out after ${timeoutMs}ms`) : new AgentTaskError('aborted', 'task aborted'),
          )
        } finally {
          await run.dispose().catch((e: unknown) => this.logger.warn('failed to dispose subagent run', { traceId, taskId, error: e }))
        }
      } catch (e) {
        if (e instanceof AgentTaskError) return fail(e)
        if (signal.aborted) return fail(new AgentTaskError(abortedCode(), 'task aborted'))
        return fail(new AgentTaskError('provider_failed', `provider failed: ${(e as Error)?.message ?? String(e)}`, { retryable: true, cause: e }))
      }

      if (result.stopReason === 'aborted' || signal.aborted) {
        return fail(new AgentTaskError(signal.aborted ? abortedCode() : 'aborted', 'task aborted'))
      }
      if (result.stopReason !== 'completed') {
        const cls = classifyDiagnostic(result.diagnostic)
        if (cls.auth) this.markFailed(`provider ${options.provider} authentication failed`)
        return fail(
          new AgentTaskError('provider_failed', `provider stopped with ${result.stopReason}${result.diagnostic ? `: ${redact(result.diagnostic, 500)}` : ''}`, {
            retryable: cls.retryable,
            details: { stopReason: result.stopReason },
          }),
        )
      }
      this.clearFailed()

      const text = outputText(result.output)
      let output: unknown
      if (options.outputSchema) {
        let value: unknown
        if (nativeSchema && result.structured !== undefined) {
          value = result.structured
        } else {
          const extracted = extractJson(text)
          if (!extracted.ok) {
            return fail(new AgentTaskError('invalid_output', `invalid output: ${extracted.reason}`, { details: { answer: digest(text) } }))
          }
          value = extracted.value
        }
        if (!validate!(value)) {
          return fail(new AgentTaskError('invalid_output', `output does not match schema: ${this.ajv.errorsText(validate!.errors)}`, { details: { answer: digest(text) } }))
        }
        output = value
      }
      const durationMs = finish('ok')
      this.logger.info('agent task finished', { traceId, taskId, durationMs, answer: digest(text) })
      return { sessionId, taskId, text, output: output as T | undefined, durationMs }
    } finally {
      clearTimeout(timer)
      release()
      if (!this.config.keepWorkdir) {
        await rm(taskDir, { recursive: true, force: true }).catch((e: unknown) => this.logger.warn('failed to remove task directory', { taskId, error: e }))
      }
    }
  }

  private validator(schema: object): ValidateFunction {
    let fn = this.validators.get(schema)
    if (!fn) {
      fn = this.ajv.compile(schema)
      this.validators.set(schema, fn)
    }
    return fn
  }

  health(): ServiceHealth<AgentTasksCounters> {
    const sorted = [...this.durations].sort((a, b) => a - b)
    const pick = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null)
    const counters: AgentTasksCounters = {
      running: this.queue.runningCount,
      queued: this.queue.queuedCount,
      completed: { ...this.completed },
      durationMs: { count: sorted.length, p50: pick(0.5), p95: pick(0.95), max: sorted.length ? sorted[sorted.length - 1]! : null },
    }
    if (this.failure) return { status: 'failed', detail: this.failure, counters }
    if (this.config.maxQueueSize > 0 && counters.queued >= this.config.maxQueueSize) {
      return { status: 'degraded', detail: 'queue is full', counters }
    }
    return { status: 'ok', detail: `${counters.running} running, ${counters.queued} queued`, counters }
  }
}

export default AgentTasksService
