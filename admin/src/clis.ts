/**
 * 通知渠道依赖的外部 CLI。`version` 是本包验证过输出格式的版本：`doctor` 的修复建议与 `setup`
 * 的安装都锁定到它，避免装上输出格式已变的新版本。
 */
export interface ChannelCli {
  /** 可执行文件名。 */
  bin: string
  /** npm 包名。 */
  package: string
  version: string
  title: string
  /** 装好之后要做的配置 / 登录。 */
  next: string
}

export const CHANNEL_CLIS = {
  dingtalk: { bin: 'dws', package: 'dingtalk-workspace-cli', version: '1.0.62', title: '钉钉 CLI（dws）', next: 'dws auth login' },
  feishu: { bin: 'lark-cli', package: '@larksuite/cli', version: '1.0.96', title: '飞书 CLI（lark-cli）', next: 'lark-cli config init（bot 身份）；user 身份再运行 lark-cli auth login' },
} as const satisfies Record<string, ChannelCli>

export type ChannelCliId = keyof typeof CHANNEL_CLIS

export function installArgs(cli: ChannelCli): string[] {
  return ['i', '-g', `${cli.package}@${cli.version}`]
}

export function installCommand(cli: ChannelCli): string {
  return `npm ${installArgs(cli).join(' ')}`
}
