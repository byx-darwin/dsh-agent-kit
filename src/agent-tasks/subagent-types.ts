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

export interface SubagentResult {
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
  start(request: SubagentStartRequest & { descriptor: unknown }): Promise<SubagentRun>
}

export interface SubagentRuntime {
  getProvider(name: string): SubagentProvider | undefined
  list(): string[]
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}
