import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { KIT_ENTRIES, kitEntry, type FieldError, type KitId, type ValidateResult } from './kit-entries.js'
import { ProfileError } from './profile-error.js'

export interface KitEntryState {
  enabled: boolean
  config: Record<string, unknown> | undefined
}
export interface KitSnapshot {
  version: string
  entries: Record<KitId, KitEntryState>
}
export type KitChanges = Partial<Record<KitId, EntryChange>>
export interface EntryChange {
  enabled: boolean
  config?: Record<string, unknown>
}
/** 任意 loader 行（本包的四行或业务包登记的行）的快照。 */
export interface PatchSnapshot {
  version: string
  entries: Record<string, KitEntryState>
}
export type EntryValidator = (id: string, config: unknown) => ValidateResult

const validateKitEntry: EntryValidator = (id, config) => kitEntry(id as KitId).validate(config)
const KIT_IDS = KIT_ENTRIES.map((e) => e.id)

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

function findRow(doc: Document, id: string): YAMLMap | undefined {
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

export async function readPatchEntries(patchFile: string, ids: readonly string[]): Promise<PatchSnapshot> {
  const text = await readText(patchFile)
  const doc = parse(text)
  const entries: Record<string, KitEntryState> = {}
  for (const id of ids) entries[id] = stateOf(findRow(doc, id))
  return { version: versionOf(text), entries }
}

export async function readKitEntries(patchFile: string): Promise<KitSnapshot> {
  return (await readPatchEntries(patchFile, KIT_IDS)) as KitSnapshot
}

/**
 * 序列项在文本中的范围：从 `-` 所在行的行首，到节点值结束（`range[1]`，已含行尾注释与换行）。
 * 找不到 `-`（例如流式序列）时返回 undefined，由调用方回退为整体重写。
 */
function itemSpan(text: string, row: YAMLMap): { start: number; end: number; indent: string } | undefined {
  if (!row.range) return undefined
  let dash = row.range[0] - 1
  while (dash >= 0 && /\s/.test(text[dash]!)) dash--
  if (text[dash] !== '-') return undefined
  const start = text.lastIndexOf('\n', dash - 1) + 1
  const indent = text.slice(start, dash)
  if (indent.trim()) return undefined
  return { start, end: row.range[1], indent }
}

/**
 * 只替换被修改的行，其余文本逐字节保留（issue #1：保存本包的行不能改动业务包行的文本，反之亦然）。
 * `yaml` 的 `doc.toString()` 会规范化整份文档（缩进、流式集合的空格、数字字面量的大小写、折叠块），
 * 所以先整体序列化一次，再从规范化结果里取出被修改行的文本，拼回原文对应的位置；新增的行追加到末尾。
 */
function splice(before: string, original: Document, updated: Document, ids: string[]): string {
  const normalized = updated.toString()
  const seq = original.contents as YAMLSeq
  if (seq.flow || seq.items.length === 0) return normalized
  const reparsed = parse(normalized)
  const replacements: { start: number; end: number; text: string }[] = []
  const appended: string[] = []
  const indent = itemSpan(before, seq.items[0] as YAMLMap)?.indent
  if (indent === undefined) return normalized
  for (const id of ids) {
    const next = findRow(reparsed, id)
    const nextSpan = next && itemSpan(normalized, next)
    if (!nextSpan) return normalized
    let text = normalized.slice(nextSpan.start, nextSpan.end)
    if (!text.endsWith('\n')) text += '\n'
    const row = findRow(original, id)
    if (!row) {
      appended.push(reindent(text, indent))
      continue
    }
    const span = itemSpan(before, row)
    if (!span) return normalized
    if (!before.slice(span.start, span.end).endsWith('\n')) text = text.slice(0, -1)
    replacements.push({ start: span.start, end: span.end, text: reindent(text, span.indent) })
  }
  let after = before
  for (const r of replacements.sort((a, b) => b.start - a.start)) after = after.slice(0, r.start) + r.text + after.slice(r.end)
  if (appended.length > 0) after += (after.endsWith('\n') ? '' : '\n') + appended.join('')
  return after
}

function reindent(text: string, indent: string): string {
  return indent ? text.replace(/^(?=.)/gm, indent) : text
}

function apply(text: string, changes: Record<string, EntryChange>, validate: EntryValidator): string {
  const original = parse(text)
  const doc = parse(text)
  const errors: FieldError[] = []
  for (const [id, change] of Object.entries(changes)) {
    let row = findRow(doc, id)
    if (row && hasJsTag(row)) {
      throw new ProfileError('unsupported_yaml', `${id} 含有 !!js 表达式，请手动编辑`, { line: lineOf(text, row) })
    }
    const config = change.config ?? (row ? stateOf(row).config : undefined)
    // 启用时校验生效配置（可能来自已有行）；即使保持禁用，只要本次显式提供了 config 也要校验，
    // 避免写入一个禁用但内容非法的配置，为下次启用埋雷。禁用且未提供 config 时不校验（不动原有内容）。
    if (change.enabled || change.config !== undefined) {
      const result = validate(id, config)
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
  return splice(text, original, doc, Object.keys(changes))
}

export async function previewPatchEntries(patchFile: string, changes: Record<string, EntryChange>, validate: EntryValidator): Promise<{ before: string; after: string }> {
  const before = await readText(patchFile)
  return { before, after: apply(before, changes, validate) }
}

export async function previewKitEntries(patchFile: string, changes: KitChanges): Promise<{ before: string; after: string }> {
  return previewPatchEntries(patchFile, changes as Record<string, EntryChange>, validateKitEntry)
}

export async function writeKitEntries(patchFile: string, changes: KitChanges, expectedVersion: string): Promise<{ version: string }> {
  return writePatchEntries(patchFile, changes as Record<string, EntryChange>, expectedVersion, validateKitEntry)
}

/** 写入任意行；`validate` 决定每一行用哪个 schema 校验。与 `writeKitEntries` 共用同一套版本冲突检测。 */
export async function writePatchEntries(patchFile: string, changes: Record<string, EntryChange>, expectedVersion: string, validate: EntryValidator): Promise<{ version: string }> {
  const before = await readText(patchFile)
  if (versionOf(before) !== expectedVersion) throw new ProfileError('conflict', 'cordis.patch.yml 已被修改，请刷新后重试')
  const after = apply(before, changes, validate)
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
