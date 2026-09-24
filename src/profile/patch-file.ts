import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { KIT_ENTRIES, kitEntry, type FieldError, type KitId } from './kit-entries.js'
import { ProfileError } from './profile-error.js'

export interface KitEntryState {
  enabled: boolean
  config: Record<string, unknown> | undefined
}
export interface KitSnapshot {
  version: string
  entries: Record<KitId, KitEntryState>
}
export type KitChanges = Partial<Record<KitId, { enabled: boolean; config?: Record<string, unknown> }>>

const JS_TAG = 'tag:yaml.org,2002:js'

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw e
  }
}

function versionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function parse(text: string): Document {
  const doc = parseDocument(text, { keepSourceTokens: true })
  if (doc.errors.length > 0) throw new ProfileError('parse_error', `cordis.patch.yml 解析失败：${doc.errors[0]!.message}`)
  if (doc.contents === null) doc.contents = doc.createNode([]) as never
  if (!isSeq(doc.contents)) throw new ProfileError('parse_error', 'cordis.patch.yml 顶层必须是列表')
  return doc
}

function findRow(doc: Document, id: KitId): YAMLMap | undefined {
  for (const item of (doc.contents as YAMLSeq).items) {
    if (isMap(item) && item.get('id') === id) return item as YAMLMap
  }
  return undefined
}

/** 递归检测节点树中是否含有无法安全解析/回写的 `!!js` 标签（schemastery 无法识别的自定义标签）。 */
function hasJsTag(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  const n = node as { tag?: string; items?: unknown[]; value?: unknown; key?: unknown }
  if (n.tag === JS_TAG || n.tag === '!!js') return true
  if (Array.isArray(n.items)) return n.items.some(hasJsTag)
  return hasJsTag(n.key) || hasJsTag(n.value)
}

function lineOf(text: string, row: YAMLMap): number {
  const offset = row.range?.[0] ?? 0
  const tagged = text.indexOf('!!js', offset)
  return text.slice(0, tagged >= 0 ? tagged : offset).split('\n').length
}

function stateOf(row: YAMLMap | undefined): KitEntryState {
  if (!row) return { enabled: false, config: undefined }
  const disabled = row.get('disabled')
  const config = row.get('config')
  return {
    // 行存在且 disabled 缺失或为 false 即为启用
    enabled: !row.has('disabled') || disabled === false,
    config: isMap(config) ? (config.toJSON() as Record<string, unknown>) : undefined,
  }
}

export async function readKitEntries(patchFile: string): Promise<KitSnapshot> {
  const text = await readText(patchFile)
  const doc = parse(text)
  const entries = {} as Record<KitId, KitEntryState>
  for (const meta of KIT_ENTRIES) entries[meta.id] = stateOf(findRow(doc, meta.id))
  return { version: versionOf(text), entries }
}

function apply(text: string, changes: KitChanges): string {
  const doc = parse(text)
  const errors: FieldError[] = []
  for (const [id, change] of Object.entries(changes) as [KitId, NonNullable<KitChanges[KitId]>][]) {
    let row = findRow(doc, id)
    if (row && hasJsTag(row)) {
      throw new ProfileError('unsupported_yaml', `${id} 含有 !!js 表达式，请手动编辑`, { line: lineOf(text, row) })
    }
    const config = change.config ?? (row ? stateOf(row).config : undefined)
    // 启用时校验生效配置（可能来自已有行）；即使保持禁用，只要本次显式提供了 config 也要校验，
    // 避免写入一个禁用但内容非法的配置，为下次启用埋雷。禁用且未提供 config 时不校验（不动原有内容）。
    if (change.enabled || change.config !== undefined) {
      const result = kitEntry(id).validate(config)
      if (!result.ok) errors.push(...result.errors.map((e) => ({ ...e, path: `${id}.${e.path}` })))
    }
    if (!row) {
      row = doc.createNode({ id }) as YAMLMap
      ;(doc.contents as YAMLSeq).items.push(row)
    }
    row.set('disabled', !change.enabled)
    if (change.config !== undefined) row.set('config', doc.createNode(change.config))
  }
  if (errors.length > 0) throw new ProfileError('invalid_config', errors.map((e) => `${e.path}: ${e.message}`).join('; '), { errors })
  return doc.toString()
}

export async function previewKitEntries(patchFile: string, changes: KitChanges): Promise<{ before: string; after: string }> {
  const before = await readText(patchFile)
  return { before, after: apply(before, changes) }
}

export async function writeKitEntries(patchFile: string, changes: KitChanges, expectedVersion: string): Promise<{ version: string }> {
  const before = await readText(patchFile)
  if (versionOf(before) !== expectedVersion) throw new ProfileError('conflict', 'cordis.patch.yml 已被修改，请刷新后重试')
  const after = apply(before, changes)
  await mkdir(dirname(patchFile), { recursive: true })
  const temp = `${patchFile}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, after)
  try {
    // Windows 上 rename 覆盖已存在文件可能因占用失败，重试一次前先删除目标
    await rename(temp, patchFile).catch(async (e: NodeJS.ErrnoException) => {
      if (process.platform !== 'win32' || (e.code !== 'EPERM' && e.code !== 'EEXIST')) throw e
      await rm(patchFile, { force: true })
      await rename(temp, patchFile)
    })
  } finally {
    await rm(temp, { force: true })
  }
  return { version: versionOf(after) }
}
