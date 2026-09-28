// 五个 Service 的展示元数据，顺序与 patch.yml 中的 loader 行一致。配置项表由 config-tables.ts 从源码 schema 生成；
// 这里只补充 schema 里没有的内容：编号、摘要、跨字段约束、错误码，以及缺少 description 的字段说明。

export type ServiceId = 'agentWs' | 'dingtalk' | 'notify' | 'agentTasks' | 'jev'

export interface ServiceError {
  code: string
  /** 是否可重试：「是」「否」「视情况」。 */
  retryable: '是' | '否' | '视情况'
  meaning: string
}

export type ServiceNumeral = '壹' | '贰' | '叁' | '肆' | '伍'

export interface ServiceMeta {
  id: ServiceId
  numeral: ServiceNumeral
  verb: string
  name: string
  /** 在 cordis Context 上的属性名。 */
  context: string
  /** 文档页路径段：/docs/<slug>。 */
  slug: string
  summary: string
  /** Profile 的 cordis.patch.yml 中对应的 loader 行 id。 */
  kitId: string
  notes: string[]
  errors: ServiceError[]
  /** schema 字段缺少 description 时的说明，键为字段路径。 */
  descriptions: Record<string, string>
}

const INVALID_CONFIG: ServiceError = { code: 'invalid_config', retryable: '否', meaning: '配置或环境变量非法，Service 启动失败。' }

export const SERVICES: ServiceMeta[] = [
  {
    id: 'agentWs',
    numeral: '壹',
    verb: '连接',
    name: 'WebSocket 客户端',
    context: 'ctx.agentWs',
    slug: 'agent-ws',
    summary: '仅 wss:// 的 WebSocket 客户端：可刷新的鉴权请求头、心跳、指数退避重连、并发与背压控制；鉴权失败或指定关闭码时进入 failed 状态并可慢速重试。',
    kitId: 'agent-kit-ws',
    notes: [
      'readTimeoutMs 必须 ≥ 2 × pingIntervalMs。',
      'reconnect.maxDelayMs 必须 ≥ reconnect.initialDelayMs。',
      'fatalRetryDelayMs 为 0（fatal 后不再重试）或 ≥ 10000。',
      'connect() 参数中的 fatalCloseCodes（默认空）与 concurrency（默认 1）由业务包按对端约定给出。',
    ],
    errors: [
      { code: 'not_open', retryable: '是', meaning: '连接未处于 open 状态时调用 send()；不做内部排队。' },
      { code: 'closed', retryable: '否', meaning: '连接已关闭（主动 close 或调用方插件卸载）。' },
      { code: 'aborted', retryable: '否', meaning: 'whenOpen() 的 signal 被中止。' },
      { code: 'invalid_url', retryable: '否', meaning: 'URL 非法，或使用了非本机地址的 ws://。' },
      { code: 'invalid_options', retryable: '否', meaning: 'connect() 参数非法，或 send() 的帧无法序列化为 JSON。' },
      INVALID_CONFIG,
    ],
    descriptions: {
      'reconnect.initialDelayMs': '首次重连前的等待时间，之后按指数增长。',
      'reconnect.maxDelayMs': '重连等待时间的上限。',
      'reconnect.jitter': '抖动比例：每次等待时间向下随机减少最多该比例。',
      maxPayloadBytes: '单帧最大字节数，超过时断开并按普通断线重连。',
      maxPendingMessages: '待处理消息超过该值时暂停读取 socket（背压）。',
    },
  },
  {
    id: 'dingtalk',
    numeral: '贰',
    verb: '渠道',
    name: '钉钉推送',
    context: 'ctx.dingtalk',
    slug: 'dingtalk',
    summary: '通过钉钉 dws CLI 的 user 身份发送消息；统一监听群内 @ 消息，并按群 ID 与内容规则下发给业务插件。',
    kitId: 'agent-kit-dingtalk',
    notes: [
      '自动重试只在给出 idempotencyKey 时进行，避免重复发送。',
      'status() 实时检查登录态；login() 发起设备流登录，拿到授权链接即返回，由业务包决定怎么交给要登录的人；logout() 退出登录。',
      'dws 的登录态是本机共享的，同一系统用户下的其他 dws 程序也会看到登录与退出；logout() 只退出当前账号（--profile=<corpId>:<userId>）。',
      'onMessage() 按 conversationId、match 和 priority 注册路由；每条 @ 消息只交给首个命中的业务插件，路由随插件卸载自动注销。',
    ],
    errors: [
      { code: 'timeout', retryable: '是', meaning: 'dws 超时，子进程按「先 SIGTERM、宽限后 SIGKILL」回收。' },
      { code: 'exit_nonzero', retryable: '视情况', meaning: 'dws 非零退出；按 dws 错误类别（network / timeout / rate_limit / server / unavailable）判断是否可重试。' },
      { code: 'bad_output', retryable: '否', meaning: 'dws 输出无法解析。' },
      { code: 'invalid_target', retryable: '否', meaning: '目标、@ 列表或幂等键格式非法。' },
      { code: 'send_failed', retryable: '否', meaning: 'dws 报告发送失败。' },
      { code: 'aborted', retryable: '否', meaning: '调用方 signal 中止或 Service 卸载。' },
      { code: 'spawn_failed', retryable: '否', meaning: '无法启动 dws 子进程。' },
      { code: 'login_failed', retryable: '否', meaning: 'dws auth login 在给出授权链接之前就结束了。' },
      INVALID_CONFIG,
    ],
    descriptions: {
      timeoutMs: '单次 dws 调用的超时时间。',
      killGraceMs: '超时或卸载时，SIGTERM 之后等待多久再发 SIGKILL。',
      'retry.maxAttempts': '给出幂等键时，可重试失败的最多重试次数。',
      dryRun: '附加 --dry-run，只解析参数、不真实发送；同时跳过登录态检查。',
    },
  },
  {
    id: 'notify',
    numeral: '叁',
    verb: '通知',
    name: '通知渠道',
    context: 'ctx.notify',
    slug: 'notify',
    summary: '钉钉通知入口：业务包通过 ctx.notify.send() 发送，无需直接依赖钉钉 Service。',
    kitId: 'agent-kit-notify',
    notes: [
      'channel 固定为 dingtalk；钉钉行（agent-kit-dingtalk）需要启用，未运行时 send() 抛出 channel_unavailable。',
      '本 Service 不 inject 钉钉，而是在发送时查找：启用、停用渠道行也不会重新加载 notify。',
      'status() 返回当前渠道、来源（config / runtime）与钉钉的实时登录状态；login(channel?) / logout(channel?) 转给当前（或指定的）渠道。',
    ],
    errors: [
      { code: 'channel_unavailable', retryable: '否', meaning: '当前渠道（或 login() / logout() 指定的渠道）对应的行未运行（未启用或启动失败）；details.channel 为渠道名。' },
      { code: 'invalid_channel', retryable: '否', meaning: 'use() 传入了 dingtalk 以外的渠道。' },
      INVALID_CONFIG,
    ],
    descriptions: {},
  },
  {
    id: 'agentTasks',
    numeral: '肆',
    verb: '委托',
    name: 'Agent 任务',
    context: 'ctx.agentTasks',
    slug: 'agent-tasks',
    summary: '调用 dsh 已注册的 subagent provider（如 claude-code、codex）执行一次性任务：默认只读权限、每个任务独立目录、类型化的 JSON Schema 输出、并发与排队上限。',
    kitId: 'agent-kit-agent-tasks',
    notes: [
      'workspaceDir 必须是绝对路径，且不能是进程工作目录或其祖先。',
      '不支持工具过滤的 provider（claude-code、codex）必须在 declaredPermissions 中声明权限上限，否则任务以 unsupported_permissions 失败。',
      'claude-code 默认的 permissionMode: dontAsk 下不能执行命令或写文件，可声明为 read-only。',
    ],
    errors: [
      { code: 'provider_failed', retryable: '视情况', meaning: 'provider 未注册、委托出错或以 error / refusal / max-tokens 结束；限流可重试，鉴权失败不可重试。' },
      { code: 'timeout', retryable: '是', meaning: '任务超过 timeoutMs，委托被取消。' },
      { code: 'invalid_output', retryable: '否', meaning: '答案中取不到 JSON，或不符合 outputSchema。' },
      { code: 'aborted', retryable: '否', meaning: '调用方 signal 中止或 Service 卸载。' },
      { code: 'queue_full', retryable: '是', meaning: '排队数达到 maxQueueSize。' },
      { code: 'unsupported_permissions', retryable: '否', meaning: 'provider 无法保证请求的权限档位，且未声明足够严格的 declaredPermissions。' },
      INVALID_CONFIG,
    ],
    descriptions: {
      defaultTimeoutMs: 'run() 未指定 timeoutMs 时的单任务超时。',
      maxConcurrency: '同时运行的任务数上限，其余按 FIFO 排队。',
      maxQueueSize: '排队数上限，达到后新任务立即以 queue_full 失败。',
      keepWorkdir: '任务结束后保留 workspaceDir/<taskId>/ 目录，便于排查。',
      declaredPermissions: '不支持工具过滤的 provider 的权限上限（provider 名 → read-only | workspace-write）。',
      'toolAllowlist.read-only': '支持工具过滤的 provider 在 read-only 档位下可见的工具。',
      'toolAllowlist.workspace-write': '支持工具过滤的 provider 在 workspace-write 档位下可见的工具。',
    },
  },
  {
    id: 'jev',
    numeral: '伍',
    verb: '校验',
    name: 'Jev 判断',
    context: 'ctx.jev',
    slug: 'jev',
    summary: '调用 TypeSafe Jev 或本地部署的 Laya（二选一），返回 Choice / Noul / Score 的类型化判断和概率；一次 judge() 有严格的总时长。',
    kitId: 'agent-kit-jev',
    notes: [
      'provider 为 typesafe（默认）时，TypeSafe Key 读取顺序：环境变量 TYPESAFE_API_KEY → macOS 钥匙串（默认 ai.typesafe.api-key）→ dsh 凭据文件 $DSH_HOME/.credentials.yaml。',
      'provider 为 laya 时必须配置 baseURL；Key 按 apiKeyRef（默认 LAYA_API_KEY）从环境变量或 dsh 凭据读取，取不到则不带鉴权；不会读取或发送 TypeSafe Key。',
      'provider 为 laya 时按 contextTokens（默认 1024）检查截断：每道题的输入都占满窗口时记 warn 日志，结果带 truncated: true。',
      '两种 provider 都需要安装可选依赖 @typesafe-ai/sdk（Laya 与 Jev 接口相同，由 SDK 改 baseURL 发送）。',
    ],
    errors: [
      { code: 'unavailable', retryable: '是', meaning: '网络错误、5xx、408 或超过总时长。' },
      { code: 'rate_limited', retryable: '是', meaning: 'TypeSafe / Laya API 返回 429。' },
      { code: 'unauthorized', retryable: '否', meaning: 'TypeSafe / Laya API 返回 401 / 403；health() 同时置为 failed。' },
      { code: 'bad_request', retryable: '否', meaning: '其余 4xx 与参数错误。' },
      { code: 'aborted', retryable: '否', meaning: '调用方 signal 中止或 Service 卸载。' },
      INVALID_CONFIG,
    ],
    descriptions: {},
  },
]

export function service(id: ServiceId): ServiceMeta {
  return SERVICES.find((s) => s.id === id)!
}
