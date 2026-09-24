import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 构建后运行：扫描 dist/ 中所有 HTML 的站内 href / src，确认都带 base 路径且目标文件存在。
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const BASE = '/dsh-agent-kit'

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith('.html') ? [p] : []
  })
}

function targetExists(url: string): boolean {
  const clean = decodeURI(url.split('#')[0]!.split('?')[0]!)
  if (clean !== BASE && !clean.startsWith(`${BASE}/`)) return false
  const rel = clean.slice(BASE.length) || '/'
  const p = join(DIST, rel)
  return existsSync(p) && (statSync(p).isFile() || existsSync(join(p, 'index.html')))
}

describe.skipIf(!existsSync(DIST))('built site links', () => {
  it('every internal href/src points to an existing file under the base path', () => {
    const broken: string[] = []
    const files = htmlFiles(DIST)
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const html = readFileSync(file, 'utf8')
      for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
        const url = m[1]!
        if (/^(https?:|mailto:|#|data:)/.test(url)) continue
        if (!targetExists(url)) broken.push(`${relative(DIST, file)} → ${url}`)
      }
    }
    expect(broken).toEqual([])
  })
})
