import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, KitError, isKitError } from '../../src/common/errors.js'
import { BASE_ENV_WHITELIST, pickEnv, runProcess } from '../../src/common/process.js'
import { clearSecretsForTesting, digest, redact, redactValue, registerSecret } from '../../src/common/redact.js'
import { until } from '../helpers.js'

afterEach(() => clearSecretsForTesting())

describe('redact', () => {
  it('replaces registered secrets exactly and supports unregistering', () => {
    const dispose = registerSecret('s3cr3t-token-value')
    expect(redact('Authorization: Bearer s3cr3t-token-value!')).toBe('Authorization: Bearer [REDACTED]!')
    dispose()
    expect(redact('s3cr3t-token-value')).toBe('s3cr3t-token-value')
  })

  it('handles overlapping secrets by replacing the longest first', () => {
    registerSecret('abcd')
    registerSecret('abcdefgh')
    expect(redact('xx abcdefgh yy abcd')).toBe('xx [REDACTED] yy [REDACTED]')
  })

  it('ignores very short secrets and reference-counts duplicates', () => {
    registerSecret('ab')
    expect(redact('ab')).toBe('ab')
    const a = registerSecret('dup-secret')
    const b = registerSecret('dup-secret')
    a()
    expect(redact('dup-secret')).toBe('[REDACTED]')
    b()
    expect(redact('dup-secret')).toBe('dup-secret')
  })

  it('truncates long text', () => {
    const out = redact('x'.repeat(5000), 100)
    expect(out.startsWith('x'.repeat(100))).toBe(true)
    expect(out).toContain('[truncated 4900 chars]')
  })

  it('redactValue scrubs errors, nested objects and sensitive keys', () => {
    registerSecret('api-key-123456')
    const err = Object.assign(new Error('failed with api-key-123456'), { code: 'E1', status: 401, cause: new Error('inner api-key-123456') })
    const v = redactValue({ err, headers: { authorization: 'x', 'X-Token': 'y', ok: 'api-key-123456' }, list: [1, 'api-key-123456'] }) as any
    const json = JSON.stringify(v)
    expect(json).not.toContain('api-key-123456')
    expect(v.headers.authorization).toBe('[REDACTED]')
    expect(v.headers['X-Token']).toBe('[REDACTED]')
    expect(v.err).toMatchObject({ name: 'Error', code: 'E1', status: 401 })
    expect(redactValue(10n)).toBe('10')
    expect(redactValue(null)).toBe(null)
  })

  it('digest records only length and hash', () => {
    const d = digest('hello 世界')
    expect(d.length).toBe(Buffer.byteLength('hello 世界'))
    expect(d.sha256).toMatch(/^[0-9a-f]{16}$/)
    expect(digest(Buffer.from('abc')).length).toBe(3)
  })
})

describe('KitError', () => {
  it('is identified by isKitError without instanceof and carries code / retryable', () => {
    const e = new KitError('dingtalk', 'timeout', 'timed out', { retryable: true })
    expect(isKitError(e)).toBe(true)
    expect(e.retryable).toBe(true)
    expect(e.code).toBe('timeout')
    expect(isKitError(new Error('x'))).toBe(false)
    expect(isKitError(null)).toBe(false)
    expect(isKitError({ code: 'timeout', service: 'dingtalk' })).toBe(false)
    expect(new KitError('jev', 'x', 'y').retryable).toBe(false)
  })

  it('redacts message, cause and details at construction', () => {
    registerSecret('very-secret-token')
    const e = new KitError('agentWs', 'x', 'bad very-secret-token', { cause: new Error('very-secret-token'), details: { t: 'very-secret-token' } })
    expect(JSON.stringify(e.toJSON())).not.toContain('very-secret-token')
    expect(e.message).toBe('bad [REDACTED]')
  })

  it('ConfigError is a non-retryable invalid_config KitError', () => {
    const e = new ConfigError('jev', 'missing')
    expect(isKitError(e)).toBe(true)
    expect(e.code).toBe('invalid_config')
    expect(e.retryable).toBe(false)
  })
})

describe('runProcess', () => {
  it('passes only the whitelisted environment', async () => {
    process.env.AGENT_KIT_TEST_SECRET = 'leak'
    const env = pickEnv(BASE_ENV_WHITELIST)
    delete process.env.AGENT_KIT_TEST_SECRET
    const r = await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], { env, timeoutMs: 5000, killGraceMs: 100 })
    const keys = JSON.parse(r.stdout) as string[]
    expect(keys).not.toContain('AGENT_KIT_TEST_SECRET')
    expect(keys.every((k) => (BASE_ENV_WHITELIST as readonly string[]).includes(k) || k === '__CF_USER_TEXT_ENCODING')).toBe(true)
    expect(r.exitCode).toBe(0)
  })

  it('kills the whole process group on timeout, escalating to SIGKILL', async () => {
    const script = `
      const { spawn } = require('node:child_process')
      const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
      console.log(JSON.stringify({ child: c.pid }))
      process.on('SIGTERM', () => {}) // 忽略 SIGTERM，验证宽限后 SIGKILL
      setInterval(() => {}, 1000)
    `
    const started = Date.now()
    const r = await runProcess(process.execPath, ['-e', script], { env: pickEnv(BASE_ENV_WHITELIST), timeoutMs: 300, killGraceMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.signal).toBe('SIGKILL')
    expect(Date.now() - started).toBeGreaterThanOrEqual(450)
    const { child } = JSON.parse(r.stdout.trim().split('\n')[0]!) as { child: number }
    await until(() => {
      try {
        process.kill(child, 0)
        return false
      } catch {
        return true
      }
    }, 3000, 'grandchild still alive')
  })

  it('terminates on abort and reports aborted', async () => {
    const controller = new AbortController()
    const p = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: pickEnv(BASE_ENV_WHITELIST), timeoutMs: 10_000, killGraceMs: 100, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const r = await p
    expect(r.aborted).toBe(true)
    expect(r.timedOut).toBe(false)
    const pre = await runProcess(process.execPath, ['-e', ''], { env: {}, timeoutMs: 1000, killGraceMs: 0, signal: AbortSignal.abort() })
    expect(pre.aborted).toBe(true)
  })

  it('rejects when the executable cannot be spawned', async () => {
    await expect(runProcess('/nonexistent/binary', [], { env: {}, timeoutMs: 1000, killGraceMs: 0 })).rejects.toThrow()
  })

  it('does not interpret arguments through a shell', async () => {
    const r = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', '$(echo pwned); rm -rf /'], { env: pickEnv(['PATH']), timeoutMs: 5000, killGraceMs: 100 })
    expect(r.stdout.trim()).toBe('$(echo pwned); rm -rf /')
  })
})
