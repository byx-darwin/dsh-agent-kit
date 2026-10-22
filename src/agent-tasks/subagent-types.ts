// dsh-subagent 中本包用到的部分的结构化类型。这里不 import @deepseek-ai/dsh-subagent，
// 避免强制依赖，也避免与其 Context 类型扩展冲突。

export interface TextBlock {
  type: 'text'
  text: string
}

export type ContentBlock = TextBlock | { type: string; [key: string]: unknown }

export interface ToolRestriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

export interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | (string & {})

export interface AgentTaskUsage {
  /** Uncached input; cache reads are separate and must not be counted twice. */
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface SubagentResult {
  readonly usage?: AgentTaskUsage
  readonly output: ContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: SubagentStopReason
}

export interface SubagentRun {
  readonly id: string
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

/** 作为父 Agent 传入的最小结构：provider 只读取 `session.header.cwd`。 */
export interface ParentAgentStub {
  readonly id: string
  readonly session: { readonly id: string; readonly header: { readonly cwd: string } }
}

export interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]
  readonly parent: ParentAgentStub
  readonly signal: AbortSignal
  readonly agentOptions?: { model?: string }
  readonly outputSchema?: object
  readonly toolFilter?: ToolRestriction
}

export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  /**
   * 一次性执行。dsh 0.1 由运行时转调并附带 `descriptor`；dsh 0.2 起本包直接调用，并按 0.2 的
   * `ResolvedSubagentStartRequest` 附带绝对路径 `cwd`。0.2 中只支持可续接会话的 provider 没有此方法。
   */
  start?(request: SubagentStartRequest & { descriptor?: unknown; cwd?: string }): Promise<SubagentRun>
}

export interface SubagentRuntime {
  getProvider(name: string): SubagentProvider | undefined
  list(): string[]
  /** dsh 0.1 才有；0.2 改为面向会话的 `startActivation()`，本包改为直接调用 provider 的 `start()`。 */
  start?(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}
