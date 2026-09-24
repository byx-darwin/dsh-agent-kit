# @mc/dsh-agent-kit-admin

[@mc/dsh-agent-kit](../README.md) 的可选运维工具。基础包只提供 Service（`ctx.agentWs`、`ctx.dingtalk`、`ctx.feishu`、`ctx.notify`、`ctx.agentTasks`、`ctx.jev`）；需要下面这些能力时，再把本包加入 Profile：

- `dsh-agent-kit doctor`：检查 Node 版本、渠道 CLI 与登录态、各 Service 的配置等，`--json` 可接入 CI。
- `dsh-agent-kit setup`：交互式配置，缺少渠道 CLI 时在确认后安装，写入前展示 `cordis.patch.yml` 的差异。
- dsh Web「设置 → Agent Kit」页：启停 Service、编辑配置、查看健康状态与检查结果、保存密钥。
- 业务包登记设置入口（`dsh.agentKit.entries` 静态清单或 `ctx.agentKitAdmin.registerEntry()`），类型与 `defineEntry` 从 `@mc/dsh-agent-kit-admin/entry` 导入。

```bash
dsh plugin --profile my-agent add @mc/dsh-agent-kit @mc/dsh-agent-kit-admin
npx @mc/dsh-agent-kit-admin doctor --profile my-agent
npx @mc/dsh-agent-kit-admin setup --profile my-agent
```

本包以常驻行 `agent-kit-admin` 注册，不影响基础包各行的启停。
