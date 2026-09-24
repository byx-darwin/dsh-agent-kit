import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createCheckContext, runChecks, type CheckResult } from '../checks/index.js'
import { isKitError } from '../common/errors.js'
import { redact } from '../common/redact.js'
import type { ServiceHealth } from '../common/service.js'
import { KIT_ENTRIES, locateProfile, readKitEntries, writeKitEntries, type KitId, type ProfileInfo } from '../profile/index.js'
import { clearTypesafeKey, describeTypesafeKey, saveTypesafeKey, type KeySource, type KeyStoreOptions, type KeyTarget } from '../secrets/index.js'

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
    health: Pick<ServiceHealth, 'status' | 'detail'> | null
    config: Record<string, unknown> | undefined
  }>
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
async function describeAfterWrite(expectConfigured: boolean, options: KeyStoreOptions): Promise<{ configured: boolean; source?: KeySource }> {
  let last = await describeTypesafeKey(options)
  for (let attempt = 0; attempt < 6 && last.configured !== expectConfigured; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    last = await describeTypesafeKey(options)
  }
  return last
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

  async status(): Promise<AdminStatus> {
    const profile = await this.locate()
    const loader = (this.ctx as unknown as { get(name: 'loader'): Loader }).get('loader')
    const entries = indexLoaderEntries(loader.entries())
    const keyTargets = this.keyTargets()

    if (!profile) {
      // 无法定位 Profile 目录：不再抛错，返回只读的降级状态，供设置页展示原因。
      return {
        profile: '',
        patchReload: 'startup',
        version: '',
        writable: false,
        readOnlyReason: '无法定位 Profile 目录',
        services: KIT_ENTRIES.map((meta) => {
          const entry = entries.get(meta.id)
          return {
            id: meta.id,
            title: meta.title,
            enabled: false,
            phase: entry?.fiber ? (PHASE_BY_STATE[entry.fiber.state] ?? null) : null,
            health: null,
            config: undefined,
          }
        }),
        checks: [],
        typesafeKey: await describeTypesafeKey(this.keyStore),
        keyTargets,
      }
    }

    const snapshot = await readKitEntries(profile.patchFile)
    const report = await runChecks(await createCheckContext(profile, { snapshot, keyStore: this.keyStore }))
    const reason = this.readOnlyReason(profile)
    const jevConfig = (snapshot.entries['agent-kit-jev'].config ?? {}) as JevKeychainFields
    return {
      profile: profile.name,
      patchReload: profile.patchReload,
      version: snapshot.version,
      writable: reason === undefined,
      ...(reason ? { readOnlyReason: reason } : {}),
      services: KIT_ENTRIES.map((meta) => {
        const entry = entries.get(meta.id)
        const svc = (this.ctx as unknown as { get(name: string): { health?(): ServiceHealth } | undefined }).get(meta.service)
        const health = entry?.fiber?.state === 2 && svc?.health ? svc.health() : null
        return {
          id: meta.id,
          title: meta.title,
          enabled: snapshot.entries[meta.id].enabled,
          phase: entry?.fiber ? (PHASE_BY_STATE[entry.fiber.state] ?? null) : null,
          health: health ? { status: health.status, detail: health.detail } : null,
          config: snapshot.entries[meta.id].config,
        }
      }),
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

  async saveService(id: KitId, enabled: boolean, config: Record<string, unknown> | null, expectedVersion: string): Promise<{ version: string }> {
    const profile = await this.writable()
    if (!KIT_ENTRIES.some((e) => e.id === id)) failWith('bad_request', `unknown service ${id}`)
    try {
      return await writeKitEntries(profile.patchFile, { [id]: { enabled, ...(config ? { config } : {}) } }, expectedVersion)
    } catch (e) {
      if (isKitError(e)) failWith(e.code, e.message, (e.details as { errors?: readonly object[] } | undefined)?.errors)
      throw e
    }
  }

  private validateSecretInput(target: KeyTarget, value: string): void {
    if (!this.keyTargets().includes(target)) failWith('bad_request', `unsupported key target: ${target}`)
    if (typeof value !== 'string' || !value.trim()) failWith('bad_request', 'value must be a non-empty string')
  }

  async setSecret(target: KeyTarget, value: string): Promise<{ configured: boolean; source?: KeySource }> {
    this.validateSecretInput(target, value)
    const profile = await this.writable()
    const snapshot = await readKitEntries(profile.patchFile)
    const options = { ...this.keyStore, ...jevKeychainWriteOptions(snapshot.entries['agent-kit-jev'].config) }
    try {
      await saveTypesafeKey(target, value, options)
    } catch (e) {
      if (e instanceof RemoteError) throw e
      failWith('bad_request', `failed to save secret: ${redactError(e)}`)
    }
    return describeAfterWrite(true, options)
  }

  async clearSecret(target: KeyTarget): Promise<{ configured: boolean; source?: KeySource }> {
    if (!this.keyTargets().includes(target)) failWith('bad_request', `unsupported key target: ${target}`)
    const profile = await this.writable()
    const snapshot = await readKitEntries(profile.patchFile)
    const options = { ...this.keyStore, ...jevKeychainWriteOptions(snapshot.entries['agent-kit-jev'].config) }
    try {
      await clearTypesafeKey(target, options)
    } catch (e) {
      if (e instanceof RemoteError) throw e
      failWith('bad_request', `failed to clear secret: ${redactError(e)}`)
    }
    return describeAfterWrite(false, options)
  }
}

for (const method of ['status', 'saveService', 'setSecret', 'clearSecret']) markRemote(AgentKitAdmin.prototype, method)
