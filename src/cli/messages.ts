export const USAGE = `用法：
  dsh-agent-kit doctor [--profile <名字>] [--json]   检查配置与运行环境
  dsh-agent-kit setup  [--profile <名字>]            交互式配置
`
export const ICON = { pass: '✓', warn: '!', fail: '✗', skip: '-' } as const

export function noProfile(home: string): string {
  return `在 ${home} 中没有安装 @mc/dsh-agent-kit 的 Profile；请用 --profile 指定，或先运行 dsh plugin --profile <名字> add @mc/dsh-agent-kit\n`
}

export function multipleProfiles(names: string[]): string {
  return `有多个 Profile 安装了本包，请用 --profile 指定：${names.join(', ')}\n`
}

export function unknownOption(message: string): string {
  return `${message}\n${USAGE}`
}

export function errorMessage(message: string): string {
  return `错误：${message}\n`
}

export const PROFILE_LABEL = 'Profile: '
export const COMMON_SCOPE_LABEL = '[通用]'

export function kitScopeLabel(scope: string): string {
  return `[${scope.replace('agent-kit-', '')}]`
}

export const FIX_PREFIX = '      → '
export const ALL_CHECKS_PASSED = '全部检查通过。'
export const SOME_CHECKS_FAILED = '存在未通过的检查项，请按提示修复。'

// ---- setup ----

export function profileMissingKit(name: string): string {
  return `Profile ${name} 未安装本包，请先运行：dsh plugin --profile ${name} add @mc/dsh-agent-kit\n`
}

export const SELECT_PROFILE_MESSAGE = '选择 Profile'

export const NOT_EMPTY = '不能为空'
export const NOT_ABSOLUTE_PATH = '必须是绝对路径'

export const SELECT_SERVICES_MESSAGE = '要启用哪些 Service？'
export const KIT_TITLES: Record<string, string> = {
  'agent-kit-ws': 'WebSocket 客户端',
  'agent-kit-dingtalk': '钉钉推送',
  'agent-kit-agent-tasks': 'Agent 任务',
  'agent-kit-jev': 'Jev 判断',
}

export const WRITE_CONFIRM_MESSAGE = '写入以上修改？'
export const WRITE_CANCELLED = '已取消，未修改任何文件。\n'
export const WRITE_DONE_LIVE = '已写入，dsh 会自动加载新配置。\n'
export const WRITE_DONE_RESTART = '已写入，重启 dsh 后生效。\n'
export const SEND_TEST_MESSAGE_CONFIRM = '给当前 dws 登录用户发送一条测试消息？'

// ---- dingtalk ----

export const DINGTALK_IDENTITY_MESSAGE = '钉钉发送身份'
export const DINGTALK_IDENTITY_CHOICES = [
  { value: 'bot' as const, name: 'bot（机器人，服务器环境推荐）' },
  { value: 'user' as const, name: 'user（当前 dws 登录账号）' },
  { value: 'webhook' as const, name: 'webhook（不推荐：token 会出现在进程参数中）' },
]
export const DINGTALK_ROBOT_CODE_MESSAGE = '机器人 robotCode'
export const DINGTALK_WEBHOOK_TOKEN_ENV_MESSAGE = '保存 webhook token 的环境变量名'
export const DINGTALK_WEBHOOK_TOKEN_ENV_DEFAULT = 'DINGTALK_WEBHOOK_TOKEN'
export const DINGTALK_DEFAULT_TARGET_MESSAGE = '默认发送目标（省略 target 时使用）'
export const DINGTALK_DEFAULT_TARGET_CHOICES = [
  { value: 'search' as const, name: '按群名搜索群' },
  { value: 'chatId' as const, name: '直接输入群 ID（openConversationId）' },
  { value: 'userId' as const, name: '单聊（userId）' },
  { value: 'none' as const, name: '不设置，每次调用时指定' },
]
export const DINGTALK_GROUP_QUERY_MESSAGE = '群名关键词'
export const DINGTALK_NO_GROUP_FOUND = '没有搜索到群，请直接输入群 ID。\n'
export const DINGTALK_CHAT_ID_MESSAGE = '群 ID（cid 开头）'
export const DINGTALK_USER_ID_MESSAGE = '接收者 userId'
export const DINGTALK_SELECT_GROUP_MESSAGE = '选择群'
export const DINGTALK_DRY_RUN_MESSAGE = '只演练不真实发送（dryRun）？'
export const DINGTALK_LOGIN_CONFIRM_MESSAGE = 'dws 尚未登录，现在运行 dws auth login？'
export const DINGTALK_LOGIN_FAILED = 'dws auth login 未成功，稍后可手动运行。\n'

export const DINGTALK_WEBHOOK_UNSUPPORTED_SELF_TEST = 'webhook 身份不支持单聊测试'
export const DINGTALK_CANNOT_RESOLVE_CURRENT_USER = '无法从 dws auth status 取得当前用户'
export const DINGTALK_TEST_MESSAGE_SENT = '测试消息已发送'
export function dingtalkTestMessageFailed(detail: string): string {
  return `发送失败：${detail}`
}
export function dingtalkTestMarkdown(now = new Date()): string {
  return `dsh-agent-kit setup 测试消息 ${now.toISOString()}`
}

// ---- agent-tasks ----

export const AGENT_TASKS_WORKSPACE_DIR_MESSAGE = '任务工作目录（绝对路径，专用目录）'
export function agentTasksPermissionMessage(provider: string): string {
  return `${provider} 实例的权限上限（不支持按任务过滤工具，需如实声明）`
}
export const AGENT_TASKS_PERMISSION_CHOICES = [
  { value: 'read-only' as const, name: 'read-only（claude-code 默认 dontAsk / codex 默认 never 时选这个）' },
  { value: 'workspace-write' as const, name: 'workspace-write' },
  { value: 'none' as const, name: '不使用该 provider' },
]

// ---- jev ----

export const JEV_MODEL_MESSAGE = 'Jev 模型'
export const JEV_MODEL_DEFAULT = 'jev-latest'
export function jevKeyFoundMessage(source: string): string {
  return `已找到 TypeSafe Key（来源：${source}），保留？`
}
export const JEV_KEY_PASSWORD_MESSAGE = 'TypeSafe API Key（输入不回显）'
export const JEV_KEY_TARGET_MESSAGE = '保存到'
export function jevKeySavedMessage(target: 'keychain' | 'credentials'): string {
  return `TypeSafe Key 已保存到 ${target === 'keychain' ? '钥匙串' : 'dsh 凭据文件'}。\n`
}
export function jevKeyTargetChoices(sharedKeychainService: string): { value: 'keychain' | 'credentials'; name: string }[] {
  return [
    { value: 'keychain', name: `macOS 钥匙串 ${sharedKeychainService}（可与 gitflow-cli 共享）` },
    { value: 'credentials', name: 'dsh 凭据文件 $DSH_HOME/.credentials.yaml' },
  ]
}
export const JEV_KEY_TARGET_CHOICE_CREDENTIALS_ONLY = { value: 'credentials' as const, name: 'dsh 凭据文件 $DSH_HOME/.credentials.yaml（仅本人可读）' }
