export interface Post {
  slug: string
  title: string
  description: string
  date: string
}

export const POSTS: Post[] = [
  {
    slug: 'dingtalk-group-routing',
    title: '把钉钉群里的 @ 消息交给业务插件',
    description: '9 月 28 日的改动：群 ID 路由、未命中记录、群与个人发送目标，以及由业务插件决定项目和代码任务权限。',
    date: '2026-09-28',
  },
  {
    slug: 'local-laya',
    title: '用本地 Laya 替代 Jev：部署、切换与一次真实对比',
    description: '把 ctx.jev 切到本机部署的 Laya 只需要一行配置；但在一个真实的 16 类域名分类任务上，Jev 准确率 86.5%，Laya 为 0%。部署方式、切换步骤、实测数据，以及什么时候该用哪个。',
    date: '2026-09-25',
  },
  {
    slug: 'resident-agent-worker',
    title: '用 dsh 搭一个常驻 Agent Worker',
    description: '从一条 WebSocket 事件到一条钉钉告警：连接、委托、校验、推送四步，以及每一步为什么默认安全。',
    date: '2026-09-24',
  },
]
