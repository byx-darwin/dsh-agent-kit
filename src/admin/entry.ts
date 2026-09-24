import type { CheckContext, CheckResult } from '../checks/types.js'
import type { ServiceHealth } from '../common/service.js'
import { KIT_ENTRIES, type FieldError, type KitId, type ValidateResult } from '../profile/kit-entries.js'
import type { KitEntryState } from '../profile/patch-file.js'
import { isSecretRef } from '../secrets/secret-ref.js'

/**
 * 业务包登记到本包设置页、`agentKitAdmin`、`doctor` 与密钥管理的一行 loader 配置（issue #1）。
 *
 * 两种登记方式共用这一个形状：
 * - 静态清单：业务包 `package.json` 的 `dsh.agentKit.entries` 指向无副作用的模块，模块默认导出
 *   一个（或一组）条目。业务插件未启用、启动失败时照样能看到卡片、表单与检查，`doctor` 也从这里发现。
 * - 运行时：`ctx.agentKitAdmin.registerEntry(entry)`，插件卸载时自动注销。同 id 时运行时登记覆盖
 *   静态清单（例如补上只有运行中才有的 `health`）。
 */
export interface AgentKitEntry {
  /** `cordis.patch.yml` 里的 loader 行 id。 */
  id: string
  label: string
  /** Schemastery schema（或任意 `(value) => normalized`，非法时抛错），先于 `validate` 执行。 */
  schema?: (value: unknown) => unknown
  /** schema 表达不了的约束（URL 协议、跨字段、白名单…）；`path` 相对于本行的 config。 */
  validate?(config: any): readonly FieldError[] | void
  /** 设置页表单字段；缺省时卡片只有启用开关。 */
  fields?: readonly EntryField[]
  /** 本行用到的密钥，按 ref 存入 dsh 凭据文件。 */
  secrets?: readonly EntrySecret[]
  /** 行运行中时，从这个 cordis 服务的 `health()` 读取状态。 */
  service?: string
  /** 优先于 `service`。只在行运行中时调用。 */
  health?(): Pick<ServiceHealth, 'status' | 'detail'> | undefined
  /** 额外的预检；返回结果的 scope 固定为本行 id，id 自动加上 `<行 id>.` 前缀。 */
  checks?(ctx: EntryCheckContext): readonly EntryCheckResult[] | Promise<readonly EntryCheckResult[]>
  /** 本行插件 inject 的本包 Service。停用这些行会连带卸载本行插件，设置页据此在保存前提示。 */
  dependsOn?: readonly KitId[]
}

export type EntryFieldKind = 'text' | 'number' | 'boolean' | 'select' | 'list'
export interface EntryField {
  /** 相对 config 的点分路径，如 `alertTarget.chatId`。 */
  path: string
  label: string
  /** 缺省为 `text`；`list` 是逗号或换行分隔的字符串数组。 */
  kind?: EntryFieldKind
  /** `select` 的可选值。 */
  options?: readonly string[]
  placeholder?: string
  help?: string
}
export interface EntrySecret {
  label: string
  /** 固定的 ref；与 `refFrom` 同时给出时作为 config 里未填写时的默认值。 */
  ref?: string
  /** 从 config 的这个点分路径读取 ref（例如 `tokenEnv`），保存后跟随新值。 */
  refFrom?: string
}
export interface EntryCheckContext extends CheckContext {
  entry: { id: string; enabled: boolean; config: Record<string, unknown> | undefined }
}
export type EntryCheckResult = Omit<CheckResult, 'scope'>

/** 登记条目与它在 `cordis.patch.yml` 中的当前状态。 */
export interface RegisteredEntry {
  entry: AgentKitEntry
  state: KitEntryState
}

/** 类型辅助：`export default defineEntry({...})`。 */
export function defineEntry<T extends AgentKitEntry>(entry: T): T {
  return entry
}

const RESERVED_IDS = new Set<string>(['common', 'agent-kit', ...KIT_ENTRIES.map((e) => e.id)])
const KIT_IDS = new Set<string>(KIT_ENTRIES.map((e) => e.id))

/** 登记前的形状检查；不合法时抛错，错误信息指明哪个字段有问题。 */
export function assertEntry(entry: unknown): asserts entry is AgentKitEntry {
  const e = entry as Partial<AgentKitEntry> | null
  const fail = (message: string): never => {
    throw new TypeError(`agent-kit entry ${JSON.stringify(e?.id ?? null)}: ${message}`)
  }
  if (!e || typeof e !== 'object') throw new TypeError('agent-kit entry must be an object')
  if (typeof e.id !== 'string' || !/^[\w.-]+$/.test(e.id)) fail('id must be a loader row id (letters, digits, _ . -)')
  if (RESERVED_IDS.has(e.id!)) fail('id is reserved by @mc/dsh-agent-kit')
  if (typeof e.label !== 'string' || !e.label.trim()) fail('label is required')
  for (const key of ['schema', 'validate', 'health', 'checks'] as const) {
    if (e[key] !== undefined && typeof e[key] !== 'function') fail(`${key} must be a function`)
  }
  for (const f of e.fields ?? []) {
    if (typeof f?.path !== 'string' || !f.path || typeof f.label !== 'string') fail('every field needs path and label')
    if (f.kind === 'select' && !f.options?.length) fail(`field ${f.path}: select needs options`)
  }
  for (const s of e.secrets ?? []) {
    if (typeof s?.label !== 'string' || (!s.ref && !s.refFrom)) fail('every secret needs label and ref or refFrom')
    if (s.ref !== undefined && !isSecretRef(s.ref)) fail(`secret ref ${JSON.stringify(s.ref)} must be an environment variable name`)
  }
  for (const id of e.dependsOn ?? []) if (!KIT_IDS.has(id)) fail(`dependsOn: unknown kit row ${JSON.stringify(id)}`)
}

export function getPath(obj: unknown, path: string): unknown {
  let cur = obj
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** schema（错误信息形如 `$.a.b expected ...`）+ validate，与本包四行的校验同一形状。 */
export function validateEntryConfig(entry: AgentKitEntry, config: unknown): ValidateResult {
  let value: unknown = config ?? {}
  if (entry.schema) {
    try {
      value = entry.schema(value)
    } catch (e) {
      const message = (e as Error).message
      return { ok: false, errors: [{ path: /\$\.([\w.[\]-]+)/.exec(message)?.[1] ?? '', message }] }
    }
  }
  let errors: readonly FieldError[] | void
  try {
    errors = entry.validate?.(value)
  } catch (e) {
    return { ok: false, errors: [{ path: '', message: (e as Error).message }] }
  }
  return errors?.length ? { ok: false, errors: [...errors] } : { ok: true, value }
}

/** 按当前 config 解析本行的密钥 ref；解析出的 ref 不是合法变量名时 `ref` 为 undefined。 */
export function entrySecretRefs(entry: AgentKitEntry, config: Record<string, unknown> | undefined): Array<{ label: string; ref: string | undefined }> {
  return (entry.secrets ?? []).map((s) => {
    const fromConfig = s.refFrom ? getPath(config, s.refFrom) : undefined
    const ref = typeof fromConfig === 'string' && fromConfig.trim() ? fromConfig.trim() : s.ref
    return { label: s.label, ref: isSecretRef(ref) ? ref : undefined }
  })
}
