// 四个 Service 的展示元数据。配置项表由 config-tables.ts 从源码 schema 生成；
// 这里只补充 schema 里没有的内容：编号、摘要、跨字段约束、错误码，以及缺少 description 的字段说明。

export type ServiceId = 'agentWs' | 'dingtalk' | 'agentTasks' | 'jev'

export interface ServiceError {
  code: string
  /** 是否可重试：「是」「否」「视情况」。 */
  retryable: '是' | '否' | '视情况'
  meaning: string
}

export interface ServiceMeta {
  id: ServiceId
  numeral: '壹' | '贰' | '叁' | '肆'
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
    verb: '推送',
    name: '钉钉推送',
    context: 'ctx.dingtalk',
    slug: 'dingtalk',
    summary: '通过钉钉 dws CLI 发送文本 / Markdown 消息，支持 user / bot / webhook 身份、群聊 / 单聊 / 多群、@ 人、幂等键和 dryRun。',
    kitId: 'agent-kit-dingtalk',
    notes: [
      'bot 身份必须填写 robotCode；webhook 身份必须填写 webhookTokenEnv，且对应环境变量已设置。',
      'webhook 身份不能设置 defaultTarget：目标由 token 所在群决定。',
      'webhook 身份只能把 token 作为命令行参数传给 dws（会出现在 ps 中），不推荐使用。',
      '自动重试只在 user 身份且给出 idempotencyKey 时进行，避免重复发送。',
    ],
    errors: [
      { code: 'timeout', retryable: '是', meaning: 'dws 超时，子进程按「先 SIGTERM、宽限后 SIGKILL」回收。' },
      { code: 'exit_nonzero', retryable: '视情况', meaning: 'dws 非零退出；按 dws 错误类别（network / timeout / rate_limit / server / unavailable）判断是否可重试。' },
      { code: 'bad_output', retryable: '否', meaning: 'dws 输出无法解析。' },
      { code: 'invalid_target', retryable: '否', meaning: '目标、@ 列表或幂等键格式非法，或与身份不匹配。' },
      { code: 'send_failed', retryable: '否', meaning: 'dws 报告发送失败（批量发送时体现在逐目标结果中）。' },
      { code: 'aborted', retryable: '否', meaning: '调用方 signal 中止或 Service 卸载。' },
      { code: 'spawn_failed', retryable: '否', meaning: '无法启动 dws 子进程。' },
      INVALID_CONFIG,
    ],
    descriptions: {
      timeoutMs: '单次 dws 调用的超时时间。',
      killGraceMs: '超时或卸载时，SIGTERM 之后等待多久再发 SIGKILL。',
      'retry.maxAttempts': 'user 身份且给出幂等键时，可重试失败的最多重试次数。',
      dryRun: '附加 --dry-run，只解析参数、不真实发送；同时跳过登录态检查。',
    },
  },
  {
    id: 'agentTasks',
    numeral: '叁',
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
    numeral: '肆',
    verb: '校验',
    name: 'Jev 判断',
    context: 'ctx.jev',
    slug: 'jev',
    summary: '调用 TypeSafe Jev，返回 Choice / Noul / Score 的类型化判断和概率；一次 judge() 有严格的总时长。',
    kitId: 'agent-kit-jev',
    notes: [
      'TypeSafe Key 读取顺序：环境变量 TYPESAFE_API_KEY → macOS 钥匙串（默认 ai.typesafe.api-key）→ dsh 凭据文件 $DSH_HOME/.credentials.yaml。',
      '需要安装可选依赖 @typesafe-ai/sdk。',
    ],
    errors: [
      { code: 'unavailable', retryable: '是', meaning: '网络错误、5xx、408 或超过总时长。' },
      { code: 'rate_limited', retryable: '是', meaning: 'TypeSafe API 返回 429。' },
      { code: 'unauthorized', retryable: '否', meaning: 'TypeSafe API 返回 401 / 403；health() 同时置为 failed。' },
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
