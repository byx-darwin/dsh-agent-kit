# @mc/dsh-agent-kit-admin

[@mc/dsh-agent-kit](../README.md) 的可选运维工具。基础包只提供 Service（`ctx.agentWs`、`ctx.dingtalk`、`ctx.feishu`、`ctx.notify`、`ctx.agentTasks`、`ctx.jev`），业务包只依赖基础包；需要下面这些能力时，再把本包加入 Profile：

- `dsh-agent-kit doctor`：检查 Node 版本、渠道 CLI 与登录态、各 Service 的配置（包括通知渠道所选的渠道行是否已启用，`agent-kit-notify.channel`）等，`--json` 可接入 CI。
- `dsh-agent-kit setup`：交互式配置，缺少渠道 CLI 时列出并在确认后安装锁定版本（可以都装或只装一个），通知渠道选择一个（钉钉或飞书），Jev 判断可选 TypeSafe Jev 或本地 Laya（选 Laya 时填写服务地址，Key 可选且只存 dsh 凭据文件），写入前展示 `cordis.patch.yml` 的差异。
- dsh Web「设置 → Agent Kit」页：启停 Service、编辑配置（通知渠道是单选，保存后原地生效）、查看健康状态与检查结果、保存密钥。Jev 行选本地 Laya 时，TypeSafe Key 面板换成 Laya Key，体检改为检查 Laya 服务能否连接。
- 业务包登记设置入口（`dsh.agentKit.entries` 静态清单或 `ctx.agentKitAdmin.registerEntry()`），类型与 `defineEntry` 从 `@mc/dsh-agent-kit-admin/entry` 导入。运行时登记的插件要 inject `agentKitAdmin`，因此 Profile 中必须装有本包。

```bash
dsh plugin --profile my-agent add @mc/dsh-agent-kit @mc/dsh-agent-kit-admin
npx @mc/dsh-agent-kit-admin doctor --profile my-agent
npx @mc/dsh-agent-kit-admin setup --profile my-agent
```

本包以常驻行 `agent-kit-admin` 注册，不影响基础包各行的启停。详见根目录 README 的「运维工具（可选）」。
