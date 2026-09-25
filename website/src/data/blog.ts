export interface Post {
  slug: string
  title: string
  description: string
  date: string
}

export const POSTS: Post[] = [
  {
    slug: 'local-laya',
    title: '用本地 Laya 替代 Jev：部署、切换与实测',
    description: '把 ctx.jev 从 TypeSafe 云端切到本机部署的 Laya：两种部署方式、一行配置的切换、在 Apple M5 上的延迟实测，以及切换前必须做的对比。',
    date: '2026-09-25',
  },
  {
    slug: 'resident-agent-worker',
    title: '用 dsh 搭一个常驻 Agent Worker',
    description: '从一条 WebSocket 事件到一条钉钉告警：连接、委托、校验、推送四步，以及每一步为什么默认安全。',
    date: '2026-09-24',
  },
]
