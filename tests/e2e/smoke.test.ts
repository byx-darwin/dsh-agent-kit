import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentTasksService } from '../../src/agent-tasks/service.js'
import { DingtalkService } from '../../src/dingtalk/service.js'
import { JevService } from '../../src/jev/service.js'
import { choice, noul } from '../../src/jev/types.js'

// 端到端冒烟：使用真实 dws / subagent / Jev，只在夜间或手动触发时运行（npm run test:e2e）。
// 每一项通过环境变量单独启用，未配置时跳过：
//   dingtalk:   AGENT_KIT_E2E_DINGTALK_CHAT_ID（测试群）或 AGENT_KIT_E2E_DINGTALK_USER_ID（单聊接收者 userId），
//               AGENT_KIT_E2E_DINGTALK_IDENTITY（默认 bot），AGENT_KIT_E2E_DINGTALK_ROBOT_CODE
//   agentTasks: AGENT_KIT_E2E_SUBAGENT=claude-code，AGENT_KIT_E2E_SUBAGENT_MODEL（默认 haiku）；需要本机已登录 Claude Code。
//               provider 会从子进程环境中剔除名字含 KEY/TOKEN/SECRET/PASSWORD 的变量，若 Agent 依赖这类变量鉴权，
//               用 AGENT_KIT_E2E_SUBAGENT_ENV=ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN 列出要经 provider Config.env 显式传入的变量名
//   jev:        TYPESAFE_API_KEY，或在 macOS 上用 AGENT_KIT_E2E_JEV_KEYCHAIN_SERVICE 指定钥匙串服务名（例如 ai.typesafe.api-key，多个名字用逗号分隔）
//   laya:       AGENT_KIT_E2E_LAYA_URL（本地 Laya 地址，例如 http://127.0.0.1:18765）；Laya 开启鉴权时另设 LAYA_API_KEY

const env = process.env
let root: Context
let tmp: string

beforeEach(() => {
  root = new Context()
  tmp = mkdtempSync(join(tmpdir(), 'agent-kit-e2e-'))
})

afterEach(async () => {
  await root.fiber.dispose()
  rmSync(tmp, { recursive: true, force: true })
})

describe.skipIf(!env.AGENT_KIT_E2E_DINGTALK_CHAT_ID && !env.AGENT_KIT_E2E_DINGTALK_USER_ID)('dingtalk (real dws)', () => {
  it('sends a message to the test group or user', async () => {
    const identity = (env.AGENT_KIT_E2E_DINGTALK_IDENTITY ?? 'bot') as 'bot' | 'user'
    await root.plugin(DingtalkService, {
      identity,
      ...(identity === 'bot' ? { robotCode: env.AGENT_KIT_E2E_DINGTALK_ROBOT_CODE } : {}),
      defaultTarget: env.AGENT_KIT_E2E_DINGTALK_CHAT_ID
        ? { chatId: env.AGENT_KIT_E2E_DINGTALK_CHAT_ID }
        : { userId: env.AGENT_KIT_E2E_DINGTALK_USER_ID! },
    })
    const svc = root.get('dingtalk')!
    expect(svc.health().status).toBe('ok')
    const r = await svc.send({
      title: 'dsh-agent-kit e2e',
      markdown: `### dsh-agent-kit e2e\n\n${new Date().toISOString()}`,
      idempotencyKey: `e2e-${Date.now()}`,
    })
    expect(r.results.every((x) => x.ok)).toBe(true)
  })
})

describe.skipIf(!env.AGENT_KIT_E2E_SUBAGENT)('agentTasks (real subagent provider)', () => {
  const provider = env.AGENT_KIT_E2E_SUBAGENT!

  async function setupAgentTasks(keepWorkdir = false) {
    const pkg = provider === 'codex' ? '@deepseek-ai/dsh-subagent-codex' : '@deepseek-ai/dsh-subagent-claude-code'
    const [{ default: Subagents }, { default: Subprocess }, providerPlugin] = await Promise.all([
      import('@deepseek-ai/dsh-subagent'),
      import('@deepseek-ai/dsh-subprocess-local'),
      import(pkg),
    ])
    await root.plugin(Subagents)
    await root.plugin(Subprocess)
    const passthrough = (env.AGENT_KIT_E2E_SUBAGENT_ENV ?? '').split(',').filter((name) => name && env[name] !== undefined)
    // 使用 provider 的默认权限模式（claude-code: dontAsk，codex: never）
    await root.plugin(providerPlugin, {
      model: env.AGENT_KIT_E2E_SUBAGENT_MODEL ?? 'haiku',
      env: Object.fromEntries(passthrough.map((name) => [name, env[name]!])),
    })
    await root.plugin(AgentTasksService, { workspaceDir: join(tmp, 'tasks'), keepWorkdir, declaredPermissions: { [provider]: 'read-only' } })
    await new Promise<void>((resolve) => root.inject(['agentTasks'], () => resolve()))
    return root.get('agentTasks')!
  }

  it('runs a minimal one-shot task with a stub parent agent and extracts JSON output', async () => {
    const tasks = await setupAgentTasks()
    const r = await tasks.run<{ answer: number }>({
      provider,
      title: 'dsh-agent-kit e2e',
      prompt: 'What is 2 + 3? Do not use any tools.',
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
      timeoutMs: 300_000,
    })
    expect(r.output.answer).toBe(5)
  })

  it('cannot run commands or write files under the default permission mode', async () => {
    const tasks = await setupAgentTasks(true)
    const marker = join(tmp, 'agent-kit-e2e-marker')
    let cwd = ''
    const r = await tasks.run<{ created: boolean }>({
      provider,
      title: 'dsh-agent-kit e2e permissions',
      prompt: [
        `Try to create two files: run the shell command \`touch ${marker}\`, and use your file-writing tool to create a file named created.txt in the current directory.`,
        'Then report whether you succeeded.',
      ],
      outputSchema: { type: 'object', properties: { created: { type: 'boolean' } }, required: ['created'] },
      timeoutMs: 300_000,
      onEvent: (e) => {
        if (e.type === 'started') cwd = join(tmp, 'tasks', e.taskId)
      },
    })
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(cwd, 'created.txt'))).toBe(false)
    expect(r.output.created).toBe(false)
  })
})

describe.skipIf(!env.TYPESAFE_API_KEY && !env.AGENT_KIT_E2E_JEV_KEYCHAIN_SERVICE)('jev (real TypeSafe API)', () => {
  it('judges a trivial state', async () => {
    await root.plugin(JevService, env.AGENT_KIT_E2E_JEV_KEYCHAIN_SERVICE ? { keychainService: env.AGENT_KIT_E2E_JEV_KEYCHAIN_SERVICE.split(',') } : {})
    await new Promise<void>((resolve) => root.inject(['jev'], () => resolve()))
    const { answers } = await root.get('jev')!.judge({
      state: 'The customer says: I was charged twice for my order.',
      questions: {
        billing: noul('Is this about billing?'),
        mood: choice('How does the customer feel?', { calm: null, upset: null }),
      },
    })
    expect(answers.billing.noul).toBeGreaterThan(0.5)
    expect(['calm', 'upset']).toContain(answers.mood.choice)
  })
})

describe.skipIf(!env.AGENT_KIT_E2E_LAYA_URL)('jev (real local Laya)', () => {
  it('judges a trivial state through provider laya', async () => {
    await root.plugin(JevService, { provider: 'laya', baseURL: env.AGENT_KIT_E2E_LAYA_URL! })
    await new Promise<void>((resolve) => root.inject(['jev'], () => resolve()))
    const { answers } = await root.get('jev')!.judge({
      state: 'The customer says: I was charged twice for my order.',
      questions: {
        billing: noul('Is this about billing?'),
        mood: choice('How does the customer feel?', { calm: null, upset: null }),
      },
    })
    expect(answers.billing.noul).toBeGreaterThan(0.5)
    expect(['calm', 'upset']).toContain(answers.mood.choice)
    expect(root.get('jev')!.health().status).toBe('ok')
  })
})
