import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createCheckContext, runChecks, type CheckResult } from '../checks/index.js'
import { isKitError } from '../common/errors.js'
import type { ServiceHealth } from '../common/service.js'
import { KIT_ENTRIES, locateProfile, readKitEntries, writeKitEntries, type KitId, type ProfileInfo } from '../profile/index.js'
import { clearTypesafeKey, describeTypesafeKey, saveTypesafeKey, SHARED_KEYCHAIN_SERVICE, type KeySource, type KeyStoreOptions, type KeyTarget } from '../secrets/index.js'

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

  private readOnlyReason(profile: ProfileInfo | undefined): string | undefined {
    if (!profile) return '无法定位 Profile 目录'
    const host = (this.ctx as unknown as { get(name: 'webServer'): WebServer | undefined }).get('webServer')?.host
    if (host !== undefined && host !== '127.0.0.1') return 'dsh Web 未绑定 127.0.0.1，设置页为只读'
    return undefined
  }

  async status(): Promise<AdminStatus> {
    const profile = await this.locate()
    if (!profile) failWith('profile_not_found', '无法定位 Profile 目录')
    const snapshot = await readKitEntries(profile.patchFile)
    const loader = (this.ctx as unknown as { get(name: 'loader'): Loader }).get('loader')
    const entries = new Map(Array.from(loader.entries(), (e) => [e.id, e] as const))
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
      typesafeKey: await describeTypesafeKey({ ...this.keyStore, keychainService: jevConfig.keychainService, keychainAccount: jevConfig.keychainAccount }),
      keyTargets: (this.keyStore.platform ?? process.platform) === 'darwin' ? ['keychain', 'credentials'] : ['credentials'],
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

  async setSecret(target: KeyTarget, value: string): Promise<{ configured: boolean; source?: KeySource }> {
    await this.writable()
    await saveTypesafeKey(target, value, { ...this.keyStore, keychainService: SHARED_KEYCHAIN_SERVICE })
    return describeTypesafeKey({ ...this.keyStore, keychainService: SHARED_KEYCHAIN_SERVICE })
  }

  async clearSecret(target: KeyTarget): Promise<{ configured: boolean; source?: KeySource }> {
    await this.writable()
    await clearTypesafeKey(target, { ...this.keyStore, keychainService: SHARED_KEYCHAIN_SERVICE })
    return describeTypesafeKey({ ...this.keyStore, keychainService: SHARED_KEYCHAIN_SERVICE })
  }
}

for (const method of ['status', 'saveService', 'setSecret', 'clearSecret']) markRemote(AgentKitAdmin.prototype, method)
