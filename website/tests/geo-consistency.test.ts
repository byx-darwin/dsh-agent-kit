import { describe, expect, it } from 'vitest'
import { softwareJsonLd, faqJsonLd, blogPostingJsonLd } from '../src/lib/jsonld'
import { renderLlms, renderLlmsFull, renderLlmsConfig } from '../src/lib/llms'
import { SITE } from '../src/lib/site'
import { RELEASE } from '../src/data/release'
import pkg from '../../package.json'

describe('GEO consistency', () => {
  it('software JSON-LD uses the canonical positioning, repo and version', () => {
    const j = softwareJsonLd() as Record<string, any>
    expect(j['@type']).toBe('SoftwareApplication')
    expect(j.description).toBe(SITE.positioning)
    expect(j.softwareVersion).toBe(pkg.version)
    expect(j.sameAs).toContain(SITE.repo)
    expect(j.featureList.join(' ')).toMatch(/agentWs.*dingtalk.*agentTasks.*jev/s)
  })
  it('llms.txt shares the positioning, package name and links', () => {
    const t = renderLlms()
    expect(t.startsWith(`# ${SITE.name}\n\n> ${SITE.positioning}`)).toBe(true)
    expect(t).toContain(SITE.npm)
    expect(t).toContain(`${SITE.url}/llms-full.txt`)
    expect(t).toContain(RELEASE.published ? '已发布' : '尚未发布')
  })
  it('llms-config lists every config field with its default', () => {
    const t = renderLlmsConfig()
    expect(t).toContain('timeoutMs')
    expect(t).toContain('15000')
    expect(t).toContain('ai.typesafe.api-key')
  })
  it('llms-full contains every service section', () => {
    const t = renderLlmsFull()
    for (const name of ['ctx.agentWs', 'ctx.dingtalk', 'ctx.agentTasks', 'ctx.jev']) expect(t).toContain(name)
  })
  it('FAQ and blog JSON-LD are well-formed', () => {
    expect((faqJsonLd() as any).mainEntity.length).toBeGreaterThanOrEqual(8)
    expect((blogPostingJsonLd('resident-agent-worker') as any).headline).toBe('用 dsh 搭一个常驻 Agent Worker')
  })
})
