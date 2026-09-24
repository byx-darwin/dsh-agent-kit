import { POSTS } from '../data/blog'
import { SITE } from './site'
import { withBasePath } from './paths'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** 生成博客的 RSS 2.0；链接为带 base 路径的绝对地址。 */
export function renderFeed(site: string, base: string): string {
  const origin = new URL(site).origin
  const link = (path: string) => `${origin}${withBasePath(base, path)}`
  const items = [...POSTS]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${link(`/blog/${p.slug}/`)}</link>
      <guid>${link(`/blog/${p.slug}/`)}</guid>
      <pubDate>${new Date(`${p.date}T00:00:00+08:00`).toUTCString()}</pubDate>
      <description>${esc(p.description)}</description>
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(SITE.name)} 博客</title>
    <link>${link('/blog/')}</link>
    <description>${esc(SITE.positioning)}</description>
    <language>zh-CN</language>
${items}
  </channel>
</rss>
`
}
