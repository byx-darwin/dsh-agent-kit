import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WsConfig } from '../../src/ws/config'
import { DingtalkConfig } from '../../src/dingtalk/config'
import { AgentTasksConfig } from '../../src/agent-tasks/config'
import { JevConfig } from '../../src/jev/service'
import { configRows } from '../src/data/config-tables'
import { SERVICES } from '../src/data/services'

const leafPaths = (schema: any, prefix = ''): string[] =>
  schema.type === 'object'
    ? Object.entries(schema.dict).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k))
    : [prefix]

describe('config tables', () => {
  it.each([
    ['agentWs', WsConfig],
    ['dingtalk', DingtalkConfig],
    ['agentTasks', AgentTasksConfig],
    ['jev', JevConfig],
  ] as const)('%s rows cover exactly the schema leaf fields', (id, schema) => {
    expect(configRows(id).map((r) => r.path).sort()).toEqual(leafPaths(schema).sort())
  })

  it('renders defaults and ranges from the schema', () => {
    const dt = Object.fromEntries(configRows('dingtalk').map((r) => [r.path, r]))
    expect(dt.timeoutMs).toMatchObject({ default: '15000', range: '[1000, 120000]' })
    expect(dt['retry.maxAttempts']).toMatchObject({ default: '2', range: '[0, 5]' })
    expect(dt.identity).toMatchObject({ required: true, range: 'user | bot | webhook', default: '—' })
    const at = Object.fromEntries(configRows('agentTasks').map((r) => [r.path, r]))
    expect(at.maxConcurrency).toMatchObject({ default: '2', range: '[1, 16]' })
    expect(at.workspaceDir.required).toBe(true)
    const ws = Object.fromEntries(configRows('agentWs').map((r) => [r.path, r]))
    expect(ws['reconnect.jitter']).toMatchObject({ default: '0.2', range: '[0, 1]' })
    expect(ws.pingIntervalMs.range).toBe('≥ 1000')
  })

  it('every row has a description (schema description or services.ts fallback)', () => {
    for (const s of SERVICES) for (const r of configRows(s.id)) expect(r.description, `${s.id}.${r.path}`).not.toBe('')
  })

  it('services metadata is complete and ordered', () => {
    expect(SERVICES.map((s) => [s.numeral, s.id])).toEqual([
      ['壹', 'agentWs'],
      ['贰', 'dingtalk'],
      ['叁', 'agentTasks'],
      ['肆', 'jev'],
    ])
    for (const s of SERVICES) expect(s.errors.length).toBeGreaterThan(0)
  })

  it('error codes exist in the source files', () => {
    const sources: Record<string, string> = {
      agentWs: 'src/ws/connection.ts',
      dingtalk: 'src/dingtalk/errors.ts',
      agentTasks: 'src/agent-tasks/service.ts',
      jev: 'src/jev/service.ts',
    }
    for (const s of SERVICES) {
      const text = readFileSync(new URL(`../../${sources[s.id]}`, import.meta.url), 'utf8')
      for (const e of s.errors) if (e.code !== 'invalid_config') expect(text, `${s.id}:${e.code}`).toContain(`'${e.code}'`)
    }
  })
})
