export interface Post {
  slug: string
  title: string
  description: string
  date: string
}

export const POSTS: Post[] = [
  {
    slug: 'resident-agent-worker',
    title: '用 dsh 搭一个常驻 Agent Worker',
    description: '从一条 WebSocket 事件到一条钉钉告警：连接、委托、校验、推送四步，以及每一步为什么默认安全。',
    date: '2026-09-24',
  },
]
