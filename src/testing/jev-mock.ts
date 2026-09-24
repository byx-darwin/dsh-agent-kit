import { JevService, type JevClient, type JevClientFactory } from '../jev/service.js'
import type { EntryType, JevUsage, Questions } from '../jev/types.js'

export interface JevMockRequest {
  state: EntryType
  questions: Questions
  model?: string
}

export type JevMockHandler = (
  request: JevMockRequest,
  options: { signal?: AbortSignal },
) => Record<string, unknown> | Promise<Record<string, unknown>>

/** 为每个问题生成一个确定的默认答案（noul 0.5、choice 第一个选项、score 0 分）。 */
export function defaultAnswers(questions: Questions): Record<string, unknown> {
  const answers: Record<string, unknown> = {}
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'noul') answers[name] = { type: 'noul', noul: 0.5 }
    else if (q.type === 'choice') {
      const labels = Object.keys(q.criteria)
      answers[name] = {
        type: 'choice',
        choice: labels[0],
        confidence: 1,
        probabilities: Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 1 : 0])),
      }
    } else {
      const levels = q.criteria.map((_, i) => String(i))
      answers[name] = {
        type: 'score',
        score: 0,
        confidence: 1,
        legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
        probabilities: Object.fromEntries(levels.map((l, i) => [l, i === 0 ? 1 : 0])),
      }
    }
  }
  return answers
}

export interface JevMock {
  readonly requests: JevMockRequest[]
  handler: JevMockHandler
  factory: JevClientFactory
  /** 把 JevService 的客户端工厂替换为本 mock；返回恢复函数。 */
  install(): () => void
}

/** 创建 Jev mock。handler 抛出带 `status` 的错误可模拟 HTTP 错误（例如 `{ status: 429 }`）。 */
export function createJevMock(handler: JevMockHandler = (req) => defaultAnswers(req.questions)): JevMock {
  const requests: JevMockRequest[] = []
  const mock: JevMock = {
    requests,
    handler,
    factory: async ({ model }) => {
      const client: JevClient = {
        systemOne: async (request, options = {}) => {
          requests.push(request)
          const answers = await mock.handler(request, options)
          const usage: JevUsage = { input_tokens: 1, output_tokens: 1 }
          return { model: request.model ?? model, answers, usage }
        },
      }
      return client
    },
    install() {
      const previous = JevService.clientFactory
      JevService.clientFactory = mock.factory
      return () => {
        JevService.clientFactory = previous
      }
    },
  }
  return mock
}

/** 构造一个带 HTTP 状态的错误，模拟 SDK 的 APIError。 */
export function jevHttpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.name = status === 429 ? 'RateLimitError' : status >= 500 ? 'InternalServerError' : 'APIError'
  err.status = status
  return err
}
