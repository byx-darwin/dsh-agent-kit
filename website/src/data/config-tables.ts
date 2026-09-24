// 由本包源码中的 schemastery schema 生成配置项表，避免网站与代码脱节。
import { WsConfig } from '../../../src/ws/config'
import { DingtalkConfig } from '../../../src/dingtalk/config'
import { FeishuConfig } from '../../../src/feishu/config'
import { NotifyConfig } from '../../../src/notify/config'
import { AgentTasksConfig } from '../../../src/agent-tasks/config'
import { JevConfig } from '../../../src/jev/service'
import { service, type ServiceId } from './services'

export interface ConfigRow {
  path: string
  type: string
  default: string
  range: string
  description: string
  required: boolean
}

/** schemastery schema 在运行时的结构中本文件用到的部分。 */
interface SchemaNode {
  type: string
  dict?: Record<string, SchemaNode>
  list?: SchemaNode[]
  inner?: SchemaNode
  value?: unknown
  meta?: {
    default?: unknown
    min?: number
    max?: number
    pattern?: { source: string }
    description?: string
    required?: boolean
  }
}

const SCHEMAS: Record<ServiceId, SchemaNode> = {
  agentWs: WsConfig as unknown as SchemaNode,
  dingtalk: DingtalkConfig as unknown as SchemaNode,
  feishu: FeishuConfig as unknown as SchemaNode,
  notify: NotifyConfig as unknown as SchemaNode,
  agentTasks: AgentTasksConfig as unknown as SchemaNode,
  jev: JevConfig as unknown as SchemaNode,
}

const isEnum = (n: SchemaNode) => n.type === 'union' && !!n.list?.length && n.list.every((x) => x.type === 'const')

function typeLabel(n: SchemaNode): string {
  if (isEnum(n)) return 'enum'
  if (n.type === 'union') return n.list!.map(typeLabel).join(' | ')
  if (n.type === 'array') return `${typeLabel(n.inner!)}[]`
  if (n.type === 'dict') return `Record<string, ${typeLabel(n.inner!)}>`
  return n.type
}

function formatDefault(n: SchemaNode): string {
  const d = n.meta?.default
  if (d === undefined) return '—'
  // 逗号后留空格，让较长的默认值（如工具白名单）可以在表格里换行
  if (typeof d === 'object') return JSON.stringify(d).replace(/,/g, ', ')
  return String(d)
}

function formatRange(n: SchemaNode): string {
  const m = n.meta ?? {}
  if (isEnum(n)) return n.list!.map((x) => String(x.value)).join(' | ')
  if (n.type === 'union' && n.list?.every((x) => x.type === 'string')) return n.list.length > 1 ? '字符串或字符串列表' : '—'
  if (m.min !== undefined && m.max !== undefined) return `[${m.min}, ${m.max}]`
  if (m.min !== undefined) return `≥ ${m.min}`
  if (m.max !== undefined) return `≤ ${m.max}`
  if (m.pattern) return `匹配 /${m.pattern.source}/`
  if (n.type === 'union' || n.type === 'dict' || n.type === 'array') return '见说明'
  return '—'
}

function walk(n: SchemaNode, prefix: string, out: ConfigRow[], descriptions: Record<string, string>): void {
  if (n.type === 'object' && n.dict) {
    for (const [key, child] of Object.entries(n.dict)) walk(child, prefix ? `${prefix}.${key}` : key, out, descriptions)
    return
  }
  out.push({
    path: prefix,
    type: typeLabel(n),
    default: formatDefault(n),
    range: formatRange(n),
    description: n.meta?.description ?? descriptions[prefix] ?? '',
    required: n.meta?.required === true,
  })
}

export function configRows(id: ServiceId): ConfigRow[] {
  const rows: ConfigRow[] = []
  walk(SCHEMAS[id], '', rows, service(id).descriptions)
  return rows
}
