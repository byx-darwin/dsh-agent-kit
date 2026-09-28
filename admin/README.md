# @baoyx/dsh-agent-kit-admin

[@baoyx/dsh-agent-kit](../README.md) 的可选运维工具。基础包提供 `ctx.agentWs`、`ctx.dingtalk`、`ctx.notify`、`ctx.agentTasks`、`ctx.jev`，业务包只依赖基础包；需要下面这些能力时，再把本包加入 Profile：

- `dsh-agent-kit doctor`：检查 Node 版本、渠道 CLI 与登录态、各 Service 的配置（包括通知渠道所选的渠道行是否已启用，`agent-kit-notify.channel`）等，`--json` 可接入 CI。
- `dsh-agent-kit setup`：交互式配置，缺少 dws 时在确认后安装锁定版本；钉钉固定使用 `user` 身份，通知固定发往钉钉；Jev 判断可选 TypeSafe Jev 或本地 Laya，写入前展示 `cordis.patch.yml` 的差异。
- dsh Web「设置 → Agent Kit」页：启停 Service、编辑配置、查看健康状态与检查结果、保存密钥。钉钉 `user` 可在卡片中扫码登录，二维码由页面本地生成；本机设置页还能查看未命中插件的群消息记录（群 ID、可查到的群名和正文预览）。Jev 行选本地 Laya 时，TypeSafe Key 面板换成 Laya Key。
- 业务包登记设置入口（`dsh.agentKit.entries` 静态清单或 `ctx.agentKitAdmin.registerEntry()`），类型与 `defineEntry` 从 `@baoyx/dsh-agent-kit-admin/entry` 导入。运行时登记的插件要 inject `agentKitAdmin`，因此 Profile 中必须装有本包。

业务包可把自己的收件人字段登记为 `{ path: 'forwardTo', label: '转发目标', kind: 'dingtalk-target' }`。本机设置页会按群名或姓名查询当前登录账号可见的候选，用户明确选中后，保存 `{ chatId }`、`{ userId }` 或 `{ openDingtalkId }` 到业务包配置；Agent Kit 不规定业务消息类别，也不会因查找而发送消息。

```bash
dsh plugin --profile my-agent add @baoyx/dsh-agent-kit @baoyx/dsh-agent-kit-admin
npx @baoyx/dsh-agent-kit-admin doctor --profile my-agent
npx @baoyx/dsh-agent-kit-admin setup --profile my-agent
```

本包以常驻行 `agent-kit-admin` 注册，不影响基础包各行的启停。详见根目录 README 的「运维工具（可选）」。
