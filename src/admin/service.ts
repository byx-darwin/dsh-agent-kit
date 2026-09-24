import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createCheckContext, runChecks, type CheckResult } from '../checks/index.js'
import { isKitError } from '../common/errors.js'
import { redact } from '../common/redact.js'
import type { ServiceHealth } from '../common/service.js'
import { KIT_ENTRIES, locateProfile, readKitEntries, writeKitEntries, writePatchEntries, type KitId, type ProfileInfo } from '../profile/index.js'
import {
  clearSecretRef,
  clearTypesafeKey,
  describeSecretRef,
  describeTypesafeKey,
  saveSecretRef,
  saveTypesafeKey,
  TYPESAFE_KEY_REF,
  type KeySource,
  type KeyStoreOptions,
  type KeyTarget,
  type SecretRefSource,
} from '../secrets/index.js'
import { assertEntry, entrySecretRefs, validateEntryConfig, type AgentKitEntry, type EntryField, type RegisteredEntry } from './entry.js'
import { collectEntries } from './registry.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentKitAdmin: AgentKitAdmin
  }
}

/**
 * 与 cordis `FiberState`（`@deepseek-ai/cordis` 的 `const enum`，因 `isolatedModules` 无法直接
 * import）保持一致的数值映射：PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5。
 * `AdminStatus['services'][number]['phase']` 未纳入 `disposed`，映射为 null。
 */
const PHASE_BY_STATE: Record<number, 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

export interface AdminConfig {
  /** 测试用：显式指定 Profile 目录；缺省时由 ctx.baseUrl 推断。 */
  profileDir?: string
  /** 测试用：密钥存储选项。 */
  keyStore?: KeyStoreOptions
}

type Phase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

export interface AdminServiceStatus {
  /** 本包的行 id，或业务包登记的行 id。 */
  id: KitId | (string & {})
  title: string
  enabled: boolean
  phase: Phase
  health: Pick<ServiceHealth, 'status' | 'detail'> | null
  config: Record<string, unknown> | undefined
  /** 本包的行：登记了 `dependsOn` 这一行的业务行，停用或重载本行会连带卸载它们。没有时省略。 */
  dependents?: Array<{ id: string; title: string }>
  /** 以下只出现在业务包登记的行上（issue #1）。 */
  registered?: true
  fields?: EntryField[]
  secrets?: Array<{ label: string; ref: string | null; configured: boolean; source?: SecretRefSource }>
}

export interface AdminStatus {
  profile: string
  patchReload: 'live' | 'startup'
  version: string
  writable: boolean
  readOnlyReason?: string
  services: AdminServiceStatus[]
  checks: CheckResult[]
  typesafeKey: { configured: boolean; source?: KeySource }
  keyTargets: KeyTarget[]
}

type LoaderEntry = { id: string; disabled?: unknown; fiber?: { state: number } }
type Loader = { entries(): Iterable<LoaderEntry> }
type WebServer = { host?: string }
type Credentials = KeyStoreOptions['credentials']
type JevKeychainFields = { keychainService?: string | string[]; keychainAccount?: string }

function redactError(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e))
}

/**
 * 从 `agent-kit-jev` 的配置里提取密钥定位选项，供 `status()`/`jev` 检查读取时使用（I1）。只在
 * jev 配置里显式给出了字段时才覆盖 `keyStore` 的同名字段——绝不能无条件展开 `{ keychainService:
 * config.keychainService }`，否则 jev 未配置 `keychainAccount` 时会用 `undefined` 覆盖调用方
 * `keyStore.keychainAccount` 里已经给出的真实账户名。未配置 `keychainService` 时不覆盖，交由
 * `secrets/typesafe-key.ts` 的平台默认值（macOS 上回退到 `SHARED_KEYCHAIN_SERVICE`）处理。
 */
function jevKeychainReadOptions(config: Record<string, unknown> | undefined): JevKeychainFields {
  const c = (config ?? {}) as JevKeychainFields
  return {
    ...(c.keychainService !== undefined ? { keychainService: c.keychainService } : {}),
    ...(c.keychainAccount !== undefined ? { keychainAccount: c.keychainAccount } : {}),
  }
}

/**
 * 同上，但供 `setSecret`/`clearSecret` 写入/清除单个钥匙串条目时使用：数组形式的
 * `keychainService` 取第一个（约定的“首选”服务名），因为写入/清除只能针对一个具体的服务名。
 */
function jevKeychainWriteOptions(config: Record<string, unknown> | undefined): JevKeychainFields {
  const c = (config ?? {}) as JevKeychainFields
  const keychainService = Array.isArray(c.keychainService) ? c.keychainService[0] : c.keychainService
  return {
    ...(keychainService !== undefined ? { keychainService } : {}),
    ...(c.keychainAccount !== undefined ? { keychainAccount: c.keychainAccount } : {}),
  }
}

/**
 * `cordis-plugin-loader` 给 `loader.entries()` 返回的 `id` 并不是我们在 `patch.yml`/`KIT_ENTRIES`
 * 里写的裸 id（如 `agent-kit-dingtalk`），而是带上了它所在的（可能多层嵌套的）父级 `insert:` 树的
 * id、用 `EntryTree.sep`（即 `:`）拼接的完整路径（真实 dsh Web 走查中抓到的例子：整层 bundle 被套在
 * 一个 `include` 树里，实际 id 是 `include:agent-kit-dingtalk`）。这个前缀的层数、内容都不受本包控制
 * （由宿主如何组织 `insert:` 决定），且同一次运行里可能所有条目统一带同一个前缀、也可能不带（例如若
 * 干条目的 id 本身没有冒号）。之前直接用裸 id 做 `Map` 的 key 去查（`entries.get(meta.id)`），在真实
 * dsh Web 里永远查不到——`entry` 恒为 `undefined`，导致 `phase` 恒为 `null`（页面显示「未运行」），
 * 即便对应的 fiber 其实已经是 `state: 2`（active）。这里改为按 `:` 切分后取最后一段索引，只要我们
 * 自己的 `KIT_ENTRIES` id（`agent-kit-*`，不含冒号）作为某个真实 entry id 的最后一段出现，就能匹配到，
 * 不受前缀层数影响。
 */
function indexLoaderEntries(entries: Iterable<LoaderEntry>): Map<string, LoaderEntry> {
  const map = new Map<string, LoaderEntry>()
  for (const entry of entries) {
    const bare = entry.id.split(':').pop()!
    map.set(bare, entry)
  }
  return map
}

/**
 * `saveTypesafeKey`/`clearTypesafeKey` 直接对 `$DSH_HOME/.credentials.yaml` 做加锁原子写——这正是真实
 * dsh 里挂载的 `credentials` 服务（`@deepseek-ai/dsh-credentials-local`）自己期望的写入方式（它自身也
 * 是靠同一把跨进程锁去改这份文件，并没有对外暴露一个 write() 方法，只有只读的 `resolve`/`describe`）。
 * 但该服务用 chokidar 监听文件、默认 100ms 防抖（`awaitWriteFinish.stabilityThreshold`）才把新内容
 * 并入内存快照；`keyStore.credentials` 存在时，`describeTypesafeKey` 会优先用这个实时服务的 `resolve()`
 * 而不是直接读文件（为了同时支持它自己实现的进程环境变量/`.env` 兜底优先级，不能简单绕过改成直接读
 * 文件）。写完立刻调用它，读到的往往还是防抖窗口内的旧快照——在真实 dsh Web 走查中复现过：点「保存
 * Key」之后，`setSecret` 自己的响应就是 `{ configured: false }`（网络面板抓到过，写入到响应只隔了几
 * 毫秒，远小于 100ms 防抖），紧接着设置页自己再 `status()` 一次拿到的也是同一份旧快照，页面停留在
 * 「未配置」，且不会再自动重试（`KeyPanel` 保存后只 `load()` 一次，不像 `ServiceCard` 那样有轮询）。
 * 这里在返回前对 `describeTypesafeKey` 做几次短间隔重试，直到读到的 `configured` 状态和我们刚做的
 * 写入动作一致（或重试次数耗尽），把这个防抖窗口的竞态吸收在 `setSecret`/`clearSecret` 自己的响应
 * 里——因为调用方（`KeyPanel.save()`）在 `await api.setSecret(...)` 之后才会去做后续的 `status()`
 * 刷新，只要这次调用不提前返回，后续刷新时防抖窗口早已过去，能读到真实的最新状态。
 */
async function describeAfterWrite<R extends { configured: boolean }>(expectConfigured: boolean, describe: () => Promise<R>): Promise<R> {
  let last = await describe()
  for (let attempt = 0; attempt < 6 && last.configured !== expectConfigured; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    last = await describe()
  }
  return last
}

function phaseOf(entry: LoaderEntry | undefined): Phase {
  return entry?.fiber ? (PHASE_BY_STATE[entry.fiber.state] ?? null) : null
}

/**
 * 以业务错误码抛出 `RemoteError('gateway/bad-request', ...)`。`RemoteError` 自身的 `code` 是
 * 固定的传输层枚举（`gateway/bad-request` 等，由 `@deepseek-ai/dsh-typert-protocol` 声明），
 * 业务错误码（read_only、conflict、invalid_config…）随 `message` 以 JSON `{ code, message, errors? }`
 * 传递，由前端解析。
 */
function failWith(code: string, message: string, errors?: readonly object[]): never {
  throw new RemoteError('gateway/bad-request', JSON.stringify({ code, message, ...(errors ? { errors } : {}) }), { issues: errors })
}

/**
 * 手动应用 `Remote` 装饰器标记，而非使用 `@Remote(...)` 语法。
 *
 * 原因：本仓库 tsconfig 未开启 `experimentalDecorators`（使用 TC39 Stage-3 装饰器），`tsc`
 * 会把它降级为 `__esDecorate` 辅助函数，构建产物（lib/，被 dsh-loader 集成测试消费）没有问题；
 * 但 Vitest 4 的默认转换器（oxc）目前只处理旧版 `experimentalDecorators` 语法，遇到 TC39
 * 装饰器语法会原样保留、假设运行时原生支持——而 Node（截至本仓库使用的版本）尚不支持该语法，
 * 于是单测直接抛出 `SyntaxError: Invalid or unexpected token`。尝试过的规避方式均未生效：
 * `esbuild.target`/`esbuild.supported.decorators` 会在 vite 内部被 `convertEsbuildConfigToOxcConfig`
 * 丢弃（只转换 jsx/define/banner/footer），`oxc: false` 与 `esbuild` 同时设置时又会被转换回 oxc。
 * `Remote(name)` 本身只是一个普通函数 `(method, context) => void`，其效果是通过
 * `context.addInitializer` 在原型上写入一份可被 `remoteMethods()` 读取的标记；构造一个满足最小
 * 形状的 `context`（`addInitializer` 立即以 `Object.create(prototype)` 为 `this` 执行）即可在类
 * 声明后手动完成同样的注册，不依赖装饰器语法，因此在 tsc 构建产物与 Vitest 转换后的源码里行为一致。
 */
function markRemote(prototype: object, method: string): void {
  const decorate = Remote(method) as (m: unknown, c: ClassMethodDecoratorContext) => void
  const context = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: { has: (o: object) => method in o, get: (o: Record<string, unknown>) => o[method] },
    addInitializer: (fn: () => void) => fn.call(Object.create(prototype)),
  } as unknown as ClassMethodDecoratorContext
  decorate((prototype as Record<string, unknown>)[method], context)
}

export class AgentKitAdmin extends TypertRemoteService {
  static inject = ['loader']
  private profile?: ProfileInfo
  /** 运行时登记的业务行（issue #1），键为行 id。 */
  private readonly registry = new Map<string, AgentKitEntry>()

  constructor(
    ctx: Context,
    private readonly config: AdminConfig = {},
  ) {
    super(ctx, 'agentKitAdmin')
  }

  private get keyStore(): KeyStoreOptions {
    const credentials = (this.ctx as unknown as { get(name: 'credentials'): Credentials }).get('credentials')
    return { ...(credentials ? { credentials } : {}), ...this.config.keyStore }
  }

  private async locate(): Promise<ProfileInfo | undefined> {
    if (this.profile) return this.profile
    const baseUrl = (this.ctx as unknown as { baseUrl?: string }).baseUrl
    const dir = this.config.profileDir ?? (baseUrl ? dirname(fileURLToPath(new URL('./cordis.yml', baseUrl))) : undefined)
    if (!dir) return undefined
    this.profile = await locateProfile(basename(dir), dirname(dirname(dir))).catch(() => undefined)
    return this.profile
  }

  /**
   * 只读闸门：默认关闭（fail closed）。仅当 `webServer.host` 恰好为 `'127.0.0.1'` 时才可写；
   * `webServer` 未加载、或其 `host` 为 `undefined`、或绑定了其他地址，一律只读。
   */
  private readOnlyReason(profile: ProfileInfo | undefined): string | undefined {
    if (!profile) return '无法定位 Profile 目录'
    const host = (this.ctx as unknown as { get(name: 'webServer'): WebServer | undefined }).get('webServer')?.host
    if (host === '127.0.0.1') return undefined
    return 'dsh Web 未绑定 127.0.0.1（或未加载 webServer），设置页为只读'
  }

  private keyTargets(): KeyTarget[] {
    return (this.keyStore.platform ?? process.platform) === 'darwin' ? ['keychain', 'credentials'] : ['credentials']
  }

  /**
   * 把业务包的一行 loader 配置登记到设置页、`status()`、`saveService` 与密钥管理（issue #1）。
   * 登记随调用方插件的生命周期注销（经 cordis 的调用方追踪，`this.ctx` 是调用方的上下文）；
   * 也可以调用返回的函数提前注销。业务插件启动失败时登记不会发生，所以同时建议在 `package.json`
   * 的 `dsh.agentKit.entries` 里声明静态清单，见 `loadManifestEntries`。
   */
  registerEntry(entry: AgentKitEntry): () => void {
    assertEntry(entry)
    const registry = this.registry
    if (registry.has(entry.id)) throw new Error(`agent-kit entry ${entry.id} is already registered`)
    const dispose = this.ctx.effect(() => {
      registry.set(entry.id, entry)
      return () => {
        if (registry.get(entry.id) === entry) registry.delete(entry.id)
      }
    }, `agent-kit: entry ${entry.id}`)
    return () => void dispose()
  }

  private registeredHealth(entry: AgentKitEntry, loaderEntry: LoaderEntry | undefined): AdminServiceStatus['health'] {
    if (loaderEntry?.fiber?.state !== 2) return null
    try {
      const svc = entry.service ? (this.ctx as unknown as { get(name: string): { health?(): ServiceHealth } | undefined }).get(entry.service) : undefined
      const health = entry.health ? entry.health() : svc?.health?.()
      return health ? { status: health.status, detail: redact(health.detail) } : null
    } catch (e) {
      return { status: 'failed', detail: `health() 执行失败：${redactError(e)}` }
    }
  }

  private async registeredStatus(items: readonly RegisteredEntry[], loaderEntries: Map<string, LoaderEntry>): Promise<AdminServiceStatus[]> {
    return Promise.all(
      items.map(async ({ entry, state }) => ({
        id: entry.id,
        title: entry.label,
        enabled: state.enabled,
        phase: phaseOf(loaderEntries.get(entry.id)),
        health: this.registeredHealth(entry, loaderEntries.get(entry.id)),
        config: state.config,
        registered: true as const,
        fields: [...(entry.fields ?? [])],
        secrets: await Promise.all(
          entrySecretRefs(entry, state.config).map(async ({ label, ref }) => ({
            label,
            ref: ref ?? null,
            ...(ref ? await describeSecretRef(ref, this.keyStore) : { configured: false }),
          })),
        ),
      })),
    )
  }

  private dependents(items: readonly RegisteredEntry[], id: KitId): Pick<AdminServiceStatus, 'dependents'> {
    const dependents = items.filter(({ entry }) => entry.dependsOn?.includes(id)).map(({ entry }) => ({ id: entry.id, title: entry.label }))
    return dependents.length > 0 ? { dependents } : {}
  }

  async status(): Promise<AdminStatus> {
    const profile = await this.locate()
    const loader = (this.ctx as unknown as { get(name: 'loader'): Loader }).get('loader')
    const entries = indexLoaderEntries(loader.entries())
    const keyTargets = this.keyTargets()

    if (!profile) {
      // 无法定位 Profile 目录：不再抛错，返回只读的降级状态，供设置页展示原因。
      const registered = await collectEntries(undefined, this.registry.values())
      return {
        profile: '',
        patchReload: 'startup',
        version: '',
        writable: false,
        readOnlyReason: '无法定位 Profile 目录',
        services: [
          ...KIT_ENTRIES.map((meta) => ({
            id: meta.id,
            title: meta.title,
            enabled: false,
            phase: phaseOf(entries.get(meta.id)),
            health: null,
            config: undefined,
            ...this.dependents(registered.entries, meta.id),
          })),
          ...(await this.registeredStatus(registered.entries, entries)),
        ],
        checks: [],
        typesafeKey: await describeTypesafeKey(this.keyStore),
        keyTargets,
      }
    }

    const snapshot = await readKitEntries(profile.patchFile)
    const registered = await collectEntries(profile, this.registry.values())
    const report = await runChecks(await createCheckContext(profile, { snapshot, keyStore: this.keyStore }), registered)
    const reason = this.readOnlyReason(profile)
    const jevConfig = (snapshot.entries['agent-kit-jev'].config ?? {}) as JevKeychainFields
    return {
      profile: profile.name,
      patchReload: profile.patchReload,
      version: snapshot.version,
      writable: reason === undefined,
      ...(reason ? { readOnlyReason: reason } : {}),
      services: [
        ...KIT_ENTRIES.map((meta) => {
          const entry = entries.get(meta.id)
          const svc = (this.ctx as unknown as { get(name: string): { health?(): ServiceHealth } | undefined }).get(meta.service)
          const health = entry?.fiber?.state === 2 && svc?.health ? svc.health() : null
          return {
            id: meta.id,
            title: meta.title,
            enabled: snapshot.entries[meta.id].enabled,
            phase: phaseOf(entry),
            health: health ? { status: health.status, detail: health.detail } : null,
            config: snapshot.entries[meta.id].config,
            ...this.dependents(registered.entries, meta.id),
          }
        }),
        ...(await this.registeredStatus(registered.entries, entries)),
      ],
      checks: report.results,
      typesafeKey: await describeTypesafeKey({ ...this.keyStore, ...jevKeychainReadOptions(jevConfig) }),
      keyTargets,
    }
  }

  private async writable(): Promise<ProfileInfo> {
    const profile = await this.locate()
    const reason = this.readOnlyReason(profile)
    if (reason) failWith('read_only', reason)
    return profile!
  }

  async saveService(id: string, enabled: boolean, config: Record<string, unknown> | null, expectedVersion: string): Promise<{ version: string }> {
    const profile = await this.writable()
    const change = { enabled, ...(config ? { config } : {}) }
    try {
      if (KIT_ENTRIES.some((e) => e.id === id)) return await writeKitEntries(profile.patchFile, { [id as KitId]: change }, expectedVersion)
      const { entries } = await collectEntries(profile, this.registry.values())
      const registered = entries.find((e) => e.entry.id === id)?.entry
      if (!registered) failWith('bad_request', `unknown service ${id}`)
      return await writePatchEntries(profile.patchFile, { [id]: change }, expectedVersion, (_id, c) => validateEntryConfig(registered!, c))
    } catch (e) {
      if (e instanceof RemoteError) throw e
      if (isKitError(e)) failWith(e.code, e.message, (e.details as { errors?: readonly object[] } | undefined)?.errors)
      throw e
    }
  }

  private validateSecretInput(target: KeyTarget, value: string): void {
    if (!this.keyTargets().includes(target)) failWith('bad_request', `unsupported key target: ${target}`)
    if (typeof value !== 'string' || !value.trim()) failWith('bad_request', 'value must be a non-empty string')
  }

  /**
   * 确认 `ref` 是某个登记行按当前配置解析出的密钥，且目标是凭据文件（业务插件运行时只从
   * `ctx.credentials` / 环境变量读取，不读钥匙串）。
   */
  private async registeredRef(target: KeyTarget, ref: string): Promise<void> {
    if (target !== 'credentials') failWith('bad_request', `secret ${ref} can only be stored in the credentials file`)
    const profile = await this.writable()
    const { entries } = await collectEntries(profile, this.registry.values())
    if (!entries.some(({ entry, state }) => entrySecretRefs(entry, state.config).some((s) => s.ref === ref))) failWith('bad_request', `unknown secret ref ${ref}`)
  }

  /**
   * `ref` 缺省（或为 `TYPESAFE_API_KEY`）时存取 TypeSafe Key；否则存取业务行登记的密钥（issue #1）。
   * 注意：dsh 网关从方法源码解析参数名，参数不能带默认值。
   */
  async setSecret(target: KeyTarget, value: string, ref?: string | null): Promise<{ configured: boolean; source?: KeySource }> {
    this.validateSecretInput(target, value)
    if (ref != null && ref !== TYPESAFE_KEY_REF) {
      await this.registeredRef(target, ref)
      try {
        await saveSecretRef(ref, value, this.keyStore)
      } catch (e) {
        failWith('bad_request', `failed to save secret: ${redactError(e)}`)
      }
      return describeAfterWrite(true, () => describeSecretRef(ref, this.keyStore))
    }
    const profile = await this.writable()
    const snapshot = await readKitEntries(profile.patchFile)
    const options = { ...this.keyStore, ...jevKeychainWriteOptions(snapshot.entries['agent-kit-jev'].config) }
    try {
      await saveTypesafeKey(target, value, options)
    } catch (e) {
      if (e instanceof RemoteError) throw e
      failWith('bad_request', `failed to save secret: ${redactError(e)}`)
    }
    return describeAfterWrite(true, () => describeTypesafeKey(options))
  }

  async clearSecret(target: KeyTarget, ref?: string | null): Promise<{ configured: boolean; source?: KeySource }> {
    if (!this.keyTargets().includes(target)) failWith('bad_request', `unsupported key target: ${target}`)
    if (ref != null && ref !== TYPESAFE_KEY_REF) {
      await this.registeredRef(target, ref)
      try {
        await clearSecretRef(ref, this.keyStore)
      } catch (e) {
        failWith('bad_request', `failed to clear secret: ${redactError(e)}`)
      }
      return describeAfterWrite(false, () => describeSecretRef(ref, this.keyStore))
    }
    const profile = await this.writable()
    const snapshot = await readKitEntries(profile.patchFile)
    const options = { ...this.keyStore, ...jevKeychainWriteOptions(snapshot.entries['agent-kit-jev'].config) }
    try {
      await clearTypesafeKey(target, options)
    } catch (e) {
      if (e instanceof RemoteError) throw e
      failWith('bad_request', `failed to clear secret: ${redactError(e)}`)
    }
    return describeAfterWrite(false, () => describeTypesafeKey(options))
  }
}

for (const method of ['status', 'saveService', 'setSecret', 'clearSecret']) markRemote(AgentKitAdmin.prototype, method)
