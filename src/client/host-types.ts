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
