import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, parseDocument } from 'yaml'
import { resolveDshHome } from '../profile/locate.js'

/** dsh-credentials-local 使用的文件：$DSH_HOME/.credentials.yaml（version 1，refs 映射）。 */
export function credentialsFile(home = resolveDshHome()): string {
  return join(home, '.credentials.yaml')
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw e
  }
}

export async function readCredential(ref: string, file = credentialsFile()): Promise<string | undefined> {
  const doc = parseDocument(await readText(file))
  const refs = doc.get('refs')
  const value = isMap(refs) ? refs.get(ref) : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** value 为 undefined 时删除该项。与 dsh 使用同一把跨进程锁，并以 0600 原子写入。 */
export async function writeCredential(ref: string, value: string | undefined, file = credentialsFile()): Promise<void> {
  await withFileLock(file, async () => {
    const text = await readText(file)
    const doc = parseDocument(text || 'version: 1\nrefs: {}\n')
    doc.set('version', 1)
    if (value === undefined) doc.deleteIn(['refs', ref])
    else doc.setIn(['refs', ref], value)
    await writeFileAtomic(file, doc.toString(), { mode: 0o600, dirMode: 0o700 })
  })
}
