// 与 @typesafe-ai/sdk 0.6 的问题/答案结构保持一致。本包在主入口中重新定义这些类型与构造函数，
// 使未启用 jev 的项目无需安装 SDK；实际请求仍由 SDK 发送。

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** 文本、JSON 对象或数组，或 `null`。 */
export type EntryType = string | { [key: string]: JsonValue } | JsonValue[] | null

export interface NoulQuestion {
  type: 'noul'
  instructions?: EntryType
  criteria?: { true?: EntryType; false?: EntryType } | null
}

export type ChoiceCriteria = { [label: string]: EntryType }

export interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
  type: 'choice'
  instructions?: EntryType
  criteria: T
}

export type ScoreCriteria = readonly [EntryType, EntryType, ...EntryType[]]

export interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
  type: 'score'
  instructions?: EntryType
  criteria: T
}

export type Question = NoulQuestion | ScoreQuestion | ChoiceQuestion

export interface Questions {
  [name: string]: Question
}

/** 是/否问题的答案。`noul` 为回答"是"（true）的概率，范围 [0, 1]。 */
export interface NoulResponse {
  readonly type: 'noul'
  readonly noul: number
}

/** 选择题答案：选中的标签、置信度与各标签概率。 */
export interface ChoiceResponse<T extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: 'choice'
  readonly choice: keyof T & string
  readonly confidence: number
  readonly probabilities: { readonly [label in keyof T]: number }
}

export type ScoreOf<T extends ScoreCriteria> = number extends T['length'] ? number : Extract<keyof T, `${number}`>

/** 评分题答案：期望分数（可能介于整数档位之间）、置信度、评分标准与各档概率。 */
export interface ScoreResponse<T extends ScoreCriteria = ScoreCriteria> {
  readonly type: 'score'
  readonly score: number
  readonly confidence: number
  readonly legend: { readonly [score in ScoreOf<T>]: T[score] }
  readonly probabilities: { readonly [score in ScoreOf<T>]: number }
}

export type ResultFor<T extends Question> = T extends NoulQuestion
  ? NoulResponse
  : T extends ScoreQuestion<infer S>
    ? ScoreResponse<S>
    : T extends ChoiceQuestion<infer E>
      ? ChoiceResponse<E>
      : never

export type Answers<Q extends Questions> = { readonly [K in keyof Q]: ResultFor<Q[K]> }

export interface JevUsage {
  readonly input_tokens: number
  readonly output_tokens: number
}

/** 是/否问题。 */
export const noul = (instructions: EntryType = null, criteria?: NoulQuestion['criteria']): NoulQuestion => ({
  type: 'noul',
  instructions,
  ...(criteria !== undefined ? { criteria } : {}),
})

/** 按有序评分标准打分，至少两档，下标即分数。 */
export const score = <const T extends ScoreCriteria>(instructions: EntryType, criteria: T): ScoreQuestion<T> => ({
  type: 'score',
  instructions,
  criteria,
})

/** 在命名选项之间选择。 */
export const choice = <const T extends ChoiceCriteria>(instructions: EntryType, criteria: T): ChoiceQuestion<T> => ({
  type: 'choice',
  instructions,
  criteria,
})
