import { describe, expect, it } from 'vitest'
import { renderFeed } from '../src/lib/feed'
import { POSTS } from '../src/data/blog'

describe('feed', () => {
  it('lists every post with absolute links under the base path', () => {
    const xml = renderFeed('https://byx-darwin.github.io/dsh-agent-kit', '/dsh-agent-kit/')
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\s*<rss version="2.0">/)
    for (const p of POSTS) {
      expect(xml).toContain(`<link>https://byx-darwin.github.io/dsh-agent-kit/blog/${p.slug}/</link>`)
      expect(xml).toContain(`<title>${p.title}</title>`)
    }
  })
  it('escapes XML special characters', () => {
    expect(renderFeed('https://x.test', '/')).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
  })
})
