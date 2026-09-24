import { describe, expect, it } from 'vitest'
import { withBasePath } from '../src/lib/paths'

describe('withBasePath', () => {
  it('joins base and absolute path', () => {
    expect(withBasePath('/dsh-agent-kit/', '/docs')).toBe('/dsh-agent-kit/docs')
    expect(withBasePath('/dsh-agent-kit', 'docs')).toBe('/dsh-agent-kit/docs')
    expect(withBasePath('/dsh-agent-kit/', '/')).toBe('/dsh-agent-kit/')
  })
  it('handles root base', () => {
    expect(withBasePath('/', '/docs')).toBe('/docs')
  })
  it('keeps hash and query', () => {
    expect(withBasePath('/dsh-agent-kit/', '/docs/jev#errors')).toBe('/dsh-agent-kit/docs/jev#errors')
  })
})
