import z from '@deepseek-ai/schemastery'
import { ConfigError, type ConfigInput } from '../common/errors.js'

export interface WsConfig {
  pingIntervalMs: number
  readTimeoutMs: number
  reconnect: {
    initialDelayMs: number
    maxDelayMs: number
    jitter: number
  }
  stableResetMs: number
  fatalRetryDelayMs: number
  maxPayloadBytes: number
  maxPendingMessages: number
}

const int = () => z.natural().step(1)

export const WsConfig: z<ConfigInput<WsConfig>, WsConfig> = z.object({
  pingIntervalMs: int().min(1000).default(30_000).description('WS ping 间隔'),
  readTimeoutMs: int().min(2000).default(75_000).description('读超时，需 ≥ 2 × pingIntervalMs'),
  reconnect: z
    .object({
      initialDelayMs: int().min(100).default(1000),
      maxDelayMs: int().min(100).default(60_000),
      jitter: z.number().min(0).max(1).default(0.2),
    })
    .default({ initialDelayMs: 1000, maxDelayMs: 60_000, jitter: 0.2 }),
  stableResetMs: int().default(60_000).description('连接稳定保持多久后重置退避'),
  fatalRetryDelayMs: int().default(300_000).description('fatal 后慢速重试间隔，0 表示不重试'),
  maxPayloadBytes: int().min(1024).max(104_857_600).default(1_048_576),
  maxPendingMessages: int().min(1).default(100),
}) as z<ConfigInput<WsConfig>, WsConfig>

/** schemastery 无法表达的跨字段约束。 */
export function assertWsConfig(config: WsConfig): WsConfig {
  if (config.readTimeoutMs < 2 * config.pingIntervalMs) {
    throw new ConfigError('agentWs', 'readTimeoutMs must be >= 2 * pingIntervalMs', { field: 'readTimeoutMs' })
  }
  if (config.reconnect.maxDelayMs < config.reconnect.initialDelayMs) {
    throw new ConfigError('agentWs', 'reconnect.maxDelayMs must be >= reconnect.initialDelayMs', { field: 'reconnect.maxDelayMs' })
  }
  if (config.fatalRetryDelayMs !== 0 && config.fatalRetryDelayMs < 10_000) {
    throw new ConfigError('agentWs', 'fatalRetryDelayMs must be 0 or >= 10000', { field: 'fatalRetryDelayMs' })
  }
  return config
}
