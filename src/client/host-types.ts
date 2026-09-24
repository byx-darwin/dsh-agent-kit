// dsh 前端上下文中本包用到的最小类型（官方类型包的已发布版本落后，这里按 0.1.5-rc.3 的实际结构声明）。
import type { ComponentType } from 'react'

export interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

export interface ClientContext {
  /**
   * cordis 把 `remote.$mount()` 挂载的每个命名空间注册成挂在根 ctx 上、名字里带点的服务
   * （如 `remote.agentKitAdmin`——见 `RemoteNamespaceService` 构造函数 `super(ctx, \`remote.${namespace}\`)`），
   * 而不是 `remote` 服务对象上的嵌套属性 `remote.agentKitAdmin`。
   *
   * 但取用时不能写成属性访问（`ctx.remote.agentKitAdmin` 或 `ctx['remote.agentKitAdmin']`）——cordis 的
   * Context 代理对属性读取有网关：只有在插件的静态 `inject` 里声明过的服务名才允许属性访问，否则直接抛
   * `cannot get property "..." without inject`（真实 dsh Web 走查中复现过）。而 `agentKitAdmin` 这个服务本来
   * 就要等我们自己 `$mount()` 之后才存在，不能提前声明在 `inject` 里（会导致 `apply()` 永远等不到它、
   * 形成死锁——同样在走查中复现过）。dsh-api-gateway 自身在同样场景下用的是 cordis 提供的、不会抛错的
   * `ctx.get(name)`（如 `this.ownerCtx.get(serviceKey)` / `ctx.get('connection')`），未挂载时返回
   * `undefined` 而不是抛异常。取 `agentKitAdmin` 必须同样用 `ctx.get('remote.agentKitAdmin')`。
   */
  get(name: string): unknown
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
  }
}
