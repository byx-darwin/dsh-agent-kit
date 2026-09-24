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
