# dsh-agent-kit 配置引导（doctor / setup / Web 设置页）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让第三方无需阅读文档即可配置并验证 `@mc/dsh-agent-kit`：命令行 `doctor` 检查、`setup` 交互式配置、dsh Web 界面中的「Agent Kit」设置页。

**Architecture:** 配置唯一来源是 Profile 的 `cordis.patch.yml` 中 `agent-kit-*` 行，由纯 Node 的 `profile/` 模块读写（保留注释、原子写入、版本冲突检测）。TypeSafe Key 由 `secrets/` 按「环境变量 → macOS 钥匙串 → dsh 凭据文件」读取。`checks/` 提供结构化检查项，供 `cli/`（doctor、setup）与服务端 `admin/`（`AgentKitAdmin`，dsh 远程服务）共用；`client/` 是 React 设置页，构建为 dsh 前端模块。

**Tech Stack:** TypeScript 5.9（ESM、strict）、cordis 4.0.2、schemastery、`yaml`、`@inquirer/prompts`、`diff`、`@deepseek-ai/dsh-atomic-write`、`@deepseek-ai/dsh-typert-protocol`、React 18（dsh 前端共享实例）、esbuild（前端构建）、Vitest（jsdom + @testing-library/react 用于前端）。

**Spec:** `docs/superpowers/specs/2026-09-24-dsh-agent-kit-onboarding-design.md`（前置：`docs/superpowers/specs/2026-09-23-dsh-agent-kit-design.md`）

## Global Constraints

- 平台：Linux、macOS、Windows 都必须可用；CI 矩阵 `ubuntu-latest`、`macos-latest`、`windows-latest` × Node `22.19`、`24`。
- dsh 版本对齐 `0.1.5-rc.3`；cordis `4.0.2`；dsh 相关包为 `peerDependencies`（`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-atomic-write` 例外，见 Task 1 / Task 3）。
- 配置唯一来源：Profile 的 `cordis.patch.yml`；不写 `$DSH_HOME/cordis.patch.yml`、不写 `settings.yaml`。
- 密钥不写入任何配置文件；Web 与远程接口只返回 `{ configured, source }`，永不返回值。
- 共享钥匙串服务名：`ai.typesafe.api-key`（常量 `SHARED_KEYCHAIN_SERVICE`），账户 `$USER`。
- dsh 凭据文件：`$DSH_HOME/.credentials.yaml`（`DSH_HOME` 默认 `<home>/.dsh`），格式 `version: 1` + `refs: { TYPESAFE_API_KEY: <值> }`，写入必须经 `withFileLock` + `writeFileAtomic(filename, text, { mode: 0o600 })`。
- 写入接口只在 `ctx.webServer.host === '127.0.0.1'` 时可用。
- 命令行与 Web 文案只提供中文，集中在 `src/cli/messages.ts` 与 `src/client/locale.ts`。
- 覆盖率门槛不降低：行 80%、分支 70%。
- 不提交到 git，除非用户明确要求（本仓库当前约定）；各任务末尾的 commit 步骤在获得用户同意后执行。

---

## 文件结构

```text
src/
  profile/
    locate.ts          定位 DSH_HOME、Profile 目录、bundle 列表、patchReload
    patch-file.ts      读写 cordis.patch.yml 中 agent-kit-* 行（yaml Document API）
    kit-entries.ts     四个 Service 的元数据（id、模块名、schema、跨字段校验）
    index.ts
  secrets/
    keychain.ts        macOS 钥匙串读写（security，写入经标准输入）
    credentials-file.ts dsh 凭据文件读写（加锁、原子、0600）
    typesafe-key.ts    resolveTypesafeKey / saveTypesafeKey / describeTypesafeKey
    index.ts
  checks/
    types.ts           Check、CheckResult、CheckContext
    common.ts dingtalk.ts agent-tasks.ts jev.ts
    run.ts             runChecks(context) → CheckReport
    index.ts
  cli/
    main.ts            参数解析与子命令分发（bin 入口）
    doctor.ts          输出 CheckReport（文本 / JSON）
    setup.ts           交互流程（依赖可替换的 Prompter）
    prompter.ts        Prompter 接口与 @inquirer/prompts 实现
    messages.ts        中文文案
  admin/
    service.ts         AgentKitAdmin extends TypertRemoteService
    plugin.ts          根入口的 name / inject / apply
  client/
    index.tsx          前端插件入口（apply / inject）
    remote.ts          $mount 用的接口描述
    settings-page.tsx  「Agent Kit」设置页
    service-card.tsx   单个 Service 卡片（开关、状态、检查结果、表单）
    forms.tsx          四个 Service 的表单
    locale.ts          中文文案
    host-types.ts      dsh 前端上下文的最小类型声明
  common/process.ts    （修改）Windows 进程树终止
  jev/service.ts       （修改）改用 secrets/
  index.ts             （修改）导出 name / inject / apply
scripts/build-client.mjs  esbuild 构建 + dsh 模块外包装
bin/dsh-agent-kit.mjs     可执行入口，加载 lib/cli/main.js
```

---

### Task 1: 前端模块链路打通（原型转正式骨架）

验证并固定「根入口常驻行 + 前端模块构建 + dsh Web 加载设置页」这条链路。这是规格风险第 1 项；若 Step 7 在浏览器中看不到设置页，停止后续 client 相关任务并按规格降级为独立本地页面，重新评估计划。

**Files:**
- Create: `scripts/build-client.mjs`、`src/client/index.tsx`、`src/client/host-types.ts`、`src/admin/plugin.ts`
- Modify: `src/index.ts`、`patch.yml`、`package.json`、`tsconfig.json`、`tsconfig.build.json`
- Test: `tests/unit/client-build.test.ts`

**Interfaces:**
- Produces: 根入口 `export const name = 'agent-kit'`、`export const inject`、`export function apply(ctx)`；前端 `lib/client.js` 以 `window.__ModuleLoader__.load({ id: '@mc/dsh-agent-kit', factory })` 注册；`npm run build` 同时产出服务端与前端。

- [ ] **Step 1: 安装依赖**

```bash
npm i -D esbuild@^0.25 @types/react@^18 react@^18 react-dom@^18 jsdom@^26 @testing-library/react@^16
npm i @deepseek-ai/dsh-typert-protocol@0.1.5-rc.3
```

`@deepseek-ai/dsh-typert-protocol` 进 `dependencies`：它没有运行时依赖（只对 cordis 有 peer），`AgentKitAdmin` 在导入时即需要它。`react` 只用于前端构建与测试，运行时由 dsh 前端提供。

- [ ] **Step 2: 写失败测试——构建产物带 dsh 模块外包装且不打包共享模块**

```ts
// tests/unit/client-build.test.ts
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')

describe('client bundle', () => {
  it('is wrapped for the dsh module loader and keeps shared modules external', () => {
    execFileSync(process.execPath, [resolve(ROOT, 'scripts/build-client.mjs')], { cwd: ROOT })
    const text = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8')
    expect(text.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(text).toContain('id: "@mc/dsh-agent-kit"')
    expect(text).toContain('require("react")')
    expect(text).not.toMatch(/function createElement|react\.production/)
    // 模拟 dsh 前端加载：factory 返回 apply 与 inject
    let registered: { id: string; factory: (req: (m: string) => unknown) => Record<string, unknown> } | undefined
    const window = { __ModuleLoader__: { load: (m: typeof registered) => void (registered = m) } }
    new Function('window', text)(window)
    const shared: Record<string, unknown> = { react: {}, 'react/jsx-runtime': { jsx: () => null, jsxs: () => null }, '@deepseek-ai/dsh-client-ui-primitives': {} }
    const mod = registered!.factory((name) => {
      if (!(name in shared)) throw new Error(`unexpected require ${name}`)
      return shared[name]
    })
    expect(typeof mod.apply).toBe('function')
    expect(mod.inject).toEqual(['slots', 'locale', 'remote'])
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/unit/client-build.test.ts`
Expected: FAIL（`scripts/build-client.mjs` 不存在）

- [ ] **Step 4: 前端最小插件与宿主类型**

```ts
// src/client/host-types.ts
// dsh 前端上下文中本包用到的最小类型（官方类型包的已发布版本落后，这里按 0.1.5-rc.3 的实际结构声明）。
import type { ComponentType } from 'react'

export interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

export interface ClientContext {
  effect(execute: () => (() => void) | void, label?: string): void
  locale: {
    register(ns: string, dicts: { zh: Record<string, string>; en?: Record<string, string> }): () => void
    bind(ns: string): (key: string, vars?: Record<string, string | number>) => string
  }
  slots: {
    inject(key: string, register: () => unknown): void
    register<P>(options: Record<string, unknown>, component: ComponentType<P>): () => void
  }
  remote: {
    $mount(contribution: unknown): Promise<() => void>
    $host: { isLoopback: boolean }
    [service: string]: unknown
  }
}
```

```tsx
// src/client/index.tsx
import type { ClientContext } from './host-types.js'

export const inject = ['slots', 'locale', 'remote']

const NS = 'settings.agentKit'

function Placeholder() {
  return <div data-testid="agent-kit-settings">Agent Kit</div>
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh: { nav: 'Agent Kit' } }), 'agent-kit: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'agent-kit', order: 40, label: () => t('nav'), locale: NS }, Placeholder),
  )
}
```

- [ ] **Step 5: 构建脚本**

```js
// scripts/build-client.mjs
// 把 src/client/index.tsx 构建为 dsh 前端模块：CommonJS 函数体 + window.__ModuleLoader__ 外包装。
// dsh 前端只提供下列共享模块，其余依赖必须打包进来。
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const result = await build({
  entryPoints: [resolve(ROOT, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: SHARED,
  write: false,
  minify: false,
  legalComments: 'none',
})
const body = result.outputFiles[0].text
const wrapped = [
  'window.__ModuleLoader__.load({',
  '\tid: "@mc/dsh-agent-kit",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body.replace(/^/gm, '\t\t'),
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')
mkdirSync(resolve(ROOT, 'lib'), { recursive: true })
writeFileSync(resolve(ROOT, 'lib/client.js'), wrapped)
```

- [ ] **Step 6: 根入口插件、patch 行、package.json**

```ts
// src/admin/plugin.ts
import type { Context } from '@deepseek-ai/cordis'

/** 根入口插件：常驻加载，承载 AgentKitAdmin（Task 8）并让 dsh 发现本包的前端模块。 */
export const name = 'agent-kit'
export const inject = { loader: { required: true }, webServer: { required: false }, credentials: { required: false } }

export function apply(_ctx: Context): void {
  // Task 8 在此挂载 AgentKitAdmin
}
```

在 `src/index.ts` 末尾追加：

```ts
export { name, inject, apply } from './admin/plugin.js'
```

`patch.yml` 的 insert 列表最前面追加一行（不带 `disabled`，常驻）：

```yaml
    - id: agent-kit
      name: '@mc/dsh-agent-kit'
```

`package.json` 修改：`exports` 增加 `"./client": { "default": "./lib/client.js" }`；`dsh` 增加 `"client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"] }`；`scripts.build` 改为 `"tsc -p tsconfig.build.json && node scripts/build-client.mjs"`。`tsconfig.json` / `tsconfig.build.json` 增加 `"jsx": "react-jsx"`，`lib` 增加 `"DOM"`；`tsconfig.build.json` 的 `exclude` 增加 `"src/client"`（前端由 esbuild 构建，不产出到 lib/client/）。

- [ ] **Step 7: 运行测试确认通过，并在真实 dsh Web 中验证**

Run: `npx vitest run tests/unit/client-build.test.ts`
Expected: PASS

真实验证（手动，结果记录到规格「核实结论」）：

```bash
npm run build && npm pack
export DSH_HOME="$(mktemp -d)"
npx -y @deepseek-ai/dsh@0.1.5-rc.3 --profile kit --from-default-profile web --no-open &
# 等待启动日志出现地址后 Ctrl+C，再安装本包
npx -y @deepseek-ai/dsh@0.1.5-rc.3 plugin --profile kit add "$PWD/mc-dsh-agent-kit-0.1.0.tgz"
npx -y @deepseek-ai/dsh@0.1.5-rc.3 --profile kit --no-open
```

在浏览器中打开启动日志给出的地址 → 设置 → 左侧出现「Agent Kit」，点开显示 “Agent Kit”。
Expected: 设置页可见。若不可见，记录浏览器控制台错误并停止 client 相关任务（Task 9），按规格降级。

- [ ] **Step 8: Commit（经用户同意后）**

```bash
git add scripts/build-client.mjs src/client src/admin/plugin.ts src/index.ts patch.yml package.json package-lock.json tsconfig.json tsconfig.build.json tests/unit/client-build.test.ts
git commit -m "feat: add root plugin and dsh web client module skeleton"
```

---

### Task 2: profile/ —— Profile 定位与 patch 文件编辑

**Files:**
- Create: `src/profile/locate.ts`、`src/profile/kit-entries.ts`、`src/profile/patch-file.ts`、`src/profile/index.ts`
- Test: `tests/unit/profile.test.ts`

**Interfaces:**
- Consumes: 各 Service 的 Config schema 与跨字段校验（`WsConfig`/`assertWsConfig`、`DingtalkConfig`、`AgentTasksConfig`、`JevConfig`）。
- Produces:
  - `type KitId = 'agent-kit-ws' | 'agent-kit-dingtalk' | 'agent-kit-agent-tasks' | 'agent-kit-jev'`
  - `KIT_ENTRIES: readonly KitEntryMeta[]`，`KitEntryMeta = { id: KitId; service: ServiceName; module: string; title: string; validate(config: unknown): { ok: true; value: unknown } | { ok: false; errors: FieldError[] } }`，`FieldError = { path: string; message: string }`
  - `resolveDshHome(env?: NodeJS.ProcessEnv): string`
  - `listProfiles(home?: string): Promise<string[]>`
  - `locateProfile(name: string, home?: string): Promise<ProfileInfo>`，`ProfileInfo = { name; dir; patchFile; bundles: string[]; patchReload: 'live' | 'startup'; hasKit: boolean }`
  - `readKitEntries(patchFile: string): Promise<KitSnapshot>`，`KitSnapshot = { version: string; entries: Record<KitId, { enabled: boolean; config: Record<string, unknown> | undefined }> }`
  - `writeKitEntries(patchFile: string, changes: Partial<Record<KitId, { enabled: boolean; config?: Record<string, unknown> }>>, expectedVersion: string): Promise<{ version: string }>`，失败时抛 `ProfileError`（`code: 'conflict' | 'invalid_config' | 'unsupported_yaml' | 'parse_error'`，`details.errors?: FieldError[]`，`details.line?: number`）
  - `previewKitEntries(patchFile, changes): Promise<{ before: string; after: string }>`（setup 的差异视图用）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/profile.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KIT_ENTRIES, listProfiles, locateProfile, previewKitEntries, readKitEntries, resolveDshHome, writeKitEntries } from '../../src/profile/index.js'
import { isKitError } from '../../src/common/errors.js'

let home: string
let profileDir: string
let patchFile: string

const ORIGINAL = `# 用户自己的注释
- id: tools
  config:
    mode: basic
# 启用钉钉
- id: agent-kit-dingtalk
  disabled: false
  config:
    identity: bot   # 行内注释
    robotCode: ding1
`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  profileDir = join(home, 'profiles', 'kit')
  mkdirSync(profileDir, { recursive: true })
  patchFile = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchFile, ORIGINAL)
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@mc/dsh-agent-kit'], patchReload: 'live' } } }))
  mkdirSync(join(home, 'profiles', 'other'))
  writeFileSync(join(home, 'profiles', 'other', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('locate', () => {
  it('resolves DSH_HOME with the dsh default', () => {
    expect(resolveDshHome({})).toBe(join(homedir(), '.dsh'))
    expect(resolveDshHome({ DSH_HOME: '/x/y' })).toMatch(/[\\/]x[\\/]y$/)
  })

  it('lists profiles and reads bundle / reload facts', async () => {
    expect((await listProfiles(home)).sort()).toEqual(['kit', 'other'])
    const kit = await locateProfile('kit', home)
    expect(kit).toMatchObject({ name: 'kit', patchFile, patchReload: 'live', hasKit: true })
    const other = await locateProfile('other', home)
    expect(other).toMatchObject({ hasKit: false, patchReload: 'startup' })
    await expect(locateProfile('missing', home)).rejects.toThrow(/missing/)
  })
})

describe('patch file', () => {
  it('reads kit entries with defaults for absent rows', async () => {
    const snap = await readKitEntries(patchFile)
    expect(snap.version).toMatch(/^[0-9a-f]{64}$/)
    expect(snap.entries['agent-kit-dingtalk']).toEqual({ enabled: true, config: { identity: 'bot', robotCode: 'ding1' } })
    expect(snap.entries['agent-kit-ws']).toEqual({ enabled: false, config: undefined })
  })

  it('updates existing rows and appends missing ones, preserving comments and other rows', async () => {
    const { version } = await readKitEntries(patchFile)
    await writeKitEntries(
      patchFile,
      {
        'agent-kit-dingtalk': { enabled: true, config: { identity: 'bot', robotCode: 'ding2' } },
        'agent-kit-ws': { enabled: true },
      },
      version,
    )
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toContain('# 用户自己的注释')
    expect(text).toContain('# 启用钉钉')
    expect(text).toContain('mode: basic')
    expect(text).toContain('robotCode: ding2')
    expect(text).toMatch(/- id: agent-kit-ws\n\s+disabled: false/)
    const snap = await readKitEntries(patchFile)
    expect(snap.entries['agent-kit-ws'].enabled).toBe(true)
  })

  it('disables a row without dropping its config', async () => {
    const { version } = await readKitEntries(patchFile)
    await writeKitEntries(patchFile, { 'agent-kit-dingtalk': { enabled: false } }, version)
    expect((await readKitEntries(patchFile)).entries['agent-kit-dingtalk']).toEqual({ enabled: false, config: { identity: 'bot', robotCode: 'ding1' } })
  })

  it('creates the file when absent', async () => {
    rmSync(patchFile)
    const { version } = await readKitEntries(patchFile)
    await writeKitEntries(patchFile, { 'agent-kit-jev': { enabled: true, config: { model: 'jev-latest' } } }, version)
    expect((await readKitEntries(patchFile)).entries['agent-kit-jev'].enabled).toBe(true)
  })

  it('rejects stale versions', async () => {
    const { version } = await readKitEntries(patchFile)
    writeFileSync(patchFile, `${ORIGINAL}\n# 别人改过\n`)
    const err = await writeKitEntries(patchFile, { 'agent-kit-ws': { enabled: true } }, version).catch((e: unknown) => e)
    expect(isKitError(err) && err.code).toBe('conflict')
  })

  it('validates config with the service schema and cross-field rules', async () => {
    const { version } = await readKitEntries(patchFile)
    const bad = await writeKitEntries(patchFile, { 'agent-kit-ws': { enabled: true, config: { pingIntervalMs: 30000, readTimeoutMs: 1000 } } }, version).catch((e: unknown) => e)
    expect(isKitError(bad) && bad.code).toBe('invalid_config')
    expect((bad as { details: { errors: { path: string }[] } }).details.errors[0]!.path).toMatch(/readTimeoutMs/)
    const bad2 = await writeKitEntries(patchFile, { 'agent-kit-dingtalk': { enabled: true, config: { identity: 'nobody' } } }, version).catch((e: unknown) => e)
    expect(isKitError(bad2) && bad2.code).toBe('invalid_config')
    expect(readFileSync(patchFile, 'utf8')).toBe(ORIGINAL)
  })

  it('refuses to edit kit rows containing !!js', async () => {
    writeFileSync(patchFile, `- id: agent-kit-jev\n  disabled: !!js process.env.X === '1'\n`)
    const { version } = await readKitEntries(patchFile)
    const err = await writeKitEntries(patchFile, { 'agent-kit-jev': { enabled: true } }, version).catch((e: unknown) => e)
    expect(isKitError(err) && err.code).toBe('unsupported_yaml')
    expect((err as { details: { line: number } }).details.line).toBe(2)
  })

  it('reports unparsable files', async () => {
    writeFileSync(patchFile, '- id: [unclosed\n')
    await expect(readKitEntries(patchFile)).rejects.toMatchObject({ code: 'parse_error' })
  })

  it('previews changes without writing', async () => {
    const { before, after } = await previewKitEntries(patchFile, { 'agent-kit-ws': { enabled: true } })
    expect(before).toBe(ORIGINAL)
    expect(after).toContain('agent-kit-ws')
    expect(readFileSync(patchFile, 'utf8')).toBe(ORIGINAL)
  })

  it('exposes metadata for all four services', () => {
    expect(KIT_ENTRIES.map((e) => e.id)).toEqual(['agent-kit-ws', 'agent-kit-dingtalk', 'agent-kit-agent-tasks', 'agent-kit-jev'])
    expect(KIT_ENTRIES.find((e) => e.id === 'agent-kit-agent-tasks')!.validate({}).ok).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/profile.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 安装依赖并实现**

```bash
npm i yaml@^2.8
```

```ts
// src/profile/kit-entries.ts
import { AgentTasksConfig } from '../agent-tasks/config.js'
import { DingtalkConfig } from '../dingtalk/config.js'
import type { ServiceName } from '../common/errors.js'
import { JevConfig } from '../jev/service.js'
import { WsConfig, assertWsConfig } from '../ws/config.js'

export type KitId = 'agent-kit-ws' | 'agent-kit-dingtalk' | 'agent-kit-agent-tasks' | 'agent-kit-jev'
export interface FieldError {
  path: string
  message: string
}
export type ValidateResult = { ok: true; value: unknown } | { ok: false; errors: FieldError[] }

export interface KitEntryMeta {
  id: KitId
  service: ServiceName
  module: string
  title: string
  validate(config: unknown): ValidateResult
}

type Schema = (value: unknown) => unknown

function validator(schema: Schema, extra?: (value: never) => void): (config: unknown) => ValidateResult {
  return (config) => {
    let value: unknown
    try {
      value = schema(config ?? {})
    } catch (e) {
      // schemastery 的错误信息形如 "$.a.b expected ..."
      const message = (e as Error).message
      const path = /\$\.([\w.[\]-]+)/.exec(message)?.[1] ?? ''
      return { ok: false, errors: [{ path, message }] }
    }
    try {
      extra?.(value as never)
    } catch (e) {
      const field = (e as { details?: { field?: string } }).details?.field ?? ''
      return { ok: false, errors: [{ path: field, message: (e as Error).message }] }
    }
    return { ok: true, value }
  }
}

export const KIT_ENTRIES: readonly KitEntryMeta[] = [
  { id: 'agent-kit-ws', service: 'agentWs', module: '@mc/dsh-agent-kit/ws', title: 'WebSocket', validate: validator(WsConfig as unknown as Schema, assertWsConfig) },
  { id: 'agent-kit-dingtalk', service: 'dingtalk', module: '@mc/dsh-agent-kit/dingtalk', title: '钉钉', validate: validator(DingtalkConfig as unknown as Schema, validateDingtalk) },
  { id: 'agent-kit-agent-tasks', service: 'agentTasks', module: '@mc/dsh-agent-kit/agent-tasks', title: 'Agent 任务', validate: validator(AgentTasksConfig as unknown as Schema) },
  { id: 'agent-kit-jev', service: 'jev', module: '@mc/dsh-agent-kit/jev', title: 'Jev 判断', validate: validator(JevConfig as unknown as Schema) },
]

/** 与 DingtalkService 构造函数一致的身份组合校验（不依赖环境变量与 dws）。 */
function validateDingtalk(config: { identity: string; robotCode?: string; webhookTokenEnv?: string; defaultTarget?: unknown }): void {
  const fail = (field: string, message: string) => {
    throw Object.assign(new Error(message), { details: { field } })
  }
  if (config.identity === 'bot' && !config.robotCode) fail('robotCode', 'bot 身份必须填写 robotCode')
  if (config.identity === 'webhook' && !config.webhookTokenEnv) fail('webhookTokenEnv', 'webhook 身份必须填写 webhookTokenEnv')
  if (config.identity === 'webhook' && config.defaultTarget) fail('defaultTarget', 'webhook 身份不能设置 defaultTarget')
}

export function kitEntry(id: KitId): KitEntryMeta {
  return KIT_ENTRIES.find((e) => e.id === id)!
}
```

```ts
// src/profile/locate.ts
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProfileError } from './patch-file.js'

export interface ProfileInfo {
  name: string
  dir: string
  patchFile: string
  bundles: string[]
  patchReload: 'live' | 'startup'
  hasKit: boolean
}

export const KIT_PACKAGE = '@mc/dsh-agent-kit'

/** 与 dsh 一致：DSH_HOME 非空时使用它，否则为 <home>/.dsh；支持 ~ 前缀。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
  const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1).replace(/^[\\/]/, '')) : raw
  return resolve(expanded)
}

export async function listProfiles(home = resolveDshHome()): Promise<string[]> {
  try {
    const entries = await readdir(join(home, 'profiles'), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export async function locateProfile(name: string, home = resolveDshHome()): Promise<ProfileInfo> {
  const dir = join(home, 'profiles', name)
  let manifest: { dsh?: { profile?: { bundles?: string[]; patchReload?: string } } }
  try {
    manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    throw new ProfileError('profile_not_found', `profile ${name} not found under ${home}`)
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  return {
    name,
    dir,
    patchFile: join(dir, 'cordis.patch.yml'),
    bundles,
    patchReload: manifest.dsh?.profile?.patchReload === 'live' ? 'live' : 'startup',
    hasKit: bundles.includes(KIT_PACKAGE),
  }
}
```

`ProfileError` 继承 `KitError`，其 `service` 为 `'kit'`：把 `src/common/errors.ts` 的 `ServiceName` 扩展为 `'agentWs' | 'dingtalk' | 'agentTasks' | 'jev' | 'kit'`（`kit` 表示配置引导相关错误），不影响现有 Service。

```ts
// src/profile/patch-file.ts
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { KitError } from '../common/errors.js'
import { KIT_ENTRIES, kitEntry, type FieldError, type KitId } from './kit-entries.js'

export type ProfileErrorCode = 'conflict' | 'invalid_config' | 'unsupported_yaml' | 'parse_error' | 'profile_not_found'

export class ProfileError extends KitError {
  constructor(code: ProfileErrorCode, message: string, details?: { errors?: FieldError[]; line?: number }) {
    super('kit', code, message, { retryable: code === 'conflict', details })
    this.name = 'ProfileError'
  }
}

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
    if (change.enabled) {
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
```

```ts
// src/profile/index.ts
export * from './kit-entries.js'
export * from './locate.js'
export * from './patch-file.js'
```


- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/profile.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit（经用户同意后）**

```bash
git add src/profile src/common/errors.ts tests/unit/profile.test.ts package.json package-lock.json
git commit -m "feat(profile): read and write agent-kit rows in profile patch file"
```

---

### Task 3: secrets/ —— TypeSafe Key 的读取与保存，并接入 JevService

**Files:**
- Create: `src/secrets/keychain.ts`、`src/secrets/credentials-file.ts`、`src/secrets/typesafe-key.ts`、`src/secrets/index.ts`
- Modify: `src/jev/service.ts`（改用 `resolveTypesafeKey`，注入可选 `credentials`）、`src/jev/index.ts`
- Test: `tests/unit/secrets.test.ts`；更新 `tests/unit/jev.test.ts`

**Interfaces:**
- Consumes: `runProcess`、`pickEnv`、`BASE_ENV_WHITELIST`（`src/common/process.ts`）；`resolveDshHome`（Task 2）；`SHARED_KEYCHAIN_SERVICE`（`src/jev/service.ts`，移动到 `src/secrets/typesafe-key.ts` 并由 jev 重新导出）。
- Produces:
  - `interface Keychain { read(service, account): Promise<string | undefined>; write(service, account, value): Promise<void>; remove(service, account): Promise<void> }`，`macosKeychain: Keychain`
  - `readCredential(ref: string, file?: string): Promise<string | undefined>`、`writeCredential(ref, value: string | undefined, file?)`、`credentialsFile(home?: string): string`
  - `type KeySource = 'env' | `keychain:${string}` | 'credentials'`
  - `interface KeyStoreOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; keychainService?: string | string[]; keychainAccount?: string; keychain?: Keychain; credentials?: { resolve(ref: string): Promise<{ value: string } | undefined> }; credentialsFile?: string }`
  - `resolveTypesafeKey(opts): Promise<{ key: string; source: KeySource } | undefined>`
  - `describeTypesafeKey(opts): Promise<{ configured: boolean; source?: KeySource }>`
  - `saveTypesafeKey(target: 'keychain' | 'credentials', value: string, opts): Promise<void>`、`clearTypesafeKey(target, opts): Promise<void>`
  - `defaultKeyTarget(platform = process.platform): 'keychain' | 'credentials'`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/secrets.test.ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearTypesafeKey,
  credentialsFile,
  defaultKeyTarget,
  describeTypesafeKey,
  macosKeychain,
  readCredential,
  resolveTypesafeKey,
  saveTypesafeKey,
  writeCredential,
  type Keychain,
} from '../../src/secrets/index.js'

let home: string
let file: string
const memory = new Map<string, string>()
const fakeKeychain: Keychain = {
  read: async (s, a) => memory.get(`${s}/${a}`),
  write: async (s, a, v) => void memory.set(`${s}/${a}`, v),
  remove: async (s, a) => void memory.delete(`${s}/${a}`),
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  file = credentialsFile(home)
  memory.clear()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('credentials file', () => {
  it('writes version 1 layout with 0600 and preserves other refs', async () => {
    writeFileSync(file, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ds-1\n', { mode: 0o600 })
    await writeCredential('TYPESAFE_API_KEY', 'ts-1', file)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('DEEPSEEK_API_KEY: ds-1')
    expect(text).toContain('TYPESAFE_API_KEY: ts-1')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBe('ts-1')
    await writeCredential('TYPESAFE_API_KEY', undefined, file)
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toContain('DEEPSEEK_API_KEY')
  })

  it('creates the file when missing and treats empty values as absent', async () => {
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBeUndefined()
    await writeCredential('TYPESAFE_API_KEY', 'v', file)
    expect(readFileSync(file, 'utf8')).toMatch(/^version: 1\n/)
    writeFileSync(file, 'version: 1\nrefs:\n  TYPESAFE_API_KEY: ""\n')
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBeUndefined()
  })
})

describe('typesafe key', () => {
  const base = () => ({ env: {}, platform: 'darwin' as const, keychain: fakeKeychain, keychainAccount: 'alice', credentialsFile: file })

  it('resolves env, then keychain services in order, then credentials', async () => {
    expect(await resolveTypesafeKey(base())).toBeUndefined()
    await writeCredential('TYPESAFE_API_KEY', 'from-file', file)
    expect(await resolveTypesafeKey(base())).toEqual({ key: 'from-file', source: 'credentials' })
    memory.set('gitflow-cli-typesafe/alice', 'from-old')
    expect(await resolveTypesafeKey({ ...base(), keychainService: ['ai.typesafe.api-key', 'gitflow-cli-typesafe'] })).toEqual({ key: 'from-old', source: 'keychain:gitflow-cli-typesafe' })
    memory.set('ai.typesafe.api-key/alice', 'from-new')
    expect(await resolveTypesafeKey({ ...base(), keychainService: ['ai.typesafe.api-key', 'gitflow-cli-typesafe'] })).toEqual({ key: 'from-new', source: 'keychain:ai.typesafe.api-key' })
    expect(await resolveTypesafeKey({ ...base(), env: { TYPESAFE_API_KEY: 'from-env' }, keychainService: 'ai.typesafe.api-key' })).toEqual({ key: 'from-env', source: 'env' })
  })

  it('prefers the running dsh credentials service over direct file reads', async () => {
    const credentials = { resolve: async () => ({ value: 'from-service' }) }
    expect(await resolveTypesafeKey({ ...base(), credentials })).toEqual({ key: 'from-service', source: 'credentials' })
  })

  it('skips the keychain outside macOS', async () => {
    memory.set('ai.typesafe.api-key/alice', 'k')
    expect(await resolveTypesafeKey({ ...base(), platform: 'linux', keychainService: 'ai.typesafe.api-key' })).toBeUndefined()
  })

  it('describes without revealing the value', async () => {
    memory.set('ai.typesafe.api-key/alice', 'secret-value')
    const d = await describeTypesafeKey({ ...base(), keychainService: 'ai.typesafe.api-key' })
    expect(d).toEqual({ configured: true, source: 'keychain:ai.typesafe.api-key' })
    expect(JSON.stringify(d)).not.toContain('secret-value')
  })

  it('saves and clears in the chosen target', async () => {
    await saveTypesafeKey('keychain', 'k1', { ...base(), keychainService: ['ai.typesafe.api-key', 'gitflow-cli-typesafe'] })
    expect(memory.get('ai.typesafe.api-key/alice')).toBe('k1')
    await saveTypesafeKey('credentials', 'k2', base())
    expect(await readCredential('TYPESAFE_API_KEY', file)).toBe('k2')
    await clearTypesafeKey('keychain', { ...base(), keychainService: 'ai.typesafe.api-key' })
    expect(memory.has('ai.typesafe.api-key/alice')).toBe(false)
    await expect(saveTypesafeKey('keychain', 'k', { ...base(), platform: 'linux' })).rejects.toThrow(/macOS/)
  })

  it('picks the default target per platform', () => {
    expect(defaultKeyTarget('darwin')).toBe('keychain')
    expect(defaultKeyTarget('linux')).toBe('credentials')
    expect(defaultKeyTarget('win32')).toBe('credentials')
  })

  it.skipIf(process.platform !== 'darwin')('real macOS keychain round trip', async () => {
    const service = `dsh-agent-kit-test-${process.pid}`
    const account = process.env.USER!
    try {
      await macosKeychain.write(service, account, 'round-trip-value')
      expect(await macosKeychain.read(service, account)).toBe('round-trip-value')
      await macosKeychain.write(service, account, 'updated')
      expect(await macosKeychain.read(service, account)).toBe('updated')
    } finally {
      await macosKeychain.remove(service, account)
    }
    expect(await macosKeychain.read(service, account)).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/secrets.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 安装依赖并实现**

```bash
npm i @deepseek-ai/dsh-atomic-write@0.1.5-rc.3
```

`dsh-atomic-write` 进 `dependencies`：命令行在 dsh 之外运行也需要与 dsh 相同的跨进程锁；它没有运行时依赖。

```ts
// src/secrets/keychain.ts
import { spawn } from 'node:child_process'
import { BASE_ENV_WHITELIST, pickEnv, runProcess } from '../common/process.js'

export interface Keychain {
  read(service: string, account: string): Promise<string | undefined>
  write(service: string, account: string, value: string): Promise<void>
  remove(service: string, account: string): Promise<void>
}

const SECURITY = '/usr/bin/security'
const env = () => pickEnv(BASE_ENV_WHITELIST)

export const macosKeychain: Keychain = {
  async read(service, account) {
    const r = await runProcess(SECURITY, ['find-generic-password', '-a', account, '-s', service, '-w'], { env: env(), timeoutMs: 5000, killGraceMs: 500, maxOutputBytes: 64 * 1024 })
    if (r.exitCode !== 0) return undefined
    const key = r.stdout.replace(/[\r\n]+$/, '')
    return key.trim() ? key : undefined
  },
  // -w 作为最后一个参数且不带值时，security 从标准输入读取密码（提示两次），值不会出现在进程参数中
  write(service, account, value) {
    return new Promise((resolve, reject) => {
      const child = spawn(SECURITY, ['add-generic-password', '-a', account, '-s', service, '-U', '-w'], { env: env(), stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`security add-generic-password exited with ${code}: ${stderr.trim()}`))))
      child.stdin.end(`${value}\n${value}\n`)
    })
  },
  async remove(service, account) {
    await runProcess(SECURITY, ['delete-generic-password', '-a', account, '-s', service], { env: env(), timeoutMs: 5000, killGraceMs: 500 })
  },
}
```

```ts
// src/secrets/credentials-file.ts
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
```

```ts
// src/secrets/typesafe-key.ts
import { macosKeychain, type Keychain } from './keychain.js'
import { credentialsFile, readCredential, writeCredential } from './credentials-file.js'

export const TYPESAFE_KEY_REF = 'TYPESAFE_API_KEY'
/** 与其他工具（如 gitflow-cli）共享 TypeSafe Key 时推荐的钥匙串服务名。 */
export const SHARED_KEYCHAIN_SERVICE = 'ai.typesafe.api-key'

export type KeySource = 'env' | `keychain:${string}` | 'credentials'
export type KeyTarget = 'keychain' | 'credentials'

export interface KeyStoreOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  keychainService?: string | string[]
  keychainAccount?: string
  keychain?: Keychain
  /** 运行中的 dsh 凭据服务；缺省时直接读凭据文件。 */
  credentials?: { resolve(ref: string): Promise<{ value: string } | undefined> }
  credentialsFile?: string
}

const services = (o: KeyStoreOptions) => ([] as string[]).concat(o.keychainService ?? [])
const account = (o: KeyStoreOptions) => o.keychainAccount ?? (o.env ?? process.env).USER ?? ''
const isMac = (o: KeyStoreOptions) => (o.platform ?? process.platform) === 'darwin'

export function defaultKeyTarget(platform: NodeJS.Platform = process.platform): KeyTarget {
  return platform === 'darwin' ? 'keychain' : 'credentials'
}

export async function resolveTypesafeKey(o: KeyStoreOptions = {}): Promise<{ key: string; source: KeySource } | undefined> {
  const fromEnv = (o.env ?? process.env)[TYPESAFE_KEY_REF]
  if (fromEnv?.trim()) return { key: fromEnv, source: 'env' }
  if (isMac(o) && account(o)) {
    const keychain = o.keychain ?? macosKeychain
    for (const service of services(o)) {
      const key = await keychain.read(service, account(o))
      if (key) return { key, source: `keychain:${service}` }
    }
  }
  const stored = o.credentials ? (await o.credentials.resolve(TYPESAFE_KEY_REF))?.value : await readCredential(TYPESAFE_KEY_REF, o.credentialsFile ?? credentialsFile())
  return stored ? { key: stored, source: 'credentials' } : undefined
}

export async function describeTypesafeKey(o: KeyStoreOptions = {}): Promise<{ configured: boolean; source?: KeySource }> {
  const r = await resolveTypesafeKey(o)
  return r ? { configured: true, source: r.source } : { configured: false }
}

export async function saveTypesafeKey(target: KeyTarget, value: string, o: KeyStoreOptions = {}): Promise<void> {
  if (!value.trim()) throw new Error('TypeSafe Key 不能为空')
  if (target === 'keychain') {
    if (!isMac(o)) throw new Error('钥匙串仅在 macOS 上可用')
    await (o.keychain ?? macosKeychain).write(services(o)[0] ?? SHARED_KEYCHAIN_SERVICE, account(o), value)
    return
  }
  await writeCredential(TYPESAFE_KEY_REF, value, o.credentialsFile ?? credentialsFile())
}

export async function clearTypesafeKey(target: KeyTarget, o: KeyStoreOptions = {}): Promise<void> {
  if (target === 'keychain') {
    if (!isMac(o)) return
    await (o.keychain ?? macosKeychain).remove(services(o)[0] ?? SHARED_KEYCHAIN_SERVICE, account(o))
    return
  }
  await writeCredential(TYPESAFE_KEY_REF, undefined, o.credentialsFile ?? credentialsFile())
}
```

```ts
// src/secrets/index.ts
export * from './keychain.js'
export * from './credentials-file.js'
export * from './typesafe-key.js'
```

JevService 修改（`src/jev/service.ts`）：
- 删除 `KeychainReader`、`macosKeychainReader`、`static keychainReader`、`static platform`、`keychainEnabled()`，改为 `static keyStore: Pick<KeyStoreOptions, 'keychain' | 'platform' | 'credentialsFile'> = {}`（测试钩子）。
- `static inject = { credentials: { required: false } }`。
- 构造函数只做配置保存与 `controller` effect；`[Service.init]` 中：

```ts
const resolved = await resolveTypesafeKey({
  ...JevService.keyStore,
  keychainService: this.config.keychainService,
  keychainAccount: this.config.keychainAccount,
  credentials: (this.ctx as unknown as { get(name: string): KeyStoreOptions['credentials'] }).get('credentials'),
})
if (!resolved) {
  throw new ConfigError('jev', `${JEV_API_KEY_ENV} is not set, and no key was found in the keychain or the dsh credentials store`, { field: JEV_API_KEY_ENV })
}
this.useKey(resolved.key)
this.logger.info('api key resolved', { source: resolved.source })
```

- 非 macOS 且配置了 `keychainService` 时仍记录一次警告（`JevService.keyStore.platform ?? process.platform`）。
- `SHARED_KEYCHAIN_SERVICE` 改为从 `../secrets/typesafe-key.js` 重新导出；`src/jev/index.ts` 移除 `macosKeychainReader`、`KeychainReader`。

`tests/unit/jev.test.ts` 的 `keychain fallback` 用例改为设置 `JevService.keyStore = { platform: 'darwin', keychain: fakeKeychain }`，断言不变；新增用例：

```ts
it('falls back to the dsh credentials service', async () => {
  delete process.env.TYPESAFE_API_KEY
  JevService.keyStore = { platform: 'linux' }
  let seenKey = ''
  mock.factory = async (opts) => ((seenKey = opts.apiKey), { systemOne: async () => ({ model: 'm', answers: {} }) })
  restore()
  restore = mock.install()
  t.root.provide('credentials', { resolve: async (ref: string) => (ref === 'TYPESAFE_API_KEY' ? { value: 'svc-key-123', source: 'file' } : undefined) } as never)
  await setup()
  expect(seenKey).toBe('svc-key-123')
  expect(t.logs.some((l) => l.includes('"source":"credentials"'))).toBe(true)
})
```

原 “fails to start without TYPESAFE_API_KEY” 用例改为：

```ts
it('fails to start when no key source has a key', async () => {
  delete process.env.TYPESAFE_API_KEY
  JevService.keyStore = { platform: 'linux', credentialsFile: join(tmpdir(), `agent-kit-none-${process.pid}.yaml`) }
  await expect(t.root.plugin(JevService, {})).rejects.toThrow(/TYPESAFE_API_KEY is not set/)
})
```

`JevService.keyStore` 的类型因此为 `Pick<KeyStoreOptions, 'keychain' | 'platform' | 'credentialsFile'>`，`afterEach` 中恢复为 `{}`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/secrets.test.ts tests/unit/jev.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 真实环境回归**

Run: `env -u TYPESAFE_API_KEY AGENT_KIT_E2E_JEV_KEYCHAIN_SERVICE=ai.typesafe.api-key,gitflow-cli-typesafe npx vitest run --config vitest.e2e.config.ts -t jev`
Expected: PASS

- [ ] **Step 6: Commit（经用户同意后）**

```bash
git add src/secrets src/jev tests/unit/secrets.test.ts tests/unit/jev.test.ts package.json package-lock.json
git commit -m "feat(secrets): resolve TypeSafe key from env, keychain, or dsh credentials"
```

---

### Task 4: Windows 进程树终止与 CI 矩阵

**Files:**
- Modify: `src/common/process.ts`、`.github/workflows/ci.yml`
- Test: `tests/unit/common.test.ts`

**Interfaces:**
- Produces: `killTree(pid: number | undefined, signal: NodeJS.Signals, platform?: NodeJS.Platform, run?: (cmd: string, args: string[]) => void): void`（导出供测试）。

- [ ] **Step 1: 写失败测试**

在 `tests/unit/common.test.ts` 追加：

```ts
import { killTree } from '../../src/common/process.js'

describe('killTree', () => {
  it('uses taskkill /T /F on Windows', () => {
    const calls: Array<[string, string[]]> = []
    killTree(1234, 'SIGTERM', 'win32', (cmd, args) => void calls.push([cmd, args]))
    expect(calls).toEqual([['taskkill', ['/PID', '1234', '/T', '/F']]])
  })

  it('does nothing without a pid', () => {
    const calls: unknown[] = []
    killTree(undefined, 'SIGKILL', 'win32', () => void calls.push(1))
    expect(calls).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/common.test.ts -t killTree`
Expected: FAIL（`killTree` 未导出）

- [ ] **Step 3: 实现**

在 `src/common/process.ts` 中用 `killTree` 替换 `killGroup`：

```ts
import { spawn, spawnSync } from 'node:child_process'

export function killTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => void = (cmd, args) => void spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true }),
): void {
  if (pid === undefined) return
  if (platform === 'win32') {
    // Windows 没有进程组信号；/T 结束整个进程树，/F 强制
    run('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // 进程已退出
  }
}
```

`runProcess` 中的三处 `killGroup(child.pid, ...)` 改为 `killTree(child.pid, ...)`；`spawn` 选项增加 `windowsHide: true`。

`.github/workflows/ci.yml` 的 `matrix.os` 改为 `[ubuntu-latest, macos-latest, windows-latest]`，并在 `runs-on` 后增加：

```yaml
    defaults:
      run:
        shell: bash
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit（经用户同意后）**

```bash
git add src/common/process.ts tests/unit/common.test.ts .github/workflows/ci.yml
git commit -m "fix(process): terminate process trees on Windows; add windows to CI"
```

---

### Task 5: checks/ —— 结构化检查项

**Files:**
- Create: `src/checks/types.ts`、`src/checks/common.ts`、`src/checks/dingtalk.ts`、`src/checks/agent-tasks.ts`、`src/checks/jev.ts`、`src/checks/run.ts`、`src/checks/index.ts`
- Test: `tests/unit/checks.test.ts`

**Interfaces:**
- Consumes: `ProfileInfo`、`KitSnapshot`、`KIT_ENTRIES`（Task 2）；`describeTypesafeKey`、`KeyStoreOptions`（Task 3）；`resolveExecutable`（`src/dingtalk/service.ts`）；`runProcess`、`pickEnv`、`BASE_ENV_WHITELIST`、`DWS_ENV_WHITELIST`。
- Produces:
  - `type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'`
  - `interface CheckResult { id: string; scope: 'common' | KitId; title: string; status: CheckStatus; detail: string; fix?: string }`
  - `interface CheckContext { profile: ProfileInfo; snapshot: KitSnapshot; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; nodeVersion: string; resolveModule(name: string): boolean; exec(file: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }>; keyStore: KeyStoreOptions; findExecutable(name: string): string | undefined }`
  - `createCheckContext(profile: ProfileInfo, overrides?: Partial<CheckContext>): Promise<CheckContext>`
  - `runChecks(ctx: CheckContext): Promise<CheckReport>`，`CheckReport = { profile: string; ok: boolean; results: CheckResult[] }`（`ok` = 无 `fail`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/checks.test.ts
import { describe, expect, it } from 'vitest'
import { runChecks, type CheckContext } from '../../src/checks/index.js'
import type { KitSnapshot } from '../../src/profile/index.js'

function snapshot(entries: Partial<KitSnapshot['entries']>): KitSnapshot {
  const off = { enabled: false, config: undefined }
  return {
    version: 'v',
    entries: { 'agent-kit-ws': off, 'agent-kit-dingtalk': off, 'agent-kit-agent-tasks': off, 'agent-kit-jev': off, ...entries },
  }
}

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    profile: { name: 'kit', dir: '/p', patchFile: '/p/cordis.patch.yml', bundles: ['@deepseek-ai/dsh-base', '@mc/dsh-agent-kit'], patchReload: 'live', hasKit: true },
    snapshot: snapshot({}),
    env: {},
    platform: 'darwin',
    nodeVersion: '24.1.0',
    resolveModule: () => true,
    exec: async () => ({ exitCode: 0, stdout: JSON.stringify({ authenticated: true, token_valid: true }), stderr: '' }),
    keyStore: { env: {}, platform: 'linux', credentialsFile: '/nonexistent/.credentials.yaml' },
    findExecutable: () => '/usr/bin/dws',
    ...over,
  }
}

const byId = (r: Awaited<ReturnType<typeof runChecks>>, id: string) => r.results.find((x) => x.id === id)

describe('common checks', () => {
  it('passes a healthy profile with nothing enabled', async () => {
    const r = await runChecks(ctx())
    expect(r.ok).toBe(true)
    expect(byId(r, 'node')!.status).toBe('pass')
    expect(byId(r, 'bundle')!.status).toBe('pass')
    expect(r.results.every((x) => x.scope === 'common')).toBe(true)
  })

  it('fails on old node, missing bundle, and warns on startup reload', async () => {
    const r = await runChecks(ctx({ nodeVersion: '20.10.0', profile: { ...ctx().profile, hasKit: false, patchReload: 'startup' } }))
    expect(byId(r, 'node')!.status).toBe('fail')
    expect(byId(r, 'bundle')).toMatchObject({ status: 'fail', fix: expect.stringContaining('dsh plugin --profile kit add @mc/dsh-agent-kit') })
    expect(byId(r, 'patch-reload')!.status).toBe('warn')
    expect(r.ok).toBe(false)
  })
})

describe('service checks', () => {
  it('validates config of enabled services', async () => {
    const r = await runChecks(ctx({ snapshot: snapshot({ 'agent-kit-ws': { enabled: true, config: { pingIntervalMs: 30000, readTimeoutMs: 1000 } } }) }))
    expect(byId(r, 'agent-kit-ws.config')).toMatchObject({ status: 'fail', detail: expect.stringContaining('readTimeoutMs') })
  })

  it('checks dws install and login for dingtalk', async () => {
    const enabled = snapshot({ 'agent-kit-dingtalk': { enabled: true, config: { identity: 'user' } } })
    const missing = await runChecks(ctx({ snapshot: enabled, findExecutable: () => undefined }))
    expect(byId(missing, 'agent-kit-dingtalk.dws')!.status).toBe('fail')
    const loggedOut = await runChecks(ctx({ snapshot: enabled, exec: async () => ({ exitCode: 0, stdout: JSON.stringify({ authenticated: false }), stderr: '' }) }))
    expect(byId(loggedOut, 'agent-kit-dingtalk.login')).toMatchObject({ status: 'fail', fix: 'dws auth login' })
    const dry = await runChecks(ctx({ snapshot: snapshot({ 'agent-kit-dingtalk': { enabled: true, config: { identity: 'user', dryRun: true } } }) }))
    expect(byId(dry, 'agent-kit-dingtalk.login')!.status).toBe('skip')
  })

  it('checks provider install and declared permissions for agentTasks', async () => {
    const enabled = snapshot({ 'agent-kit-agent-tasks': { enabled: true, config: { workspaceDir: '/tmp/x' } } })
    const r = await runChecks(ctx({ snapshot: enabled, resolveModule: (m) => m !== '@deepseek-ai/dsh-subagent-codex' }))
    expect(byId(r, 'agent-kit-agent-tasks.provider')!.status).toBe('pass')
    expect(byId(r, 'agent-kit-agent-tasks.permissions')).toMatchObject({ status: 'warn', detail: expect.stringContaining('claude-code') })
    const declared = snapshot({ 'agent-kit-agent-tasks': { enabled: true, config: { workspaceDir: '/tmp/x', declaredPermissions: { 'claude-code': 'read-only' } } } })
    expect(byId(await runChecks(ctx({ snapshot: declared, resolveModule: (m) => m !== '@deepseek-ai/dsh-subagent-codex' })), 'agent-kit-agent-tasks.permissions')!.status).toBe('pass')
    const none = await runChecks(ctx({ snapshot: enabled, resolveModule: (m) => !m.startsWith('@deepseek-ai/dsh-subagent-') }))
    expect(byId(none, 'agent-kit-agent-tasks.provider')!.status).toBe('fail')
  })

  it('checks sdk and key source for jev without printing the key', async () => {
    const enabled = snapshot({ 'agent-kit-jev': { enabled: true, config: {} } })
    const noKey = await runChecks(ctx({ snapshot: enabled }))
    expect(byId(noKey, 'agent-kit-jev.key')).toMatchObject({ status: 'fail', fix: expect.stringContaining('setup') })
    const withKey = await runChecks(ctx({ snapshot: enabled, keyStore: { env: { TYPESAFE_API_KEY: 'secret-abc' } } }))
    expect(byId(withKey, 'agent-kit-jev.key')).toMatchObject({ status: 'pass', detail: expect.stringContaining('env') })
    expect(JSON.stringify(withKey)).not.toContain('secret-abc')
    const noSdk = await runChecks(ctx({ snapshot: enabled, resolveModule: (m) => m !== '@typesafe-ai/sdk' }))
    expect(byId(noSdk, 'agent-kit-jev.sdk')!.status).toBe('fail')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/checks.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/checks/types.ts
import type { KeyStoreOptions } from '../secrets/index.js'
import type { KitId, KitSnapshot, ProfileInfo } from '../profile/index.js'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export interface CheckResult {
  id: string
  scope: 'common' | KitId
  title: string
  status: CheckStatus
  detail: string
  fix?: string
}
export interface CheckContext {
  profile: ProfileInfo
  snapshot: KitSnapshot
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  nodeVersion: string
  resolveModule(name: string): boolean
  exec(file: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }>
  keyStore: KeyStoreOptions
  findExecutable(name: string): string | undefined
}
export interface CheckReport {
  profile: string
  ok: boolean
  results: CheckResult[]
}
export type Check = (ctx: CheckContext) => Promise<CheckResult[]> | CheckResult[]
```

```ts
// src/checks/common.ts
import type { Check } from './types.js'

const [MAJOR, MINOR] = [22, 19]

export const commonChecks: Check = (ctx) => {
  const [major = 0, minor = 0] = ctx.nodeVersion.split('.').map(Number)
  const nodeOk = major > 22 ? major >= 24 : major === MAJOR && minor >= MINOR
  const { profile } = ctx
  return [
    {
      id: 'node',
      scope: 'common',
      title: 'Node.js 版本',
      status: nodeOk ? 'pass' : 'fail',
      detail: `当前 ${ctx.nodeVersion}，需要 ^22.19 或 >=24`,
      ...(nodeOk ? {} : { fix: '安装 Node.js 24 LTS' }),
    },
    {
      id: 'bundle',
      scope: 'common',
      title: '本包已加入 Profile',
      status: profile.hasKit ? 'pass' : 'fail',
      detail: profile.hasKit ? `Profile ${profile.name} 已包含 @mc/dsh-agent-kit` : `Profile ${profile.name} 未安装 @mc/dsh-agent-kit`,
      ...(profile.hasKit ? {} : { fix: `dsh plugin --profile ${profile.name} add @mc/dsh-agent-kit` }),
    },
    {
      id: 'patch-reload',
      scope: 'common',
      title: '配置修改即时生效',
      status: profile.patchReload === 'live' ? 'pass' : 'warn',
      detail: profile.patchReload === 'live' ? 'patchReload: live' : 'patchReload: startup，修改配置后需要重启 dsh',
    },
  ]
}
```

```ts
// src/checks/dingtalk.ts
import type { Check } from './types.js'

export const dingtalkChecks: Check = async (ctx) => {
  const config = (ctx.snapshot.entries['agent-kit-dingtalk'].config ?? {}) as { identity?: string; dryRun?: boolean; dwsPath?: string; webhookTokenEnv?: string }
  const scope = 'agent-kit-dingtalk' as const
  const dws = config.dwsPath ?? ctx.findExecutable('dws')
  const results = [
    {
      id: `${scope}.dws`,
      scope,
      title: 'dws 已安装',
      status: dws ? ('pass' as const) : ('fail' as const),
      detail: dws ?? '在 PATH 中找不到 dws',
      ...(dws ? {} : { fix: 'npm i -g dingtalk-workspace-cli' }),
    },
  ]
  if (config.identity === 'webhook') {
    const set = !!config.webhookTokenEnv && !!ctx.env[config.webhookTokenEnv]
    results.push({ id: `${scope}.webhook-token`, scope, title: 'webhook token 环境变量', status: set ? 'pass' : 'fail', detail: set ? `${config.webhookTokenEnv} 已设置` : `${config.webhookTokenEnv ?? '(未配置)'} 未设置` })
  }
  const skipLogin = config.dryRun === true || config.identity === 'webhook' || !dws
  if (skipLogin) {
    results.push({ id: `${scope}.login`, scope, title: 'dws 登录状态', status: 'skip', detail: config.dryRun ? 'dryRun 模式不检查' : '跳过' })
    return results
  }
  const r = await ctx.exec(dws!, ['auth', 'status', '--format=json']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
  let ok = false
  let who = ''
  try {
    const data = JSON.parse(r.stdout) as { authenticated?: boolean; token_valid?: boolean; refresh_token_valid?: boolean; user_name?: string; corp_name?: string }
    ok = r.exitCode === 0 && data.authenticated === true && (data.token_valid === true || data.refresh_token_valid === true)
    who = [data.user_name, data.corp_name].filter(Boolean).join(' @ ')
  } catch {
    ok = false
  }
  results.push({ id: `${scope}.login`, scope, title: 'dws 登录状态', status: ok ? 'pass' : 'fail', detail: ok ? `已登录 ${who}`.trim() : '未登录或登录已过期', ...(ok ? {} : { fix: 'dws auth login' }) })
  return results
}
```

```ts
// src/checks/agent-tasks.ts
import type { Check } from './types.js'

const PROVIDERS = [
  { name: 'claude-code', module: '@deepseek-ai/dsh-subagent-claude-code' },
  { name: 'codex', module: '@deepseek-ai/dsh-subagent-codex' },
]

export const agentTasksChecks: Check = (ctx) => {
  const scope = 'agent-kit-agent-tasks' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as { declaredPermissions?: Record<string, string> }
  const installed = PROVIDERS.filter((p) => ctx.resolveModule(p.module))
  const undeclared = installed.filter((p) => !config.declaredPermissions?.[p.name])
  return [
    {
      id: `${scope}.provider`,
      scope,
      title: 'subagent provider 已安装',
      status: installed.length > 0 ? 'pass' : 'fail',
      detail: installed.length > 0 ? installed.map((p) => p.name).join(', ') : '未安装 claude-code 或 codex provider',
      ...(installed.length > 0 ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @deepseek-ai/dsh-subagent-claude-code@0.1.5-rc.3` }),
    },
    {
      id: `${scope}.permissions`,
      scope,
      title: '权限上限已声明',
      status: undeclared.length === 0 ? 'pass' : 'warn',
      detail: undeclared.length === 0 ? '所有已安装 provider 都已声明' : `${undeclared.map((p) => p.name).join(', ')} 未声明 declaredPermissions，对应任务会被拒绝`,
      ...(undeclared.length === 0 ? {} : { fix: '运行 setup 或在设置页声明权限上限（claude-code 默认 dontAsk 可声明为 read-only）' }),
    },
  ]
}
```

```ts
// src/checks/jev.ts
import { describeTypesafeKey } from '../secrets/index.js'
import type { Check } from './types.js'

export const jevChecks: Check = async (ctx) => {
  const scope = 'agent-kit-jev' as const
  const config = (ctx.snapshot.entries[scope].config ?? {}) as { keychainService?: string | string[]; keychainAccount?: string }
  const sdk = ctx.resolveModule('@typesafe-ai/sdk')
  const key = await describeTypesafeKey({ ...ctx.keyStore, keychainService: config.keychainService, keychainAccount: config.keychainAccount })
  return [
    { id: `${scope}.sdk`, scope, title: '@typesafe-ai/sdk 已安装', status: sdk ? 'pass' : 'fail', detail: sdk ? '已安装' : '未安装', ...(sdk ? {} : { fix: `dsh plugin --profile ${ctx.profile.name} add @typesafe-ai/sdk` }) },
    {
      id: `${scope}.key`,
      scope,
      title: 'TypeSafe Key',
      status: key.configured ? 'pass' : 'fail',
      detail: key.configured ? `来源：${key.source}` : '环境变量、钥匙串与 dsh 凭据中都没有找到',
      ...(key.configured ? {} : { fix: 'npx @mc/dsh-agent-kit setup（或设置环境变量 TYPESAFE_API_KEY）' }),
    },
  ]
}
```

```ts
// src/checks/run.ts
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { KIT_ENTRIES, readKitEntries, type ProfileInfo } from '../profile/index.js'
import { BASE_ENV_WHITELIST, pickEnv, runProcess } from '../common/process.js'
import { DWS_ENV_WHITELIST, resolveExecutable } from '../dingtalk/service.js'
import { agentTasksChecks } from './agent-tasks.js'
import { commonChecks } from './common.js'
import { dingtalkChecks } from './dingtalk.js'
import { jevChecks } from './jev.js'
import type { Check, CheckContext, CheckReport, CheckResult } from './types.js'

const SERVICE_CHECKS: Record<string, Check> = {
  'agent-kit-dingtalk': dingtalkChecks,
  'agent-kit-agent-tasks': agentTasksChecks,
  'agent-kit-jev': jevChecks,
}

export async function createCheckContext(profile: ProfileInfo, over: Partial<CheckContext> = {}): Promise<CheckContext> {
  // 按 dsh 的解析规则：模块从 Profile 目录解析
  const require = createRequire(join(profile.dir, 'package.json'))
  return {
    profile,
    snapshot: await readKitEntries(profile.patchFile),
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    resolveModule: (name) => {
      try {
        require.resolve(`${name}/package.json`)
        return true
      } catch {
        return false
      }
    },
    exec: async (file, args) => {
      const r = await runProcess(file, args, { env: pickEnv([...BASE_ENV_WHITELIST, ...DWS_ENV_WHITELIST]), timeoutMs: 15_000, killGraceMs: 1000 })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
    keyStore: {},
    findExecutable: (name) => resolveExecutable(process.platform === 'win32' ? `${name}.cmd` : name) ?? resolveExecutable(name),
    ...over,
  }
}

export async function runChecks(ctx: CheckContext): Promise<CheckReport> {
  const results: CheckResult[] = [...(await commonChecks(ctx))]
  for (const meta of KIT_ENTRIES) {
    const state = ctx.snapshot.entries[meta.id]
    if (!state.enabled) continue
    const validated = meta.validate(state.config)
    results.push({
      id: `${meta.id}.config`,
      scope: meta.id,
      title: `${meta.title} 配置`,
      status: validated.ok ? 'pass' : 'fail',
      detail: validated.ok ? '配置有效' : validated.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    })
    const extra = SERVICE_CHECKS[meta.id]
    if (extra) results.push(...(await extra(ctx)))
  }
  return { profile: ctx.profile.name, ok: results.every((r) => r.status !== 'fail'), results }
}
```

```ts
// src/checks/index.ts
export * from './types.js'
export { createCheckContext, runChecks } from './run.js'
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/checks.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit（经用户同意后）**

```bash
git add src/checks tests/unit/checks.test.ts
git commit -m "feat(checks): structured environment and config checks"
```

---

### Task 6: `doctor` 命令与可执行入口

**Files:**
- Create: `src/cli/main.ts`、`src/cli/doctor.ts`、`src/cli/messages.ts`、`bin/dsh-agent-kit.mjs`
- Modify: `package.json`（`bin`、`files`）
- Test: `tests/unit/cli-doctor.test.ts`

**Interfaces:**
- Consumes: `listProfiles`、`locateProfile`（Task 2）；`createCheckContext`、`runChecks`、`CheckReport`（Task 5）。
- Produces:
  - `interface CliIO { out(text: string): void; err(text: string): void; env: NodeJS.ProcessEnv }`
  - `main(argv: string[], io?: CliIO, deps?: CliDeps): Promise<number>`（返回退出码）
  - `interface CliDeps { home?: string; checkOverrides?: Partial<CheckContext>; prompter?: Prompter }`（`Prompter` 由 Task 7 定义；本任务先声明为 `unknown`，Task 7 替换为真实类型）
  - `formatReport(report: CheckReport): string`
  - `pickProfile(home: string, requested: string | undefined, prompter?: Prompter): Promise<ProfileInfo>`：指定时直接定位；未指定时取唯一安装了本包的 Profile；多个时用 prompter 选择，没有 prompter 则报错列出候选。

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/cli-doctor.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/main.js'

let home: string
let out: string[]
let err: string[]
const io = () => ({ out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), env: {} })

function profile(name: string, withKit: boolean, patch = '') {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: withKit ? ['@mc/dsh-agent-kit'] : [], patchReload: 'live' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  out = []
  err = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('doctor', () => {
  it('auto-selects the only profile with the kit and prints a readable report', async () => {
    profile('a', false)
    profile('kit', true)
    const code = await main(['doctor'], io(), { home, checkOverrides: { nodeVersion: '24.1.0' } })
    expect(code).toBe(0)
    const text = out.join('')
    expect(text).toContain('Profile: kit')
    expect(text).toMatch(/✓ Node\.js 版本/)
  })

  it('exits 1 with fixes when checks fail, and supports --json', async () => {
    profile('kit', true, '- id: agent-kit-jev\n  disabled: false\n')
    const code = await main(['doctor', '--profile', 'kit', '--json'], io(), {
      home,
      checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, keyStore: { env: {}, platform: 'linux', credentialsFile: join(home, 'none.yaml') } },
    })
    expect(code).toBe(1)
    const report = JSON.parse(out.join(''))
    expect(report.ok).toBe(false)
    expect(report.results.find((r: { id: string }) => r.id === 'agent-kit-jev.key').status).toBe('fail')
  })

  it('asks for --profile when several profiles have the kit', async () => {
    profile('a', true)
    profile('b', true)
    const code = await main(['doctor'], io(), { home })
    expect(code).toBe(2)
    expect(err.join('')).toMatch(/--profile.*a.*b/s)
  })

  it('prints usage for unknown commands', async () => {
    expect(await main(['nope'], io(), { home })).toBe(2)
    expect(err.join('')).toContain('用法')
    expect(await main(['--help'], io(), { home })).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/cli-doctor.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/cli/messages.ts
export const USAGE = `用法：
  dsh-agent-kit doctor [--profile <名字>] [--json]   检查配置与运行环境
  dsh-agent-kit setup  [--profile <名字>]            交互式配置
`
export const ICON = { pass: '✓', warn: '!', fail: '✗', skip: '-' } as const
```

```ts
// src/cli/doctor.ts
import type { CheckReport } from '../checks/index.js'
import { ICON } from './messages.js'

export function formatReport(report: CheckReport): string {
  const lines = [`Profile: ${report.profile}`, '']
  let scope = ''
  for (const r of report.results) {
    if (r.scope !== scope) {
      scope = r.scope
      lines.push(scope === 'common' ? '[通用]' : `[${scope.replace('agent-kit-', '')}]`)
    }
    lines.push(`  ${ICON[r.status]} ${r.title}：${r.detail}`)
    if (r.fix && r.status !== 'pass') lines.push(`      → ${r.fix}`)
  }
  lines.push('', report.ok ? '全部检查通过。' : '存在未通过的检查项，请按提示修复。', '')
  return lines.join('\n')
}
```

```ts
// src/cli/main.ts
import { parseArgs } from 'node:util'
import { createCheckContext, runChecks, type CheckContext } from '../checks/index.js'
import { listProfiles, locateProfile, resolveDshHome, type ProfileInfo } from '../profile/index.js'
import { formatReport } from './doctor.js'
import { USAGE } from './messages.js'

export interface CliIO {
  out(text: string): void
  err(text: string): void
  env: NodeJS.ProcessEnv
}
export interface CliDeps {
  home?: string
  checkOverrides?: Partial<CheckContext>
  prompter?: unknown
}

const defaultIO: CliIO = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t), env: process.env }

class UsageError extends Error {}

export async function pickProfile(home: string, requested: string | undefined): Promise<ProfileInfo> {
  if (requested) return locateProfile(requested, home)
  const withKit: ProfileInfo[] = []
  for (const name of await listProfiles(home)) {
    const p = await locateProfile(name, home).catch(() => undefined)
    if (p?.hasKit) withKit.push(p)
  }
  if (withKit.length === 1) return withKit[0]!
  if (withKit.length === 0) throw new UsageError(`在 ${home} 中没有安装 @mc/dsh-agent-kit 的 Profile；请用 --profile 指定，或先运行 dsh plugin --profile <名字> add @mc/dsh-agent-kit\n`)
  throw new UsageError(`有多个 Profile 安装了本包，请用 --profile 指定：${withKit.map((p) => p.name).join(', ')}\n`)
}

export async function main(argv: string[], io: CliIO = defaultIO, deps: CliDeps = {}): Promise<number> {
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE)
    return 0
  }
  try {
    const { values } = parseArgs({ args: rest, options: { profile: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: false })
    const home = deps.home ?? resolveDshHome(io.env)
    if (command === 'doctor') {
      const profile = await pickProfile(home, values.profile)
      const report = await runChecks(await createCheckContext(profile, deps.checkOverrides))
      io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
      return report.ok ? 0 : 1
    }
    if (command === 'setup') {
      const { runSetup } = await import('./setup.js')
      return await runSetup({ home, profileName: values.profile, io, deps })
    }
    throw new UsageError(USAGE)
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(e instanceof UsageError ? e.message : `${(e as Error).message}\n${USAGE}`)
      return 2
    }
    io.err(`错误：${(e as Error).message}\n`)
    return 1
  }
}
```

（`setup.ts` 在 Task 7 创建；本任务先创建只含 `export async function runSetup(): Promise<number> { throw new Error('setup is not implemented yet') }` 的占位文件以通过类型检查，Task 7 第一步即替换它。）

```js
// bin/dsh-agent-kit.mjs
#!/usr/bin/env node
import { main } from '../lib/cli/main.js'

process.exitCode = await main(process.argv.slice(2))
```

`package.json`：增加 `"bin": { "dsh-agent-kit": "./bin/dsh-agent-kit.mjs" }`，`files` 增加 `"bin"`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/cli-doctor.test.ts && npm run typecheck && npm run build && node bin/dsh-agent-kit.mjs --help`
Expected: PASS，最后一条输出用法

- [ ] **Step 5: Commit（经用户同意后）**

```bash
git add src/cli bin package.json tests/unit/cli-doctor.test.ts
git commit -m "feat(cli): add doctor command and executable"
```

---

### Task 7: `setup` 交互式配置

**Files:**
- Create: `src/cli/prompter.ts`
- Modify: `src/cli/setup.ts`（替换占位）、`src/cli/main.ts`（`CliDeps.prompter` 改为 `Prompter`，`pickProfile` 多个候选时用 prompter 选择）
- Test: `tests/unit/cli-setup.test.ts`

**Interfaces:**
- Consumes: `pickProfile`、`CliIO`、`CliDeps`（Task 6）；`readKitEntries`、`previewKitEntries`、`writeKitEntries`、`KitChanges`（Task 2）；`saveTypesafeKey`、`describeTypesafeKey`、`defaultKeyTarget`、`SHARED_KEYCHAIN_SERVICE`、`KeyStoreOptions`（Task 3）；`createCheckContext`、`runChecks`（Task 5）；`formatReport`（Task 6）。
- Produces:
  - `interface Prompter { select<T extends string>(message: string, choices: { value: T; name: string; description?: string }[], def?: T): Promise<T>; checkbox<T extends string>(message: string, choices: { value: T; name: string; checked?: boolean }[]): Promise<T[]>; input(message: string, def?: string, validate?: (v: string) => true | string): Promise<string>; password(message: string): Promise<string>; confirm(message: string, def?: boolean): Promise<boolean> }`
  - `inquirerPrompter: Prompter`；`scriptedPrompter(answers: unknown[]): Prompter & { remaining(): number }`（测试用，按调用顺序返回答案）
  - `runSetup(opts: { home: string; profileName?: string; io: CliIO; deps: SetupDeps }): Promise<number>`
  - `SetupDeps = CliDeps & { prompter?: Prompter; runDws?: (args: string[]) => Promise<number>; keyStore?: KeyStoreOptions }`（`dws` 的非交互调用复用 `CheckContext.exec`，由 `checkOverrides.exec` 注入）
  - `searchGroups(exec: CheckContext['exec'], dws: string, query: string): Promise<{ id: string; name: string }[]>`
  - `sendSelfTestMessage(exec: CheckContext['exec'], dws: string, config: { identity: string; robotCode?: string }): Promise<{ ok: boolean; detail: string }>`
  - `pickProfile(home, requested, prompter?)`：多个候选时若有 prompter 则让用户选择（修改 Task 6 的实现）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/cli-setup.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/main.js'
import { scriptedPrompter } from '../../src/cli/prompter.js'
import { readCredential } from '../../src/secrets/index.js'

let home: string
let patchFile: string
let out: string[]
const io = () => ({ out: (t: string) => void out.push(t), err: (t: string) => void out.push(t), env: {} })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const dir = join(home, 'profiles', 'kit')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@mc/dsh-agent-kit'], patchReload: 'live' } } }))
  patchFile = join(dir, 'cordis.patch.yml')
  writeFileSync(patchFile, '# mine\n')
  out = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const deps = (answers: unknown[], extra: Record<string, unknown> = {}) => ({
  home,
  prompter: scriptedPrompter(answers),
  keyStore: { env: {}, platform: 'linux' as const, credentialsFile: join(home, '.credentials.yaml') },
  checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, findExecutable: () => '/usr/bin/dws', exec: async () => ({ exitCode: 0, stdout: '{"authenticated":true,"token_valid":true}', stderr: '' }), keyStore: { env: {}, platform: 'linux' as const, credentialsFile: join(home, '.credentials.yaml') } },
  ...extra,
})

describe('setup', () => {
  it('configures dingtalk and jev end to end, then runs doctor', async () => {
    const answers = [
      ['agent-kit-dingtalk', 'agent-kit-jev'], // 启用哪些
      'bot', // 钉钉身份
      'dingRobot1', // robotCode
      'chatId', // 默认目标类型
      'cidTest1', // 群 ID
      false, // 是否 dryRun
      'jev-latest', // Jev 模型
      'ts-secret-key', // Key（password）
      'credentials', // 保存位置（linux 只有 credentials，仍会确认一次）
      true, // 确认写入
      false, // 不发送测试消息
    ]
    const code = await main(['setup', '--profile', 'kit'], io(), deps(answers))
    expect(code).toBe(0)
    const text = readFileSync(patchFile, 'utf8')
    expect(text).toContain('# mine')
    expect(text).toMatch(/id: agent-kit-dingtalk\n\s+disabled: false\n\s+config:\n\s+identity: bot\n\s+robotCode: dingRobot1/)
    expect(text).not.toContain('ts-secret-key')
    expect(await readCredential('TYPESAFE_API_KEY', join(home, '.credentials.yaml'))).toBe('ts-secret-key')
    const printed = out.join('')
    expect(printed).toContain('+ - id: agent-kit-dingtalk')
    expect(printed).toContain('全部检查通过')
    expect(printed).not.toContain('ts-secret-key')
  })

  it('writes nothing when the user declines the diff', async () => {
    const code = await main(['setup', '--profile', 'kit'], io(), deps([['agent-kit-ws'], false]))
    expect(code).toBe(1)
    expect(readFileSync(patchFile, 'utf8')).toBe('# mine\n')
  })

  it('re-asks on invalid input and keeps existing keys', async () => {
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  TYPESAFE_API_KEY: old\n', { mode: 0o600 })
    const answers = [['agent-kit-jev'], 'jev-latest', true /* 保留已有 Key */, true]
    expect(await main(['setup', '--profile', 'kit'], io(), deps(answers))).toBe(0)
    expect(await readCredential('TYPESAFE_API_KEY', join(home, '.credentials.yaml'))).toBe('old')
  })

  it('offers dws login for a logged-out user identity', async () => {
    const dwsCalls: string[][] = []
    const answers = [['agent-kit-dingtalk'], 'user', 'userId', 'u1', false, true /* 运行 dws auth login */, true, false /* 不发送测试消息 */]
    const code = await main(['setup', '--profile', 'kit'], io(), deps(answers, {
      runDws: async (args: string[]) => (dwsCalls.push(args), 0),
      checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, findExecutable: () => '/usr/bin/dws', exec: async () => ({ exitCode: 0, stdout: '{"authenticated":false}', stderr: '' }), keyStore: {} },
    }))
    expect(dwsCalls).toEqual([['auth', 'login']])
    expect(code).toBe(1) // 假 exec 仍报告未登录，doctor 失败
  })

  it('searches groups by name and sends a test message to the current user', async () => {
    const execCalls: string[][] = []
    const exec = async (_file: string, args: string[]) => {
      execCalls.push(args)
      if (args[1] === '+chat-search') return { exitCode: 0, stdout: JSON.stringify({ chats: [{ openConversationId: 'cidFound', title: '研发群' }] }), stderr: '' }
      if (args[0] === 'auth') return { exitCode: 0, stdout: JSON.stringify({ authenticated: true, token_valid: true, user_id: 'me123' }), stderr: '' }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { success: true } }), stderr: '' }
    }
    const answers = [['agent-kit-dingtalk'], 'user', 'search', '研发', 'cidFound', false, true, true /* 发送测试消息 */]
    const code = await main(['setup', '--profile', 'kit'], io(), deps(answers, {
      checkOverrides: { nodeVersion: '24.1.0', resolveModule: () => true, findExecutable: () => '/usr/bin/dws', exec, keyStore: {} },
    }))
    expect(code).toBe(0)
    expect(readFileSync(patchFile, 'utf8')).toContain('chatId: cidFound')
    const send = execCalls.find((a) => a[1] === '+messages-send')!
    expect(send).toEqual(expect.arrayContaining(['--as=user', '--user=me123', '--yes', '--format=json']))
    expect(out.join('')).toContain('测试消息已发送')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/cli-setup.test.ts`
Expected: FAIL（`scriptedPrompter` 不存在）

- [ ] **Step 3: 安装依赖并实现**

```bash
npm i @inquirer/prompts@^7 diff@^8
```

```ts
// src/cli/prompter.ts
import { checkbox, confirm, input, password, select } from '@inquirer/prompts'

export interface Prompter {
  select<T extends string>(message: string, choices: { value: T; name: string; description?: string }[], def?: T): Promise<T>
  checkbox<T extends string>(message: string, choices: { value: T; name: string; checked?: boolean }[]): Promise<T[]>
  input(message: string, def?: string, validate?: (v: string) => true | string): Promise<string>
  password(message: string): Promise<string>
  confirm(message: string, def?: boolean): Promise<boolean>
}

export const inquirerPrompter: Prompter = {
  select: (message, choices, def) => select({ message, choices, ...(def ? { default: def } : {}) }),
  checkbox: (message, choices) => checkbox({ message, choices }),
  input: (message, def, validate) => input({ message, ...(def !== undefined ? { default: def } : {}), ...(validate ? { validate } : {}) }),
  password: (message) => password({ message, mask: '*' }),
  confirm: (message, def) => confirm({ message, default: def ?? true }),
}

/** 测试用：按调用顺序依次返回答案；input 的答案不通过 validate 时抛错。 */
export function scriptedPrompter(answers: unknown[]): Prompter & { remaining(): number } {
  const queue = [...answers]
  const next = (message: string) => {
    if (queue.length === 0) throw new Error(`scriptedPrompter: no answer for "${message}"`)
    return queue.shift()
  }
  return {
    remaining: () => queue.length,
    select: async (m) => next(m) as never,
    checkbox: async (m) => next(m) as never,
    input: async (m, _def, validate) => {
      const v = next(m) as string
      const ok = validate?.(v) ?? true
      if (ok !== true) throw new Error(`scriptedPrompter: invalid answer for "${m}": ${ok}`)
      return v
    },
    password: async (m) => next(m) as string,
    confirm: async (m) => next(m) as boolean,
  }
}
```

```ts
// src/cli/setup.ts
import { spawn } from 'node:child_process'
import { createTwoFilesPatch } from 'diff'
import { createCheckContext, runChecks } from '../checks/index.js'
import { previewKitEntries, readKitEntries, writeKitEntries, type KitChanges, type KitId } from '../profile/index.js'
import { SHARED_KEYCHAIN_SERVICE, defaultKeyTarget, describeTypesafeKey, saveTypesafeKey, type KeyStoreOptions, type KeyTarget } from '../secrets/index.js'
import { buildSendArgs } from '../dingtalk/args.js'
import type { CheckContext } from '../checks/index.js'
import { formatReport } from './doctor.js'
import type { CliDeps, CliIO } from './main.js'
import { pickProfile } from './main.js'
import { inquirerPrompter, type Prompter } from './prompter.js'

type Config = Record<string, unknown>

export interface SetupDeps extends CliDeps {
  prompter?: Prompter
  runDws?: (args: string[]) => Promise<number>
  keyStore?: KeyStoreOptions
}

const nonEmpty = (v: string) => (v.trim() ? true : '不能为空')

const defaultRunDws = (args: string[]) =>
  new Promise<number>((resolve) => {
    const child = spawn('dws', args, { stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })

/** 按群名搜索当前用户加入的群。dws 输出的条目字段按常见命名宽松读取；实施时录制一份真实输出到 tests/fixtures/dws/chat-search.json 并加断言。 */
export async function searchGroups(exec: CheckContext['exec'], dws: string, query: string): Promise<{ id: string; name: string }[]> {
  const r = await exec(dws, ['chat', '+chat-search', `--query=${query}`, '--limit=20', '--format=json'])
  if (r.exitCode !== 0) return []
  try {
    const data = JSON.parse(r.stdout) as { chats?: Array<Record<string, unknown>> }
    return (data.chats ?? [])
      .map((c) => ({
        id: String(c.openConversationId ?? c.conversationId ?? c.chatId ?? ''),
        name: String(c.title ?? c.name ?? c.chatName ?? ''),
      }))
      .filter((g) => g.id)
  } catch {
    return []
  }
}

/** 以配置的身份给当前 dws 登录用户发一条单聊测试消息（webhook 身份不支持）。 */
export async function sendSelfTestMessage(exec: CheckContext['exec'], dws: string, config: { identity: string; robotCode?: string }): Promise<{ ok: boolean; detail: string }> {
  if (config.identity === 'webhook') return { ok: false, detail: 'webhook 身份不支持单聊测试' }
  const auth = await exec(dws, ['auth', 'status', '--format=json'])
  const userId = (() => {
    try {
      return (JSON.parse(auth.stdout) as { user_id?: string }).user_id
    } catch {
      return undefined
    }
  })()
  if (!userId) return { ok: false, detail: '无法从 dws auth status 取得当前用户' }
  const { args } = buildSendArgs({
    identity: config.identity as 'user' | 'bot',
    robotCode: config.robotCode,
    target: { userId },
    title: 'dsh-agent-kit',
    markdown: `dsh-agent-kit setup 测试消息 ${new Date().toISOString()}`,
    dryRun: false,
  })
  const r = await exec(dws, args)
  return r.exitCode === 0 ? { ok: true, detail: '测试消息已发送' } : { ok: false, detail: `发送失败：${r.stderr.trim() || r.exitCode}` }
}

async function configureDingtalk(p: Prompter, current: Config, deps: SetupDeps, io: CliIO, loggedIn: boolean, exec: CheckContext['exec'], dws: string | undefined): Promise<Config> {
  const identity = await p.select('钉钉发送身份', [
    { value: 'bot', name: 'bot（机器人，服务器环境推荐）' },
    { value: 'user', name: 'user（当前 dws 登录账号）' },
    { value: 'webhook', name: 'webhook（不推荐：token 会出现在进程参数中）' },
  ], (current.identity as 'bot' | 'user' | 'webhook') ?? 'bot')
  const config: Config = { identity }
  if (identity === 'bot') config.robotCode = await p.input('机器人 robotCode', current.robotCode as string, nonEmpty)
  if (identity === 'webhook') config.webhookTokenEnv = await p.input('保存 webhook token 的环境变量名', (current.webhookTokenEnv as string) ?? 'DINGTALK_WEBHOOK_TOKEN', nonEmpty)
  if (identity !== 'webhook') {
    const kind = await p.select('默认发送目标（省略 target 时使用）', [
      { value: 'search', name: '按群名搜索群' },
      { value: 'chatId', name: '直接输入群 ID（openConversationId）' },
      { value: 'userId', name: '单聊（userId）' },
      { value: 'none', name: '不设置，每次调用时指定' },
    ])
    if (kind === 'search') {
      const query = await p.input('群名关键词', undefined, nonEmpty)
      const groups = dws ? await searchGroups(exec, dws, query) : []
      if (groups.length === 0) {
        io.out('没有搜索到群，请直接输入群 ID。\n')
        config.defaultTarget = { chatId: await p.input('群 ID（cid 开头）', undefined, nonEmpty) }
      } else {
        config.defaultTarget = { chatId: await p.select('选择群', groups.map((g) => ({ value: g.id, name: `${g.name}（${g.id}）` }))) }
      }
    } else if (kind !== 'none') {
      config.defaultTarget = { [kind]: await p.input(kind === 'chatId' ? '群 ID（cid 开头）' : '接收者 userId', undefined, nonEmpty) }
    }
  }
  config.dryRun = await p.confirm('只演练不真实发送（dryRun）？', (current.dryRun as boolean) ?? false)
  if (identity === 'user' && !loggedIn && (await p.confirm('dws 尚未登录，现在运行 dws auth login？', true))) {
    const code = await (deps.runDws ?? defaultRunDws)(['auth', 'login'])
    if (code !== 0) io.err('dws auth login 未成功，稍后可手动运行。\n')
  }
  return config
}

async function configureAgentTasks(p: Prompter, current: Config): Promise<Config> {
  const workspaceDir = await p.input('任务工作目录（绝对路径，专用目录）', current.workspaceDir as string, (v) => (/^([a-zA-Z]:[\\/]|\/)/.test(v) ? true : '必须是绝对路径'))
  const declared: Record<string, string> = { ...((current.declaredPermissions as Record<string, string>) ?? {}) }
  for (const provider of ['claude-code', 'codex']) {
    const level = await p.select(`${provider} 实例的权限上限（不支持按任务过滤工具，需如实声明）`, [
      { value: 'read-only', name: 'read-only（claude-code 默认 dontAsk / codex 默认 never 时选这个）' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'none', name: '不使用该 provider' },
    ], (declared[provider] as 'read-only' | 'workspace-write') ?? 'read-only')
    if (level === 'none') delete declared[provider]
    else declared[provider] = level
  }
  return { ...current, workspaceDir, declaredPermissions: declared }
}

async function configureJev(p: Prompter, current: Config, keyStore: KeyStoreOptions, io: CliIO): Promise<Config> {
  const model = await p.input('Jev 模型', (current.model as string) ?? 'jev-latest', nonEmpty)
  const config: Config = { ...current, model }
  const platform = keyStore.platform ?? process.platform
  if (platform === 'darwin') config.keychainService = [SHARED_KEYCHAIN_SERVICE, 'gitflow-cli-typesafe']
  const existing = await describeTypesafeKey({ ...keyStore, keychainService: config.keychainService as string[] | undefined })
  if (existing.configured && (await p.confirm(`已找到 TypeSafe Key（来源：${existing.source}），保留？`, true))) return config
  const key = await p.password('TypeSafe API Key（输入不回显）')
  const targets: { value: KeyTarget; name: string }[] = platform === 'darwin'
    ? [{ value: 'keychain', name: `macOS 钥匙串 ${SHARED_KEYCHAIN_SERVICE}（可与 gitflow-cli 共享）` }, { value: 'credentials', name: 'dsh 凭据文件 $DSH_HOME/.credentials.yaml' }]
    : [{ value: 'credentials', name: 'dsh 凭据文件 $DSH_HOME/.credentials.yaml（仅本人可读）' }]
  const target = await p.select('保存到', targets, defaultKeyTarget(platform))
  await saveTypesafeKey(target, key, { ...keyStore, keychainService: SHARED_KEYCHAIN_SERVICE })
  io.out(`TypeSafe Key 已保存到 ${target === 'keychain' ? '钥匙串' : 'dsh 凭据文件'}。\n`)
  return config
}

export async function runSetup(opts: { home: string; profileName?: string; io: CliIO; deps: SetupDeps }): Promise<number> {
  const { io, deps } = opts
  const p = deps.prompter ?? inquirerPrompter
  const keyStore = deps.keyStore ?? {}
  const profile = await pickProfile(opts.home, opts.profileName)
  if (!profile.hasKit) {
    io.err(`Profile ${profile.name} 未安装本包，请先运行：dsh plugin --profile ${profile.name} add @mc/dsh-agent-kit\n`)
    return 1
  }
  const snap = await readKitEntries(profile.patchFile)
  const ctx = await createCheckContext(profile, deps.checkOverrides)
  const loggedIn = (await runChecks({ ...ctx, snapshot: { ...snap, entries: { ...snap.entries, 'agent-kit-dingtalk': { enabled: true, config: { identity: 'user' } } } } }))
    .results.some((r) => r.id === 'agent-kit-dingtalk.login' && r.status === 'pass')

  const dws = ctx.findExecutable('dws')
  const ids: KitId[] = ['agent-kit-ws', 'agent-kit-dingtalk', 'agent-kit-agent-tasks', 'agent-kit-jev']
  const titles: Record<KitId, string> = { 'agent-kit-ws': 'WebSocket 客户端', 'agent-kit-dingtalk': '钉钉推送', 'agent-kit-agent-tasks': 'Agent 任务', 'agent-kit-jev': 'Jev 判断' }
  const enabled = await p.checkbox('要启用哪些 Service？', ids.map((id) => ({ value: id, name: titles[id], checked: snap.entries[id].enabled })))

  const changes: KitChanges = {}
  for (const id of ids) {
    const current = (snap.entries[id].config ?? {}) as Config
    if (!enabled.includes(id)) {
      if (snap.entries[id].enabled) changes[id] = { enabled: false }
      continue
    }
    const config =
      id === 'agent-kit-dingtalk' ? await configureDingtalk(p, current, deps, io, loggedIn, ctx.exec, dws)
      : id === 'agent-kit-agent-tasks' ? await configureAgentTasks(p, current)
      : id === 'agent-kit-jev' ? await configureJev(p, current, keyStore, io)
      : current
    changes[id] = { enabled: true, config }
  }

  const { before, after } = await previewKitEntries(profile.patchFile, changes)
  io.out(`\n${createTwoFilesPatch('cordis.patch.yml', 'cordis.patch.yml', before, after, '当前', '修改后')}\n`)
  if (!(await p.confirm('写入以上修改？', true))) {
    io.out('已取消，未修改任何文件。\n')
    return 1
  }
  await writeKitEntries(profile.patchFile, changes, snap.version)
  io.out(profile.patchReload === 'live' ? '已写入，dsh 会自动加载新配置。\n' : '已写入，重启 dsh 后生效。\n')
  const dingtalk = changes['agent-kit-dingtalk']
  if (dingtalk?.enabled && dws && (await p.confirm('给当前 dws 登录用户发送一条测试消息？', false))) {
    const r = await sendSelfTestMessage(ctx.exec, dws, dingtalk.config as { identity: string; robotCode?: string })
    io.out(`${r.detail}\n`)
  }
  const report = await runChecks(await createCheckContext(profile, deps.checkOverrides))
  io.out(formatReport(report))
  return report.ok ? 0 : 1
}
```

`main.ts` 中的 `pickProfile` 改为支持 prompter（`doctor` 不传 prompter，保持 Task 6 的行为）：

```ts
export async function pickProfile(home: string, requested: string | undefined, prompter?: Prompter): Promise<ProfileInfo> {
  if (requested) return locateProfile(requested, home)
  const withKit: ProfileInfo[] = []
  for (const name of await listProfiles(home)) {
    const p = await locateProfile(name, home).catch(() => undefined)
    if (p?.hasKit) withKit.push(p)
  }
  if (withKit.length === 1) return withKit[0]!
  if (withKit.length === 0) throw new UsageError(`在 ${home} 中没有安装 @mc/dsh-agent-kit 的 Profile；请用 --profile 指定，或先运行 dsh plugin --profile <名字> add @mc/dsh-agent-kit\n`)
  if (prompter) {
    const name = await prompter.select('选择 Profile', withKit.map((p) => ({ value: p.name, name: p.name })))
    return withKit.find((p) => p.name === name)!
  }
  throw new UsageError(`有多个 Profile 安装了本包，请用 --profile 指定：${withKit.map((p) => p.name).join(', ')}\n`)
}
```

`runSetup` 中调用 `pickProfile(opts.home, opts.profileName, p)`。

注意 `configureJev` 的测试答案顺序：Linux 下只有一个保存位置时仍调用 `select`（测试中答 `'credentials'`），保持交互一致。`main.ts` 中 `CliDeps.prompter` 类型改为 `Prompter`，并把 `setup` 分支的 `deps` 按 `SetupDeps` 传入。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/cli-setup.test.ts tests/unit/cli-doctor.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 手动冒烟**

Run: `npm run build && DSH_HOME="$(mktemp -d)" node bin/dsh-agent-kit.mjs setup --profile none`
Expected: 输出 `profile none not found` 类错误并以 1 退出（交互部分由单测覆盖；真实交互在 Task 10 走查）。

- [ ] **Step 6: Commit（经用户同意后）**

```bash
git add src/cli tests/unit/cli-setup.test.ts package.json package-lock.json
git commit -m "feat(cli): interactive setup with diff preview"
```

---

### Task 8: `AgentKitAdmin` 远程服务

**Files:**
- Create: `src/admin/service.ts`
- Modify: `src/admin/plugin.ts`（挂载服务）、`tsconfig.json`（确认未开启 `experimentalDecorators`，使用 TC39 装饰器）
- Test: `tests/integration/admin.test.ts`

**Interfaces:**
- Consumes: `readKitEntries`、`writeKitEntries`、`locateProfile`、`KitChanges`、`KIT_ENTRIES`（Task 2）；`describeTypesafeKey`、`saveTypesafeKey`、`clearTypesafeKey`、`defaultKeyTarget`（Task 3）；`createCheckContext`、`runChecks`（Task 5）；`TypertRemoteService`、`Remote`、`RemoteError`（`@deepseek-ai/dsh-typert-protocol`）。
- Produces（远程方法，参数均为简单标识符以兼容 SRC 模式）：
  - `status(): Promise<AdminStatus>`
  - `saveService(id: KitId, enabled: boolean, config: Record<string, unknown> | null, expectedVersion: string): Promise<{ version: string }>`
  - `setSecret(target: KeyTarget, value: string): Promise<{ configured: boolean; source?: KeySource }>`
  - `clearSecret(target: KeyTarget): Promise<{ configured: boolean; source?: KeySource }>`
  - `AdminStatus = { profile: string; patchReload: 'live' | 'startup'; version: string; writable: boolean; readOnlyReason?: string; services: Array<{ id: KitId; title: string; enabled: boolean; phase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null; health: { status: 'ok' | 'degraded' | 'failed'; detail: string } | null; config: Record<string, unknown> | undefined }>; checks: CheckResult[]; typesafeKey: { configured: boolean; source?: KeySource }; keyTargets: KeyTarget[] }`
  - 错误：`RemoteError('gateway/bad-request', message)`，`message` 为 JSON `{ code, message, errors? }`（前端解析）。

AdminStatus 的 `profile` 从进程环境推断：dsh 启动时 Profile 目录即 `ctx.baseUrl` 对应目录（`fileURLToPath(ctx.baseUrl)` 的目录），`locateProfile` 用其目录名。服务构造时若无法定位 Profile，则 `writable: false`、`readOnlyReason: '无法定位 Profile 目录'`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/integration/admin.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentKitAdmin } from '../../src/admin/service.js'

let home: string
let profileDir: string
let root: Context

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  profileDir = join(home, 'profiles', 'kit')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@mc/dsh-agent-kit'], patchReload: 'live' } } }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: agent-kit-ws\n  disabled: false\n')
  root = new Context()
})
afterEach(async () => {
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

async function setup(host: '127.0.0.1' | '0.0.0.0' | undefined) {
  root.provide('loader', { entries: () => [{ id: 'agent-kit-ws', disabled: false, fiber: { state: 2 } }] } as never)
  if (host) root.provide('webServer', { host } as never)
  await root.plugin(AgentKitAdmin, { profileDir, keyStore: { env: {}, platform: 'linux', credentialsFile: join(home, '.credentials.yaml') } } as never)
  return root.get('agentKitAdmin') as unknown as AgentKitAdmin
}

describe('AgentKitAdmin', () => {
  it('reports status with health, checks and key description', async () => {
    const admin = await setup('127.0.0.1')
    const s = await admin.status()
    expect(s).toMatchObject({ profile: 'kit', patchReload: 'live', writable: true, typesafeKey: { configured: false }, keyTargets: ['credentials'] })
    expect(s.services.find((x) => x.id === 'agent-kit-ws')).toMatchObject({ enabled: true, phase: 'active' })
    expect(s.checks.some((c) => c.id === 'node')).toBe(true)
  })

  it('saves service config with optimistic concurrency', async () => {
    const admin = await setup('127.0.0.1')
    const { version } = await admin.status()
    const r = await admin.saveService('agent-kit-jev', true, { model: 'jev-latest' }, version)
    expect(r.version).not.toBe(version)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('agent-kit-jev')
    await expect(admin.saveService('agent-kit-jev', false, null, version)).rejects.toThrow(/conflict/)
    await expect(admin.saveService('agent-kit-ws', true, { pingIntervalMs: 30000, readTimeoutMs: 10 }, r.version)).rejects.toThrow(/invalid_config/)
  })

  it('stores secrets write-only', async () => {
    const admin = await setup('127.0.0.1')
    expect(await admin.setSecret('credentials', 'ts-key-123')).toEqual({ configured: true, source: 'credentials' })
    expect(JSON.stringify(await admin.status())).not.toContain('ts-key-123')
    expect(await admin.clearSecret('credentials')).toEqual({ configured: false })
  })

  it('is read-only when the web server is exposed beyond loopback', async () => {
    const admin = await setup('0.0.0.0')
    const s = await admin.status()
    expect(s.writable).toBe(false)
    expect(s.readOnlyReason).toMatch(/127\.0\.0\.1/)
    await expect(admin.saveService('agent-kit-ws', false, null, s.version)).rejects.toThrow(/read_only/)
    await expect(admin.setSecret('credentials', 'x')).rejects.toThrow(/read_only/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/integration/admin.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/admin/service.ts
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createCheckContext, runChecks, type CheckResult } from '../checks/index.js'
import { isKitError } from '../common/errors.js'
import type { ServiceHealth } from '../common/service.js'
import { KIT_ENTRIES, locateProfile, readKitEntries, writeKitEntries, type KitId, type ProfileInfo } from '../profile/index.js'
import { clearTypesafeKey, describeTypesafeKey, saveTypesafeKey, type KeySource, type KeyStoreOptions, type KeyTarget } from '../secrets/index.js'

const PHASES = ['pending', 'loading', 'active', 'failed', 'unloading'] as const

export interface AdminConfig {
  /** 测试用：显式指定 Profile 目录；缺省时由 ctx.baseUrl 推断。 */
  profileDir?: string
  /** 测试用：密钥存储选项。 */
  keyStore?: KeyStoreOptions
}

export interface AdminStatus {
  profile: string
  patchReload: 'live' | 'startup'
  version: string
  writable: boolean
  readOnlyReason?: string
  services: Array<{
    id: KitId
    title: string
    enabled: boolean
    phase: (typeof PHASES)[number] | null
    health: Pick<ServiceHealth, 'status' | 'detail'> | null
    config: Record<string, unknown> | undefined
  }>
  checks: CheckResult[]
  typesafeKey: { configured: boolean; source?: KeySource }
  keyTargets: KeyTarget[]
}

type Loader = { entries(): Iterable<{ id: string; disabled?: unknown; fiber?: { state: number } }> }

function fail(code: string, message: string, errors?: unknown): never {
  throw new RemoteError('gateway/bad-request', JSON.stringify({ code, message, ...(errors ? { errors } : {}) }))
}

export class AgentKitAdmin extends TypertRemoteService {
  static inject = { loader: { required: true }, webServer: { required: false }, credentials: { required: false } }
  private profile?: ProfileInfo

  constructor(
    ctx: Context,
    private readonly config: AdminConfig = {},
  ) {
    super(ctx, 'agentKitAdmin')
  }

  private get keyStore(): KeyStoreOptions {
    const credentials = (this.ctx as unknown as { get(n: string): KeyStoreOptions['credentials'] }).get('credentials')
    return { ...(credentials ? { credentials } : {}), ...this.config.keyStore }
  }

  private async locate(): Promise<ProfileInfo | undefined> {
    if (this.profile) return this.profile
    const dir = this.config.profileDir ?? ((this.ctx as unknown as { baseUrl?: string }).baseUrl ? dirname(fileURLToPath(new URL('./cordis.yml', (this.ctx as unknown as { baseUrl: string }).baseUrl))) : undefined)
    if (!dir) return undefined
    this.profile = await locateProfile(basename(dir), dirname(dirname(dir))).catch(() => undefined)
    return this.profile
  }

  private readOnlyReason(profile: ProfileInfo | undefined): string | undefined {
    if (!profile) return '无法定位 Profile 目录'
    const host = (this.ctx as unknown as { get(n: string): { host?: string } | undefined }).get('webServer')?.host
    if (host !== undefined && host !== '127.0.0.1') return 'dsh Web 未绑定 127.0.0.1，设置页为只读'
    return undefined
  }

  @Remote('status')
  async status(): Promise<AdminStatus> {
    const profile = await this.locate()
    if (!profile) fail('profile_not_found', '无法定位 Profile 目录')
    const snapshot = await readKitEntries(profile.patchFile)
    const loader = (this.ctx as unknown as { get(n: string): Loader }).get('loader')
    const entries = new Map([...loader.entries()].map((e) => [e.id, e]))
    const report = await runChecks(await createCheckContext(profile, { snapshot, keyStore: this.keyStore }))
    const reason = this.readOnlyReason(profile)
    const jevConfig = (snapshot.entries['agent-kit-jev'].config ?? {}) as { keychainService?: string | string[]; keychainAccount?: string }
    return {
      profile: profile.name,
      patchReload: profile.patchReload,
      version: snapshot.version,
      writable: reason === undefined,
      ...(reason ? { readOnlyReason: reason } : {}),
      services: KIT_ENTRIES.map((meta) => {
        const entry = entries.get(meta.id)
        const svc = (this.ctx as unknown as { get(n: string): { health?(): ServiceHealth } | undefined }).get(meta.service)
        const health = entry?.fiber?.state === 2 && svc?.health ? svc.health() : null
        return {
          id: meta.id,
          title: meta.title,
          enabled: snapshot.entries[meta.id].enabled,
          phase: entry?.fiber ? (PHASES[entry.fiber.state] ?? null) : null,
          health: health ? { status: health.status, detail: health.detail } : null,
          config: snapshot.entries[meta.id].config,
        }
      }),
      checks: report.results,
      typesafeKey: await describeTypesafeKey({ ...this.keyStore, keychainService: jevConfig.keychainService, keychainAccount: jevConfig.keychainAccount }),
      keyTargets: (this.keyStore.platform ?? process.platform) === 'darwin' ? ['keychain', 'credentials'] : ['credentials'],
    }
  }

  private async writable(): Promise<ProfileInfo> {
    const profile = await this.locate()
    const reason = this.readOnlyReason(profile)
    if (reason) fail('read_only', reason)
    return profile!
  }

  @Remote('saveService')
  async saveService(id: KitId, enabled: boolean, config: Record<string, unknown> | null, expectedVersion: string): Promise<{ version: string }> {
    const profile = await this.writable()
    if (!KIT_ENTRIES.some((e) => e.id === id)) fail('bad_request', `unknown service ${id}`)
    try {
      return await writeKitEntries(profile.patchFile, { [id]: { enabled, ...(config ? { config } : {}) } }, expectedVersion)
    } catch (e) {
      if (isKitError(e)) fail(e.code, e.message, (e.details as { errors?: unknown } | undefined)?.errors)
      throw e
    }
  }

  @Remote('setSecret')
  async setSecret(target: KeyTarget, value: string): Promise<{ configured: boolean; source?: KeySource }> {
    await this.writable()
    await saveTypesafeKey(target, value, { ...this.keyStore, keychainService: 'ai.typesafe.api-key' })
    return describeTypesafeKey({ ...this.keyStore, keychainService: 'ai.typesafe.api-key' })
  }

  @Remote('clearSecret')
  async clearSecret(target: KeyTarget): Promise<{ configured: boolean; source?: KeySource }> {
    await this.writable()
    await clearTypesafeKey(target, { ...this.keyStore, keychainService: 'ai.typesafe.api-key' })
    return describeTypesafeKey({ ...this.keyStore, keychainService: 'ai.typesafe.api-key' })
  }
}
```

说明：`setSecret` 在运行中的 dsh 里经 `saveTypesafeKey('credentials', ...)` 直接写凭据文件；`dsh-credentials-local` 监视该文件并自动重新加载，因此无需调用 `ctx.credentials.set`，两种路径使用同一把锁、结果一致。

`src/admin/plugin.ts` 的 `apply` 改为：

```ts
import { AgentKitAdmin } from './service.js'

export function apply(ctx: Context): void {
  ctx.plugin(AgentKitAdmin)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/integration/admin.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 在真实 dsh loader 中验证远程调用可达**

在 `tests/integration/dsh-loader.test.ts` 增加用例：用 `boot()` 启动本包的 bundle（只需加载本包根行与一个提供 `loader` 的 dsh loader，不需要 typert gateway），断言 `ctx.get('agentKitAdmin')` 存在且其类原型带有 `status` 等 Remote 标记：

```ts
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
// ...
const admin = c.get('agentKitAdmin')
expect(admin).toBeDefined()
const names = remoteMethods(admin as object).map((m) => m.exportName ?? m.method).sort()
expect(names).toEqual(['clearSecret', 'saveService', 'setSecret', 'status'])
```

Run: `npx vitest run tests/integration`
Expected: PASS

- [ ] **Step 6: Commit（经用户同意后）**

```bash
git add src/admin tests/integration package.json package-lock.json
git commit -m "feat(admin): remote service for status, config and secrets"
```

---

### Task 9: Web 设置页

**Files:**
- Create: `src/client/remote.ts`、`src/client/locale.ts`、`src/client/settings-page.tsx`、`src/client/service-card.tsx`、`src/client/forms.tsx`
- Modify: `src/client/index.tsx`（挂载远程接口、注册真实页面）、`vitest.config.ts`（`.tsx` 测试使用 jsdom）
- Test: `tests/unit/client-page.test.tsx`

**Interfaces:**
- Consumes: `AdminStatus`（Task 8，前端复制一份类型到 `src/client/remote.ts`，避免前端引入服务端代码）；`ClientContext`（Task 1）。
- Produces:
  - `AGENT_KIT_REMOTE`：`$mount` 用的接口描述（4 个方法）
  - `interface AdminApi { status(): Promise<AdminStatus>; saveService(id, enabled, config, expectedVersion): Promise<{ version: string }>; setSecret(target, value): Promise<{ configured: boolean; source?: string }>; clearSecret(target): Promise<{ configured: boolean; source?: string }> }`
  - `createAdminApi(remote: ClientContext['remote']): AdminApi`：把 `{ ok, value, error }` 转换为 resolve / reject（`error.message` 为服务端 JSON 时解析出 `code` 与 `errors`）
  - `<SettingsPage api={AdminApi} t={...} />`

- [ ] **Step 1: 写失败测试**

```tsx
// tests/unit/client-page.test.tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../../src/client/settings-page.js'
import { createAdminApi, type AdminApi, type AdminStatus } from '../../src/client/remote.js'
import { zh } from '../../src/client/locale.js'

const t = (k: string, vars?: Record<string, string | number>) => (zh[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => String(vars?.[n] ?? ''))

function status(over: Partial<AdminStatus> = {}): AdminStatus {
  return {
    profile: 'kit',
    patchReload: 'live',
    version: 'v1',
    writable: true,
    services: [
      { id: 'agent-kit-ws', title: 'WebSocket', enabled: true, phase: 'active', health: { status: 'ok', detail: '1 connection(s) open' }, config: {} },
      { id: 'agent-kit-dingtalk', title: '钉钉', enabled: false, phase: null, health: null, config: undefined },
      { id: 'agent-kit-agent-tasks', title: 'Agent 任务', enabled: false, phase: null, health: null, config: undefined },
      { id: 'agent-kit-jev', title: 'Jev 判断', enabled: true, phase: 'failed', health: null, config: { model: 'jev-latest' } },
    ],
    checks: [{ id: 'agent-kit-jev.key', scope: 'agent-kit-jev', title: 'TypeSafe Key', status: 'fail', detail: '没有找到', fix: '设置 Key' }],
    typesafeKey: { configured: false },
    keyTargets: ['credentials'],
    ...over,
  }
}

function fakeApi(s: AdminStatus): AdminApi & { saveService: ReturnType<typeof vi.fn>; setSecret: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => s),
    saveService: vi.fn(async () => ({ version: 'v2' })),
    setSecret: vi.fn(async () => ({ configured: true, source: 'credentials' })),
    clearSecret: vi.fn(async () => ({ configured: false })),
  }
}

describe('SettingsPage', () => {
  it('renders one card per service with health and failing checks', async () => {
    render(<SettingsPage api={fakeApi(status())} t={t} />)
    expect(await screen.findByText('WebSocket')).toBeTruthy()
    expect(screen.getByText('1 connection(s) open')).toBeTruthy()
    expect(screen.getByText(/没有找到/)).toBeTruthy()
    expect(screen.getByText(/设置 Key/)).toBeTruthy()
  })

  it('enables a service and saves with the current version', async () => {
    const api = fakeApi(status())
    render(<SettingsPage api={api} t={t} />)
    const toggle = await screen.findByRole('switch', { name: /钉钉/ })
    fireEvent.click(toggle)
    fireEvent.change(screen.getByLabelText(zh['dingtalk.identity']!), { target: { value: 'bot' } })
    fireEvent.change(screen.getByLabelText(zh['dingtalk.robotCode']!), { target: { value: 'ding1' } })
    fireEvent.click(screen.getByRole('button', { name: `${zh.save} 钉钉` }))
    await waitFor(() => expect(api.saveService).toHaveBeenCalledWith('agent-kit-dingtalk', true, expect.objectContaining({ identity: 'bot', robotCode: 'ding1' }), 'v1'))
  })

  it('shows a conflict message and reloads', async () => {
    const api = fakeApi(status())
    api.saveService.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'conflict' }))
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${zh.save} WebSocket` }))
    expect(await screen.findByText(zh.conflict!)).toBeTruthy()
  })

  it('shows field errors from the server', async () => {
    const api = fakeApi(status())
    api.saveService.mockRejectedValueOnce(Object.assign(new Error('invalid'), { code: 'invalid_config', errors: [{ path: 'agent-kit-ws.readTimeoutMs', message: 'too small' }] }))
    render(<SettingsPage api={api} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${zh.save} WebSocket` }))
    expect(await screen.findByText(/readTimeoutMs: too small/)).toBeTruthy()
  })

  it('sets the TypeSafe key without ever displaying it', async () => {
    const api = fakeApi(status())
    render(<SettingsPage api={api} t={t} />)
    fireEvent.change(await screen.findByLabelText(zh['jev.key']!), { target: { value: 'ts-secret' } })
    fireEvent.click(screen.getByRole('button', { name: zh['jev.saveKey']! }))
    await waitFor(() => expect(api.setSecret).toHaveBeenCalledWith('credentials', 'ts-secret'))
    expect(document.body.textContent).not.toContain('ts-secret')
  })

  it('disables editing when read-only', async () => {
    render(<SettingsPage api={fakeApi(status({ writable: false, readOnlyReason: 'dsh Web 未绑定 127.0.0.1' }))} t={t} />)
    expect(await screen.findByText(/未绑定 127\.0\.0\.1/)).toBeTruthy()
    expect((screen.getByRole('switch', { name: /WebSocket/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('createAdminApi', () => {
  it('unwraps remote results and parses server error payloads', async () => {
    const remote = {
      agentKitAdmin: {
        status: async () => ({ ok: true, value: status() }),
        saveService: async () => ({ ok: false, error: { code: 'gateway/bad-request', message: JSON.stringify({ code: 'conflict', message: '已被修改' }) } }),
      },
    }
    const api = createAdminApi(remote as never)
    expect((await api.status()).profile).toBe('kit')
    await expect(api.saveService('agent-kit-ws', true, null, 'v1')).rejects.toMatchObject({ code: 'conflict', message: '已被修改' })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/client-page.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`vitest.config.ts` 的 `include` 增加 `'tests/unit/**/*.test.tsx'`；`coverage.exclude` 保留 `src/client/index.tsx`（需真实 dsh 前端环境，由 Task 10 手动走查覆盖）。

```ts
// src/client/remote.ts
import type { ClientContext, RemoteResult } from './host-types.js'

export type KitId = 'agent-kit-ws' | 'agent-kit-dingtalk' | 'agent-kit-agent-tasks' | 'agent-kit-jev'
export type KeyTarget = 'keychain' | 'credentials'
export interface CheckResult {
  id: string
  scope: string
  title: string
  status: 'pass' | 'warn' | 'fail' | 'skip'
  detail: string
  fix?: string
}
export interface AdminStatus {
  profile: string
  patchReload: 'live' | 'startup'
  version: string
  writable: boolean
  readOnlyReason?: string
  services: Array<{
    id: KitId
    title: string
    enabled: boolean
    phase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
    health: { status: 'ok' | 'degraded' | 'failed'; detail: string } | null
    config: Record<string, unknown> | undefined
  }>
  checks: CheckResult[]
  typesafeKey: { configured: boolean; source?: string }
  keyTargets: KeyTarget[]
}
export interface AdminApi {
  status(): Promise<AdminStatus>
  saveService(id: KitId, enabled: boolean, config: Record<string, unknown> | null, expectedVersion: string): Promise<{ version: string }>
  setSecret(target: KeyTarget, value: string): Promise<{ configured: boolean; source?: string }>
  clearSecret(target: KeyTarget): Promise<{ configured: boolean; source?: string }>
}
export class AdminError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message)
  }
}

const PKG = '@mc/dsh-agent-kit'
const json = { mode: 'strict', typeSymbol: `${PKG}#json`, schema: { parse: (v: unknown) => v } }
const method = (name: string, params: string[]) => ({
  id: `${PKG}#agentKitAdmin/${name}`,
  service: 'agentKitAdmin',
  namespace: 'agentKitAdmin',
  method: name,
  invocation: { kind: 'direct' },
  parameters: params.map((p) => ({ name: p, wire: p, source: 'json', codec: { ...json, typeSymbol: `${PKG}#agentKitAdmin/${name}:${p}` } })),
  result: { mode: 'src-json' },
})

/** 手写的远程接口描述（对应服务端 SRC 模式的 AgentKitAdmin）。 */
export const AGENT_KIT_REMOTE = {
  package: PKG,
  descriptors: [
    method('status', []),
    method('saveService', ['id', 'enabled', 'config', 'expectedVersion']),
    method('setSecret', ['target', 'value']),
    method('clearSecret', ['target']),
  ],
}

async function unwrap<T>(p: Promise<RemoteResult<T>>): Promise<T> {
  const r = await p
  if (r.ok) return r.value as T
  let payload: { code?: string; message?: string; errors?: { path: string; message: string }[] } = {}
  try {
    payload = JSON.parse(r.error?.message ?? '')
  } catch {
    payload = { code: r.error?.code, message: r.error?.message }
  }
  throw new AdminError(payload.code ?? 'unknown', payload.message ?? 'request failed', payload.errors)
}

export function createAdminApi(remote: ClientContext['remote']): AdminApi {
  const svc = remote.agentKitAdmin as Record<string, (...args: unknown[]) => Promise<RemoteResult<never>>>
  return {
    status: () => unwrap(svc.status!()),
    saveService: (id, enabled, config, expectedVersion) => unwrap(svc.saveService!(id, enabled, config, expectedVersion)),
    setSecret: (target, value) => unwrap(svc.setSecret!(target, value)),
    clearSecret: (target) => unwrap(svc.clearSecret!(target)),
  }
}
```

参数描述的结构 `{ name, wire, source: 'json', codec: { mode: 'strict', typeSymbol, schema } }` 与 dsh 生成的 `dsh-agent-presets/lib/typert.remote-client.js` 一致；`schema` 只需提供 `parse()`，这里原样返回，由服务端再做校验。

```ts
// src/client/locale.ts
export const zh: Record<string, string> = {
  nav: 'Agent Kit',
  title: 'Agent Kit 设置',
  profile: 'Profile：{name}',
  reloadStartup: '当前 Profile 为 startup 模式，保存后需重启 dsh 才生效。',
  readOnly: '只读：{reason}',
  loading: '加载中…',
  loadFailed: '加载失败：{message}',
  save: '保存',
  saving: '保存中…',
  saved: '已保存，dsh 正在加载新配置。',
  conflict: '配置文件已被其他人修改，已重新加载，请确认后再保存。',
  enabled: '启用',
  'phase.active': '运行中',
  'phase.failed': '启动失败',
  'phase.pending': '等待依赖',
  'phase.loading': '加载中',
  'phase.unloading': '卸载中',
  'phase.none': '未运行',
  'health.ok': '正常',
  'health.degraded': '降级',
  'health.failed': '失败',
  'dingtalk.identity': '发送身份',
  'dingtalk.robotCode': '机器人 robotCode',
  'dingtalk.webhookTokenEnv': 'webhook token 环境变量名',
  'dingtalk.targetChatId': '默认群 ID（cid…）',
  'dingtalk.dryRun': '只演练不真实发送（dryRun）',
  'agentTasks.workspaceDir': '任务工作目录（绝对路径）',
  'agentTasks.permission': '{provider} 权限上限',
  'agentTasks.permissionNone': '不使用',
  'ws.pingIntervalMs': 'ping 间隔（毫秒）',
  'ws.readTimeoutMs': '读超时（毫秒）',
  'jev.model': '模型',
  'jev.key': 'TypeSafe API Key',
  'jev.keyConfigured': '已配置（来源：{source}）',
  'jev.keyMissing': '未配置',
  'jev.saveKey': '保存 Key',
  'jev.clearKey': '清除',
  'jev.target': '保存到',
  'target.keychain': 'macOS 钥匙串（ai.typesafe.api-key）',
  'target.credentials': 'dsh 凭据文件',
}
```

```tsx
// src/client/forms.tsx
import { useState, type ReactNode } from 'react'
import type { KitId } from './remote.js'

export type T = (key: string, vars?: Record<string, string | number>) => string
type Config = Record<string, unknown>
export interface FormProps {
  config: Config
  onChange(next: Config): void
  disabled: boolean
  t: T
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const [id] = useState(() => `akf-${Math.random().toString(36).slice(2)}`)
  return (
    <div className="agent-kit-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  )
}

const text = (props: FormProps, key: string, label: string, type: 'text' | 'number' = 'text') => (
  <Field label={label}>
    {(id) => (
      <input
        id={id}
        type={type}
        disabled={props.disabled}
        value={(props.config[key] as string | number | undefined) ?? ''}
        onChange={(e) => props.onChange({ ...props.config, [key]: type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value || undefined })}
      />
    )}
  </Field>
)

function DingtalkForm(p: FormProps) {
  const target = (p.config.defaultTarget as { chatId?: string } | undefined)?.chatId ?? ''
  return (
    <>
      <Field label={p.t('dingtalk.identity')}>
        {(id) => (
          <select id={id} disabled={p.disabled} value={(p.config.identity as string) ?? ''} onChange={(e) => p.onChange({ ...p.config, identity: e.target.value })}>
            <option value="" disabled>—</option>
            <option value="bot">bot</option>
            <option value="user">user</option>
            <option value="webhook">webhook</option>
          </select>
        )}
      </Field>
      {p.config.identity === 'bot' && text(p, 'robotCode', p.t('dingtalk.robotCode'))}
      {p.config.identity === 'webhook' && text(p, 'webhookTokenEnv', p.t('dingtalk.webhookTokenEnv'))}
      {p.config.identity !== 'webhook' && (
        <Field label={p.t('dingtalk.targetChatId')}>
          {(id) => (
            <input id={id} disabled={p.disabled} value={target} onChange={(e) => p.onChange({ ...p.config, defaultTarget: e.target.value ? { chatId: e.target.value } : undefined })} />
          )}
        </Field>
      )}
      <Field label={p.t('dingtalk.dryRun')}>
        {(id) => <input id={id} type="checkbox" disabled={p.disabled} checked={p.config.dryRun === true} onChange={(e) => p.onChange({ ...p.config, dryRun: e.target.checked })} />}
      </Field>
    </>
  )
}

function AgentTasksForm(p: FormProps) {
  const declared = (p.config.declaredPermissions as Record<string, string> | undefined) ?? {}
  return (
    <>
      {text(p, 'workspaceDir', p.t('agentTasks.workspaceDir'))}
      {['claude-code', 'codex'].map((provider) => (
        <Field key={provider} label={p.t('agentTasks.permission', { provider })}>
          {(id) => (
            <select
              id={id}
              disabled={p.disabled}
              value={declared[provider] ?? ''}
              onChange={(e) => {
                const next = { ...declared }
                if (e.target.value) next[provider] = e.target.value
                else delete next[provider]
                p.onChange({ ...p.config, declaredPermissions: next })
              }}
            >
              <option value="">{p.t('agentTasks.permissionNone')}</option>
              <option value="read-only">read-only</option>
              <option value="workspace-write">workspace-write</option>
            </select>
          )}
        </Field>
      ))}
    </>
  )
}

function WsForm(p: FormProps) {
  return (
    <>
      {text(p, 'pingIntervalMs', p.t('ws.pingIntervalMs'), 'number')}
      {text(p, 'readTimeoutMs', p.t('ws.readTimeoutMs'), 'number')}
    </>
  )
}

function JevForm(p: FormProps) {
  return <>{text(p, 'model', p.t('jev.model'))}</>
}

export const FORMS: Record<KitId, (p: FormProps) => ReactNode> = {
  'agent-kit-ws': WsForm,
  'agent-kit-dingtalk': DingtalkForm,
  'agent-kit-agent-tasks': AgentTasksForm,
  'agent-kit-jev': JevForm,
}
```

```tsx
// src/client/service-card.tsx
import { useState } from 'react'
import { FORMS, type T } from './forms.js'
import type { AdminApi, AdminStatus, CheckResult } from './remote.js'
import { AdminError } from './remote.js'

type Service = AdminStatus['services'][number]

export function ServiceCard(props: { service: Service; checks: CheckResult[]; status: AdminStatus; api: AdminApi; t: T; onSaved(): void; onConflict(): void }) {
  const { service, t } = props
  const [enabled, setEnabled] = useState(service.enabled)
  const [config, setConfig] = useState<Record<string, unknown>>(service.config ?? {})
  const [message, setMessage] = useState<string>()
  const [saving, setSaving] = useState(false)
  const disabled = !props.status.writable || saving
  const Form = FORMS[service.id]

  const save = async () => {
    setSaving(true)
    setMessage(undefined)
    try {
      await props.api.saveService(service.id, enabled, enabled ? config : null, props.status.version)
      setMessage(t('saved'))
      props.onSaved()
    } catch (e) {
      const err = e as AdminError
      if (err.code === 'conflict') {
        setMessage(t('conflict'))
        props.onConflict()
      } else if (err.errors?.length) setMessage(err.errors.map((x) => `${x.path.replace(`${service.id}.`, '')}: ${x.message}`).join('\n'))
      else setMessage(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="agent-kit-card" aria-label={service.title}>
      <header>
        <h3>{service.title}</h3>
        <button type="button" role="switch" aria-checked={enabled} aria-label={`${t('enabled')} ${service.title}`} disabled={disabled} onClick={() => setEnabled(!enabled)}>
          {enabled ? 'ON' : 'OFF'}
        </button>
      </header>
      <p className="agent-kit-phase">
        {t(`phase.${service.phase ?? 'none'}`)}
        {service.health && (
          <>
            {' · '}
            {t(`health.${service.health.status}`)} · <span>{service.health.detail}</span>
          </>
        )}
      </p>
      <ul className="agent-kit-checks">
        {props.checks
          .filter((c) => c.status !== 'pass' && c.status !== 'skip')
          .map((c) => (
            <li key={c.id} data-status={c.status}>
              {c.title}：{c.detail}
              {c.fix && <div>→ {c.fix}</div>}
            </li>
          ))}
      </ul>
      {enabled && <Form config={config} onChange={setConfig} disabled={disabled} t={t} />}
      <button type="button" aria-label={`${t('save')} ${service.title}`} disabled={disabled} onClick={save}>
        {saving ? t('saving') : t('save')}
      </button>
      {message && <p role="status" style={{ whiteSpace: 'pre-line' }}>{message}</p>}
    </section>
  )
}
```

```tsx
// src/client/settings-page.tsx
import { useCallback, useEffect, useState } from 'react'
import type { T } from './forms.js'
import type { AdminApi, AdminStatus, KeyTarget } from './remote.js'
import { ServiceCard } from './service-card.js'

function KeyPanel({ status, api, t, onChanged }: { status: AdminStatus; api: AdminApi; t: T; onChanged(): void }) {
  const [value, setValue] = useState('')
  const [target, setTarget] = useState<KeyTarget>(status.keyTargets[0] ?? 'credentials')
  const [error, setError] = useState<string>()
  const disabled = !status.writable
  const save = async () => {
    setError(undefined)
    try {
      await api.setSecret(target, value)
      setValue('')
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="agent-kit-key" aria-label={t('jev.key')}>
      <p>{status.typesafeKey.configured ? t('jev.keyConfigured', { source: status.typesafeKey.source ?? '' }) : t('jev.keyMissing')}</p>
      <label htmlFor="agent-kit-key">{t('jev.key')}</label>
      <input id="agent-kit-key" type="password" autoComplete="off" disabled={disabled} value={value} onChange={(e) => setValue(e.target.value)} />
      <label htmlFor="agent-kit-key-target">{t('jev.target')}</label>
      <select id="agent-kit-key-target" disabled={disabled} value={target} onChange={(e) => setTarget(e.target.value as KeyTarget)}>
        {status.keyTargets.map((k) => (
          <option key={k} value={k}>{t(`target.${k}`)}</option>
        ))}
      </select>
      <button type="button" disabled={disabled || !value} onClick={save}>{t('jev.saveKey')}</button>
      {status.typesafeKey.configured && (
        <button type="button" disabled={disabled} onClick={async () => (await api.clearSecret(target), onChanged())}>{t('jev.clearKey')}</button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

export function SettingsPage({ api, t }: { api: AdminApi; t: T }) {
  const [status, setStatus] = useState<AdminStatus>()
  const [error, setError] = useState<string>()
  const [generation, setGeneration] = useState(0)
  const load = useCallback(async () => {
    try {
      setStatus(await api.status())
      setGeneration((g) => g + 1)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [api])
  useEffect(() => void load(), [load])
  // 保存后 dsh 重新加载 Service 需要时间，短暂轮询刷新状态
  const refreshSoon = useCallback(() => {
    for (const ms of [500, 1500, 3000]) setTimeout(() => void api.status().then(setStatus).catch(() => {}), ms)
  }, [api])

  if (error) return <p role="alert">{t('loadFailed', { message: error })}</p>
  if (!status) return <p>{t('loading')}</p>
  return (
    <div className="agent-kit-settings">
      <h2>{t('title')}</h2>
      <p>{t('profile', { name: status.profile })}</p>
      {status.patchReload === 'startup' && <p>{t('reloadStartup')}</p>}
      {!status.writable && <p role="note">{t('readOnly', { reason: status.readOnlyReason ?? '' })}</p>}
      {status.services.map((s) => (
        <div key={`${s.id}-${generation}`}>
          <ServiceCard service={s} checks={status.checks.filter((c) => c.scope === s.id)} status={status} api={api} t={t} onSaved={refreshSoon} onConflict={load} />
          {s.id === 'agent-kit-jev' && <KeyPanel status={status} api={api} t={t} onChanged={load} />}
        </div>
      ))}
    </div>
  )
}
```

`src/client/index.tsx` 替换 Task 1 的占位：

```tsx
import type { ClientContext } from './host-types.js'
import { zh } from './locale.js'
import { AGENT_KIT_REMOTE, createAdminApi } from './remote.js'
import { SettingsPage } from './settings-page.js'

export const inject = ['slots', 'locale', 'remote']
const NS = 'settings.agentKit'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh }), 'agent-kit: dictionaries')
  const t = ctx.locale.bind(NS)
  let disposeRemote: (() => void) | undefined
  const ready = ctx.remote.$mount(AGENT_KIT_REMOTE).then((d) => (disposeRemote = d))
  ctx.effect(() => () => disposeRemote?.(), 'agent-kit: remote')
  const api = createAdminApi(ctx.remote)
  const lazyApi = {
    status: async () => (await ready, api.status()),
    saveService: async (...a: Parameters<typeof api.saveService>) => (await ready, api.saveService(...a)),
    setSecret: async (...a: Parameters<typeof api.setSecret>) => (await ready, api.setSecret(...a)),
    clearSecret: async (...a: Parameters<typeof api.clearSecret>) => (await ready, api.clearSecret(...a)),
  }
  const Page = () => <SettingsPage api={lazyApi} t={t} />
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'agent-kit', order: 40, label: () => t('nav'), locale: NS }, Page),
  )
}
```

Task 1 的 `client-build.test.ts` 中 `shared` 需包含本任务新增的共享模块引用（仍只有 `react`、`react/jsx-runtime`）；如构建产物出现其他 `require`，测试会报出，按共享列表调整。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/client-page.test.tsx tests/unit/client-build.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit（经用户同意后）**

```bash
git add src/client tests/unit/client-page.test.tsx vitest.config.ts
git commit -m "feat(client): Agent Kit settings page in dsh web"
```

---

### Task 10: 文档、真实环境走查与收尾

**Files:**
- Modify: `README.md`、`docs/superpowers/specs/2026-09-24-dsh-agent-kit-onboarding-design.md`（状态改为已实施，补「核实结论」）、`docs/superpowers/specs/2026-09-23-dsh-agent-kit-design.md`（Jev 读取顺序增加 dsh 凭据；目录结构增加新模块；安全一节补 Web 写入限制）
- Create: `docs/walkthrough/2026-09-24-onboarding/`（截图）

**Interfaces:**
- Consumes: 全部前序任务。

- [ ] **Step 1: 全量校验**

Run: `npm run typecheck && npm run build && npx vitest run --coverage`
Expected: 全部通过；覆盖率不低于行 80%、分支 70%。

- [ ] **Step 2: 真实 dsh Web 走查（macOS 本机）**

```bash
npm pack
export DSH_HOME="$(mktemp -d)"
npx -y @deepseek-ai/dsh@0.1.5-rc.3 plugin --profile kit add "$PWD/mc-dsh-agent-kit-0.1.0.tgz"
node bin/dsh-agent-kit.mjs doctor --profile kit
npx -y @deepseek-ai/dsh@0.1.5-rc.3 --profile kit --no-open
```

在浏览器中逐项操作并截图保存到 `docs/walkthrough/2026-09-24-onboarding/`：
1. 设置 → Agent Kit：四张卡片、检查结果可见。
2. 启用钉钉（bot + dryRun），保存 → 卡片状态变为「运行中」。
3. 另开终端修改 `cordis.patch.yml` 后再在页面保存 → 出现冲突提示并自动刷新。
4. 输入 TypeSafe Key 保存 → 显示「已配置（来源：…）」，页面与网络响应中都不出现 Key。
5. 以 `host: 0.0.0.0` 启动（在 Profile patch 中覆盖 webserver 配置）→ 页面只读。

- [ ] **Step 3: 命令行走查**

Run: `node bin/dsh-agent-kit.mjs setup --profile kit`，按提示启用 jev 并选择钥匙串，确认差异后写入，最后 doctor 全部通过。

- [ ] **Step 4: 更新文档**

- README 新增「快速配置」一节：`npx @mc/dsh-agent-kit setup`、`doctor`、Web 设置页入口与只读条件、三平台密钥保存位置。
- 两份规格按上面的 Files 说明更新，并把 Task 1 Step 7、Task 8 Step 5 的实际核实结果写入 onboarding 规格的「核实结论」。

- [ ] **Step 5: Commit（经用户同意后）**

```bash
git add README.md docs
git commit -m "docs: onboarding guide, walkthrough and spec updates"
```
