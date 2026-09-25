# dsh-agent-kit

官网：https://byx-darwin.github.io/dsh-agent-kit/

构建常驻 Agent Worker 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件工具包：WebSocket 接入、钉钉 / 飞书推送与渠道无关的通知、Claude Code / Codex 任务委托、TypeSafe Jev（或本地 Laya）校验。

> **状态：已实现，待发布 `0.1.0`。** 接口以 [设计文档](docs/superpowers/specs/2026-09-23-dsh-agent-kit-design.md) 为准，首个版本发布前可能调整。

## 为什么需要它

很多系统都需要一个"常驻 Agent Worker"：

1. 通过 WebSocket 接收业务系统推送的事件；
2. 把告警类事件推送到钉钉群或飞书群；
3. 把需要语义判断的任务交给 Claude Code、Codex 等 Agent 处理；
4. 用 [TypeSafe Jev](https://docs.typesafe.ai/) 对 Agent 的结果做低成本校验，不通过时升级或转人工。

这四项能力与业务无关。`@mc/dsh-agent-kit` 把它们实现为一组 DeepSeek Harness（dsh）插件 Service，项目只需在自己的**业务包**里编写协议、路由、模板和流程。

## 两个包

| 包 | 目录 | 作用 |
|---|---|---|
| `@mc/dsh-agent-kit` | 仓库根目录 | 给业务包用的库：六个 Service 与测试工具。业务包只依赖它 |
| `@mc/dsh-agent-kit-admin` | [`admin/`](admin/README.md) | 可选的运维工具：`dsh-agent-kit doctor` / `setup` 命令行、dsh Web「设置 → Agent Kit」页、业务包设置入口的登记。见下文「运维工具（可选）」 |

不装 admin 包时，六个 Service 照常工作，配置直接写在 Profile 的 `cordis.patch.yml` 中。

## 功能

| Service | 作用 |
|---|---|
| `ctx.agentWs` | WebSocket 客户端（仅 `wss://`）：可刷新的鉴权请求头、心跳、指数退避重连、并发与背压控制；鉴权失败或指定关闭码时进入 `failed` 状态并可慢速重试 |
| `ctx.dingtalk` | 通过钉钉 `dws` CLI 发送文本 / Markdown 消息，支持 `user` / `bot` / `webhook` 身份、群聊 / 单聊 / 多群、@ 人、幂等键和 `dryRun`；可查询登录状态、发起设备流登录与退出 |
| `ctx.feishu` | 通过飞书官方 CLI `lark-cli` 发送文本 / Markdown 消息，支持 `bot` / `user` 身份、群聊 / 单聊 / 多群、@ 人、幂等键和 `dryRun`；可查询身份状态，`user` 身份可发起设备流登录与退出 |
| `ctx.notify` | 与渠道无关的通知：业务包只调用 `ctx.notify.send()`，同一时间发往一个渠道（钉钉或飞书）。渠道由配置决定，也可以在运行中用 `ctx.notify.use()` 切换，不需要改业务代码 |
| `ctx.agentTasks` | 调用 dsh 已注册的 subagent provider（如 `claude-code`、`codex`）执行一次性任务：默认只读权限（无法由本包强制的 provider 需运维声明权限上限）、每个任务独立目录、类型化的 JSON Schema 输出、并发与排队上限 |
| `ctx.jev` | 调用 TypeSafe Jev 或本地部署的 Laya（二选一），返回 Choice / Noul / Score 的类型化判断和概率 |

- 六个 Service 默认禁用，按需启用；未启用的 Service 不校验配置，也不影响其他 Service。
- 每个 Service 提供 `health()`；进入 `failed` 时触发 `agent-kit/service-failed` 事件，便于接入外部监控。
- 所有错误都是 `KitError`，带 `code` 与 `retryable`，调用方据此决定是否重试。

导入路径：根入口 `@mc/dsh-agent-kit` 导出全部 Service 类、配置、错误类型与工具函数；另有子路径 `@mc/dsh-agent-kit/ws`、`/dingtalk`、`/feishu`、`/notify`、`/agent-tasks`、`/jev`（各 Service 的插件模块，即 loader 行加载的模块）、`/secrets`（密钥引用解析）和 `/testing`（测试工具）。

## 架构

```text
┌──────────── dsh Profile（常驻进程）────────────┐
│  你的业务包（协议、路由、模板、流程）              │
│        │ inject                                 │
│        ▼                                        │
│  @mc/dsh-agent-kit（各 Service 单独启用）         │
│    agentWs · dingtalk · feishu · notify ·       │
│    agentTasks · jev                             │
│        │                                        │
│        ▼                                        │
│  dsh：subagent-claude-code / subagent-codex、    │
│       子进程管理、Session 持久化、Web 界面        │
│                                                 │
│  （可选）@mc/dsh-agent-kit-admin：设置页与 CLI    │
└─────────────────────────────────────────────────┘
```

`notify` 不直接连接外部系统：它在每次发送时查找当前渠道对应的 `dingtalk` 或 `feishu` 并转发，业务包因此只依赖 `notify`，渠道由运维决定。

本包不包含任何业务协议、事件类型、提示词或分类体系，也不保存可靠事件状态；投递可靠性由对端系统负责。一条上游连接只应部署一个实例。

## 环境要求

- Node.js `^22.19` 或 `>=24`
- [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) CLI `0.1.5-rc.3` 或 `0.1.7-alpha.2`（均为预发布版本，dsh 与 cordis 相关依赖需锁定到与所用 dsh 一致的版本；以下示例以 `0.1.5-rc.3` 为准，使用 0.1.7 时把版本号一并替换）
- 使用 `ctx.dingtalk`：已安装并登录 `dws`（已验证 `dingtalk-workspace-cli@1.0.62`）；服务器环境推荐 `bot` 身份
- 使用 `ctx.feishu`：已安装飞书官方 CLI `lark-cli`（npm 包 `@larksuite/cli`，已验证 `1.0.96`），并用 `lark-cli config init` 配好飞书应用的 App ID / App Secret；服务器环境推荐 `bot` 身份，`user` 身份还需要登录（`lark-cli auth login --scope "im:message.send_as_user im:message"`，或由业务包调用 `ctx.feishu.login()`）
- 使用 `ctx.notify`：同时启用它要用到的渠道（`ctx.dingtalk` 或 `ctx.feishu`）
- 本包运行时不会安装上述 CLI；可以手动安装，或用 admin 包的 `setup` 在你确认后安装（见「运维工具（可选）」）
- 使用 `ctx.agentTasks`：安装 `@deepseek-ai/dsh-subagent-claude-code` 和/或 `@deepseek-ai/dsh-subagent-codex`（`ctx.subagents` 与子进程服务由 dsh 的 base bundle 提供），并完成 Claude Code / Codex 的原生登录（provider 会剔除名字含 KEY / TOKEN / SECRET / PASSWORD 的环境变量，依赖这类变量鉴权时需在 provider 的 Config `env` 中显式给出）
- 使用 `ctx.jev`：安装 `@typesafe-ai/sdk`，并设置环境变量 `TYPESAFE_API_KEY`；macOS 上也可以用 `keychainService` 从钥匙串读取，推荐与 gitflow-cli 等工具共享的服务名 `ai.typesafe.api-key`（保存：`security add-generic-password -a "$USER" -s ai.typesafe.api-key -U -w`）。改用本地 Laya 时配置 `provider: laya` 与 `baseURL`，不需要 TypeSafe Key
- 生产部署：Profile 进程由 systemd、pm2 等进程守护托管

## 安装

```sh
npm i -g @deepseek-ai/dsh@0.1.5-rc.3

# 基于 web 模板创建一个常驻 Profile
dsh --profile my-agent --from-default-profile web

# 安装本包、Agent provider 和你的业务包
# subagent 包必须显式指定版本：其 latest 标签目前指向 0.0.1-rc.1，与 dsh 不匹配
dsh plugin --profile my-agent add @mc/dsh-agent-kit \
  @deepseek-ai/dsh-subagent-claude-code@0.1.5-rc.3 \
  @deepseek-ai/dsh-subagent-codex@0.1.5-rc.3
dsh plugin --profile my-agent add ./my-business-plugin-0.1.0.tgz

# 可选：运维工具（doctor / setup 命令行与 Web 设置页）
dsh plugin --profile my-agent add @mc/dsh-agent-kit-admin

# 在 Profile 的 cordis.patch.yml 中启用需要的 Service（见下文「配置」）

dsh --profile my-agent --dump-config   # 检查各层是否生效
dsh --profile my-agent --no-open
```

## 编写业务包

业务包把本包声明为 peer 依赖，保证一个 Profile 中只加载一份实例：

```jsonc
{
  "name": "@your-org/dsh-agent-your-project",
  "type": "module",
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@mc/dsh-agent-kit": "^0.1.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@mc/dsh-agent-kit": "^0.1.0"
  },
  "dsh": { "bundle": { "patch": "./patch.yml" } }
}
```

`@deepseek-ai/cordis` 的版本与目标 dsh 依赖的版本保持一致（dsh `0.1.5-rc.3` 对应 `4.0.2`，`0.1.7-alpha.2` 对应 `4.0.4`）。开发期可以用 `link:` 指向本包的本地 checkout。

插件示例（发通知推荐用 `ctx.notify`：业务包不关心发到钉钉还是飞书，运维可以随时切换渠道，不需要改业务代码）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { choice, isKitError, noul, untrusted } from '@mc/dsh-agent-kit'

export const name = 'my-agent'
export const inject = ['agentWs', 'notify', 'agentTasks', 'jev']

export function apply(ctx: Context, config: Config) {
  const conn = ctx.agentWs.connect<Frame>({
    url: config.url,
    headers: async () => ({ 'X-Token': await getToken() }), // 每次（重）连接前调用
    parse: parseFrame,                                       // 把 JsonValue 转成业务类型，抛错则丢弃该帧
    concurrency: 2,
    onMessage: async (frame, { signal }) => {
      if (frame.type === 'alert') {
        // 发往哪个渠道由 agent-kit-notify 的 channel 决定（或运行中的 ctx.notify.use()）
        await ctx.notify.send({
          title: frame.title,
          markdown: renderAlert(frame),
          idempotencyKey: frame.id,
          traceId: frame.id,
        })
        return
      }

      const draft = await ctx.agentTasks.run<Result>({
        provider: 'claude-code',
        title: `classify ${frame.id}`,
        // 来自 WebSocket 的数据是不可信的，用 untrusted() 包裹，声明它不是指令
        prompt: [CLASSIFY_INSTRUCTIONS, untrusted('event', frame.input)],
        outputSchema: ResultSchema, // JSONSchemaType<Result>，draft.output 的类型为 Result
        signal,
        traceId: frame.id,
      })

      // Agent 输出同样不可信：触发副作用前按业务白名单校验
      if (!CATEGORIES_ALLOWLIST.has(draft.output.category)) throw new Error('unexpected category')

      const { answers } = await ctx.jev.judge({
        state: { input: frame.input, candidate: draft.output },
        questions: {
          wrong: noul('候选结果与输入证据不符', { true: '不符', false: '相符' }),
          pick: choice('输入最符合哪个类别', CATEGORIES),
        },
        signal,
        traceId: frame.id,
      })

      // noul 为回答"是"的概率；choice 带 confidence 与各选项概率
      await conn.send({ id: frame.id, result: draft.output, verified: answers.wrong.noul < 0.7 })
    },
    onError: (err, frame) => {
      if (isKitError(err) && err.retryable) {
        // 例如：记录下来，交给对端系统重投
      }
    },
  })
}
```

### 通知：`ctx.notify`

`ctx.notify` 同一时间只发往一个渠道。`send()` 返回 `{ channel, results }`，`channel` 是实际发往的渠道，`results` 是该渠道的逐目标结果（多群时部分失败体现在这里，不抛错）。当前渠道的行没有运行（未启用或启动失败）时抛出 `NotifyError`（`code: channel_unavailable`）；渠道自己发送失败时抛出渠道的错误，例如 `FeishuSendError`、`DingtalkSendError`，`code` 与 `retryable` 照常可用。不会自动改发另一个渠道。

需要按渠道指定目标或 @ 人时，两个渠道各给一项，发送时只用当前渠道那一项：

```ts
await ctx.notify.send({
  title: '需要人工复核',
  markdown: body,
  targets: { dingtalk: { chatId: 'cidxxxx' }, feishu: { chatId: 'oc_xxxx' } }, // 缺省用该渠道的 defaultTarget
  at: { feishu: { userIds: ['ou_xxxx'] } },                                    // 两个渠道的用户 id 体系不同
  idempotencyKey: frame.id,
})
```

切换渠道有两种方式，都不会重新加载 notify，也不会重新加载只 inject `notify` 的业务插件：

- **改配置**：修改 `agent-kit-notify` 的 `channel`（手动编辑 `cordis.patch.yml`，或用 admin 包的设置页 / `setup`）。notify 在自己的 `internal/update` 钩子里原地换上新值，拦截了 cordis 默认的插件重启。
- **运行中切换**：`ctx.notify.use('feishu')` 立即生效，只改内存中的选择；dsh 重启后回到配置值，期间配置被修改时以新配置为准（覆盖 `use()`）。要长期切换请改配置。`ctx.notify.channel` 返回当前生效的渠道；传入未知渠道时抛出 `NotifyError`（`code: invalid_channel`）。

notify 不 inject 钉钉与飞书，而是在发送时查找它们，所以启用、停用渠道行也不会重新加载 notify。

`ctx.notify.status()` 返回当前渠道与两个渠道的实时登录状态：

```ts
const s = await ctx.notify.status()
// {
//   channel: 'feishu',
//   source: 'runtime',                      // 'config'：来自配置；'runtime'：被 use() 切换过
//   channels: {
//     feishu: { channel: 'feishu', running: true, identity: 'user', online: true, account: '张三', detail: '…', checkedAt: 1758… },
//     dingtalk: { channel: 'dingtalk', running: false, detail: 'agent-kit-dingtalk is not running' },
//   },
// }
```

### 渠道登录状态与登录

`ctx.dingtalk` 与 `ctx.feishu` 都提供 `status()`、`login()`、`logout()`；`ctx.notify.login(channel?)` / `logout(channel?)` 转给当前渠道（或指定的渠道）。

- `status(): Promise<ChannelStatus>`：通过 CLI 实时检查，返回 `{ channel, identity, online, account?, detail, checkedAt }`。`dryRun` 时只报告，不改变 `health()`。
- `login({ signal? }): Promise<LoginSession>`：设备流登录，拿到授权链接就返回 `{ channel, verificationUrl, userCode?, expiresAt, completed, cancel() }`。链接怎么交给要登录的人（发到运维群、显示在业务包自己的页面……）由业务包决定。对方在浏览器里授权后 `completed` 以新的状态 resolve；链接过期（15 分钟）、被拒绝或调用 `cancel()` 时同样 resolve，`online` 为 `false`。登录进行中再次调用 `login()` 返回同一个会话。
- `logout(): Promise<ChannelStatus>`：退出登录，返回退出后的状态。

```ts
export const inject = ['notify']

const st = await ctx.notify.status()
const cur = st.channels[st.channel]                  // running 为 false 时没有 online 字段
if (cur.running && !cur.online) {
  const s = await ctx.notify.login()                 // 当前渠道的设备流登录
  await postToOps(`请在 15 分钟内打开链接完成登录：${s.verificationUrl}`) // 由业务包决定怎么交付链接
  const after = await s.completed                    // 授权完成，或过期 / 拒绝 / cancel()
  if (!after.online) ctx.logger('my-agent').warn('login not completed: %s', after.detail)
}
```

| 渠道 | 身份 | `login()` | `logout()` |
|---|---|---|---|
| 钉钉 | `user` / `bot` | `dws auth login --device --no-browser` | `dws auth logout` |
| 钉钉 | `webhook` | 抛出 `unsupported`（无需登录，`status()` 总是 `online`） | 抛出 `unsupported` |
| 飞书 | `user` | `lark-cli auth login --scope=im:message.send_as_user im:message --no-wait --json`，随后在后台运行 `--device-code=<code>` 等待授权 | `lark-cli auth logout` |
| 飞书 | `bot` | 抛出 `unsupported`（bot 使用 `lark-cli config init` 配置的应用凭据，没有用户登录） | 抛出 `unsupported` |

> **注意**：`dws` 的登录态是本机共享的（属于运行 Profile 的系统用户），同一用户下使用 dws 的其他程序也会看到登录与退出的结果。钉钉 `logout()` 只退出当前账号（`dws auth logout --profile=<corpId>:<userId>`），不用 dws 默认的「退出全部账号」；取不到当前账号时不做任何事。

登录相关的错误码：`unsupported`（该身份没有登录）、`login_failed`（CLI 在给出授权链接之前就失败了），都在 `DingtalkSendError` / `FeishuSendError` 上。相关类型 `ChannelName`、`ChannelStatus`、`LoginSession`、`ChannelNotRunning`、`NotifyStatus` 与常量 `DEFAULT_LOGIN_TTL_MS` 从根入口导出。

### 直接使用某个渠道

需要某个渠道特有的能力（例如钉钉的 `openDingtalkId` 目标、webhook 身份）时，直接 inject 对应的 Service，用法不变：

```ts
export const inject = ['dingtalk']            // 或 ['feishu']

await ctx.dingtalk.send({ title: frame.title, markdown: renderAlert(frame), idempotencyKey: frame.id, traceId: frame.id })
await ctx.feishu.send({ title: frame.title, markdown: renderAlert(frame), target: { chatId: 'oc_xxxx' }, idempotencyKey: frame.id })
```

### 本地开发与测试

没有 `dws` / `lark-cli` 或 Agent 登录态时，可以把 dingtalk / feishu 设为 `dryRun: true`，并使用 `@mc/dsh-agent-kit/testing` 导出的工具开发与测试：

```ts
import { createFakeDws, createFakeLark, createJevMock, FakeSubagentProvider, FakeSubagentRuntime, startTestWsServer } from '@mc/dsh-agent-kit/testing'

const server = await startTestWsServer()          // ws://127.0.0.1:<port>，可模拟 401、关闭 pong
const dws = createFakeDws({ send: [{ mode: 'partial', failTargets: ['cidB'] }] })
process.env.DWS_CONFIG_DIR = dws.dir              // 假 dws 从这里读取场景；dingtalk 配置 dwsPath: dws.path
const lark = createFakeLark({ auth: { bot: true }, send: [{ mode: 'success' }] })
Object.assign(process.env, lark.env)               // 假 lark-cli 从 LARKSUITE_CLI_CONFIG_DIR 读取场景；feishu 配置 larkPath: lark.path
lark.calls()                                       // 每次调用的参数与收到的环境变量名，可断言白名单
const restoreJev = createJevMock().install()      // jev 不发网络请求
const provider = new FakeSubagentProvider({ name: 'claude-code', handler: () => '```json\n{"category":"a"}\n```' })
await ctx.plugin(FakeSubagentRuntime, { providers: [provider] }) // 或注册到真实 ctx.subagents
```

完整接口、错误码、配置默认值和卸载语义见 [设计文档](docs/superpowers/specs/2026-09-23-dsh-agent-kit-design.md)。

## 配置

各 Service 的可变参数都是 cordis.yml 中经过校验的配置字段，均有默认值与取值范围。本包的 bundle 以禁用状态注册六个 loader 行（`agent-kit-ws`、`agent-kit-dingtalk`、`agent-kit-feishu`、`agent-kit-notify`、`agent-kit-agent-tasks`、`agent-kit-jev`），在 Profile 的 `cordis.patch.yml` 中按 id 启用并给出配置：

```yaml
- id: agent-kit-ws
  disabled: false
- id: agent-kit-dingtalk
  disabled: false
  config:
    identity: bot
    robotCode: dingxxxx
    defaultTarget: { chatId: cidxxxx }
- id: agent-kit-feishu
  disabled: false                              # 需要 lark-cli，并已运行 lark-cli config init
  config:
    identity: bot
    defaultTarget: { chatId: oc_xxxx }
- id: agent-kit-notify
  disabled: false
  config:
    channel: feishu                            # dingtalk 或 feishu；对应的渠道行需要启用
- id: agent-kit-agent-tasks
  disabled: false
  config:
    workspaceDir: /var/lib/my-agent/tasks
    declaredPermissions:
      claude-code: read-only                   # claude-code 默认 permissionMode: dontAsk，不能执行命令或写文件
- id: agent-kit-jev
  disabled: false                              # 需要 @typesafe-ai/sdk 与环境变量 TYPESAFE_API_KEY
  config:
    keychainService: [ai.typesafe.api-key, gitflow-cli-typesafe]  # 可选：macOS 上未设置环境变量时按顺序从钥匙串读取；旧名仅用于迁移期
# 或改用本地部署的 Laya（与上面二选一）：
#   config:
#     provider: laya
#     baseURL: http://127.0.0.1:8000             # laya-serve 的地址
#     apiKeyRef: LAYA_API_KEY                    # 可选：Laya 开启鉴权时从该环境变量 / dsh 凭据读取 Key
```

按 id 修改 `config` 时整段替换；未给出的字段使用默认值。

| Service | 主要字段 |
|---|---|
| `agentWs` | `pingIntervalMs`、`readTimeoutMs`、`reconnect.initialDelayMs`、`reconnect.maxDelayMs`、`reconnect.jitter`、`stableResetMs`、`fatalRetryDelayMs`、`maxPayloadBytes`、`maxPendingMessages` |
| `dingtalk` | `identity`（必填）、`defaultTarget`、`robotCode`、`webhookTokenEnv`、`dwsPath`、`timeoutMs`、`killGraceMs`、`retry.maxAttempts`、`preflightIntervalMs`、`dryRun` |
| `feishu` | `identity`（必填，`bot` / `user`）、`defaultTarget`、`profile`、`larkPath`、`timeoutMs`、`killGraceMs`、`retry.maxAttempts`、`preflightIntervalMs`、`dryRun` |
| `notify` | `channel`（必填，`dingtalk` / `feishu`） |
| `agentTasks` | `workspaceDir`（必填）、`defaultTimeoutMs`、`maxConcurrency`、`maxQueueSize`、`keepWorkdir`、`declaredPermissions`、`toolAllowlist` |
| `jev` | `provider`、`baseURL`、`apiKeyRef`、`model`、`timeoutMs`、`keychainService`、`keychainAccount` |

- `agentTasks.declaredPermissions`：claude-code、codex 不支持按任务过滤工具，权限由 provider 实例自己的配置决定。运维在这里声明其实际权限上限（`read-only` / `workspace-write`）；未声明或上限高于任务请求的档位时，任务以 `unsupported_permissions` 失败。
- `dingtalk` 的 `webhook` 身份只能把 token 作为命令行参数传给 dws（会出现在 `ps` 中），不推荐使用。
- `feishu.defaultTarget` 可以是 `{ chatId: 'oc_…' }`（群）、`{ userId: 'ou_…' }`（用户 open_id，单聊）或 `{ chatIds: [...] }`（多个群，逐个发送，最多 100 个）；`feishu.profile` 对应 `lark-cli --profile`。
- `feishu` 只在给出 `idempotencyKey` 时自动重试；lark-cli 的幂等键最长 50 个字符，多目标时本包逐目标派生。
- `notify.channel` 指向的渠道行需要单独启用；未启用时发送报 `channel_unavailable`，admin 包的 `doctor` 检查 `agent-kit-notify.channel` 也会失败。
- `dingtalk.dwsPath` 必须指向可直接执行的文件（可执行二进制、`.exe` 或 `.js`）；不支持 Windows 的 `.cmd`/`.bat` 包装脚本（`feishu.larkPath` 同理），因为本包用 `spawn(..., { shell: false })` 不经过 shell 启动子进程，无法解释批处理语法。

TypeSafe Key（`TYPESAFE_API_KEY`）按以下优先级解析，三个平台的落盘位置不同：

| 来源 | 说明 |
|---|---|
| 环境变量 | 进程自身的 `TYPESAFE_API_KEY`，优先级最高，admin 包的 CLI/Web 均不会覆盖或清除它 |
| macOS 钥匙串 | 通过 `security` 命令读写，服务名默认 `ai.typesafe.api-key`（`keychainService` 可配置为数组做迁移期兼容）；仅 macOS 可用 |
| dsh 凭据文件 | `$DSH_HOME/.credentials.yaml`，由 `@deepseek-ai/dsh-credentials-local` 管理；Linux/其他平台的默认落盘位置，macOS 上作为钥匙串之外的第二选择 |

## 安全

- 密钥只从环境变量、macOS 钥匙串或 dsh 凭据文件读取，且不传给本包启动的子进程；钉钉凭据由 `dws` 自己的登录态管理，飞书的应用凭据与令牌由 `lark-cli` 自己的配置（`lark-cli config init`）与系统钥匙串管理，本包都不保存。
- 启动 `dws`、`lark-cli` 时不经过 shell，子进程只继承环境变量白名单。`lark-cli` 额外只放行运行所需的 `LARKSUITE_CLI_CONFIG_DIR`、`LARKSUITE_CLI_PROFILE`、`LARKSUITE_CLI_BRAND`、`LARKSUITE_CLI_CA_PATH`、`LARKSUITE_CLI_PROXY_ADDRESS`、`LARKSUITE_CLI_PROXY_ENABLE`，以及定位配置目录的 `XDG_CONFIG_HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`（见导出的 `LARK_ENV_WHITELIST`），`LARKSUITE_CLI_APP_SECRET`、`*_ACCESS_TOKEN` 等凭据类变量不会传入。
- 本包运行时从不安装任何 CLI；只有 admin 包的 `setup` 在你确认后才运行锁定版本的 `npm i -g`。
- 设备流登录的授权链接只交给调用 `login()` 的业务包，本包不会把它发到任何地方；把链接发给谁、发到哪个群由业务包决定，请只发给应当登录的人。
- 来自 WebSocket 的数据和 Agent 的输出都视为不可信：Agent 默认只读，在每个任务独立的空目录中运行；输出经过 Schema 与业务白名单校验后才应触发副作用。
- 只允许 `wss://`，不关闭证书校验，不跟随重定向。
- 日志和错误经过统一脱敏，不记录鉴权头、API Key、webhook token 和完整消息正文。
- dsh Web 界面中保存了完整的 prompt 与输出，只应绑定 `127.0.0.1` 或放在鉴权代理之后。
- 发送给 Claude Code、Codex、TypeSafe 的内容由业务包决定，请在业务包中做数据最小化。

## 运维工具（可选）：`@mc/dsh-agent-kit-admin`

[`@mc/dsh-agent-kit-admin`](admin/README.md) 提供配置引导与运维界面。它读写的仍然是 Profile 的 `cordis.patch.yml`，不装它不影响任何 Service。业务包不需要依赖它（只有用到下文的运行时登记时，Profile 里才必须有它）。

```sh
dsh plugin --profile my-agent add @mc/dsh-agent-kit @mc/dsh-agent-kit-admin
```

admin 包以常驻行 `agent-kit-admin` 注册（`ctx.agentKitAdmin`，即设置页调用的服务端接口），并让 dsh 发现它的前端模块；它不连接任何外部服务，也不影响基础包各行的启停。

### doctor 与 setup

admin 包自带 CLI `dsh-agent-kit`（随包安装到 `node_modules/.bin`），不需要启动 dsh：

```sh
# 交互式生成/修改 cordis.patch.yml（带 diff 预览，需确认后才写入）
npx @mc/dsh-agent-kit-admin setup --profile my-agent

# 体检：Node 版本、dws / lark-cli 的安装与登录态、Agent provider、TypeSafe Key 等是否满足已启用 Service 的要求
npx @mc/dsh-agent-kit-admin doctor --profile my-agent
```

`setup` 的流程：选择 Profile → 勾选要启用的 Service → **安装缺少的渠道 CLI** → 逐个配置 → 预览 diff 并确认写入 → 自动运行 `doctor`。

- 安装：如果启用了钉钉或飞书，而对应的 CLI 不在 `PATH` 中，`setup` 会把缺少的列成一个多选（默认全选，可以都装，也可以只装一个），再展示将要运行的命令请你确认一次：`npm i -g dingtalk-workspace-cli@1.0.62`、`npm i -g @larksuite/cli@1.0.96`。版本锁定到本包验证过输出格式的版本。跳过或安装失败时只打印手动安装命令，不影响后续配置。
- 飞书：选择身份；lark-cli 还没有应用配置时可以直接运行 `lark-cli config init`，`user` 身份未登录时可以直接运行 `lark-cli auth login`；默认目标可以按群名搜索（`lark-cli im +chat-search`），或直接输入群 chat_id（`oc_…`）/ 用户 open_id（`ou_…`）；可选 `dryRun`；写入后可以给默认目标发一条测试消息。
- 通知渠道：选择一个渠道（钉钉或飞书）；选中的渠道没有启用时会提示。之后重新运行 `setup` 可以原地修改渠道。

`setup` 只会修改 Profile 目录下的 `cordis.patch.yml`；`doctor` 只读，不修改任何文件，`--json` 输出机器可读的体检报告，可接入 CI。`doctor` 的 `agent-kit-notify.channel` 检查在所选渠道的行未启用时失败。两者都会在 `$DSH_HOME/profiles` 下扫描带有基础包（bundles 里含 `@mc/dsh-agent-kit`）的 Profile；只有一个候选时自动选中，有多个时需要 `--profile` 指定。

### 设置页

Profile 中装了 admin 包并启动后，dsh Web 界面的「设置」页会出现一张「Agent Kit」入口，六个 Service 各一张卡片（飞书卡片可以设置身份、默认目标、lark-cli 配置名与 `dryRun`；通知渠道卡片是一个单选，保存后业务包的 `ctx.notify` 立即改发新渠道，业务插件不重新加载），可以直接启用/关闭、编辑配置、查看健康状态和体检结果，效果与 CLI 等价（两者读写同一份 `cordis.patch.yml`）：

- 保存时按乐观并发（`version`）比较，若与他人（包括另开终端手改 `cordis.patch.yml`）冲突会提示「已被修改」并自动刷新为最新内容，需要重新确认后再保存。
- **只读闸门默认关闭（fail closed）**：只有 dsh Web 确认自己绑定在 `webServer.host === '127.0.0.1'` 时设置页才可写；未绑定回环地址（例如以 `--host 0.0.0.0` 之类的方式对外暴露）或压根没加载 `webServer` 服务时，设置页一律降级为只读，避免把配置写入接口暴露给公网。dsh CLI 自身也拒绝 `--host 0.0.0.0`（"it would expose remote code execution to the network"），二者是两道独立的防线。
- TypeSafe Key 只能写入、不能在页面或接口响应中读出；页面只显示「已配置（来源：环境变量/钥匙串（服务名）/dsh 凭据文件，均为本地化文案，非原始值）」或「未配置」。CLI 与 Web 保存 Key 时会提示当前平台可选的目标（`keychain` / `credentials`），行为一致。

### 把业务包的配置接入设置页与 doctor

业务包自己的 loader 行（连接地址、token 引用、通知目标、功能开关……）可以登记到 admin 包的设置页、`agentKitAdmin`、`doctor` 和密钥管理，运维在一个页面里配完整个 Profile，不需要再写第二个设置页。这些登记只在 Profile 装了 admin 包时生效。

推荐在 `package.json` 里声明**静态清单**：业务插件未启用、配置有误或启动失败时，卡片、表单和检查照样出现，`doctor` 也从这里发现业务行。

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./patch.yml" },
    "agentKit": { "entries": ["./lib/agent-kit-entry.js"] }
  }
}
```

清单模块必须无副作用（不要在顶层连接网络、读取环境），默认导出一个或一组条目。条目类型与 `defineEntry`（只做类型推断，原样返回参数）从 `@mc/dsh-agent-kit-admin/entry` 导入，业务包把 admin 包加到 `devDependencies` 即可：

```ts
// src/agent-kit-entry.ts
import { defineEntry } from '@mc/dsh-agent-kit-admin/entry'
import { Config } from './config.js' // Schemastery schema

export default defineEntry({
  id: 'my-agent',                         // cordis.patch.yml 中的行 id
  label: '我的业务',
  schema: Config,                         // 先用 schema 校验并补默认值
  validate: (c) => [                      // schema 表达不了的约束；path 相对本行 config
    ...(c.url.startsWith('wss://') ? [] : [{ path: 'url', message: '必须是 wss://' }]),
    ...(c.batchSize > c.maxInFlight ? [{ path: 'batchSize', message: '不能大于 maxInFlight' }] : []),
  ],
  fields: [
    { path: 'url', label: '上游地址' },
    { path: 'alertTarget.chatId', label: '告警群 ID' },
    { path: 'batchSize', label: '批大小', kind: 'number' },
    { path: 'mode', label: '模式', kind: 'select', options: ['shadow', 'live'] },
  ],
  // ref 可以来自配置：保存新的 tokenEnv 后，设置页和 setSecret 跟随新名字
  secrets: [{ label: '上游 Token', refFrom: 'tokenEnv', ref: 'MY_AGENT_TOKEN' }],
  service: 'myAgent',                     // 行运行中时，从 ctx.myAgent.health() 读取状态
  dependsOn: ['agent-kit-ws', 'agent-kit-notify'], // 停用这些行前，设置页会提示连带停止本行
  checks: async (ctx) => [
    { id: 'upstream', title: '上游可达', status: 'pass', detail: 'ok' },
  ],
})
```

也可以在插件里运行时登记（插件需 inject `agentKitAdmin`，因此 Profile 中必须装有 admin 包；卸载时自动注销；同 id 时覆盖清单，例如补上 `health`）：

```ts
export const inject = ['agentWs', 'agentKitAdmin']
export function apply(ctx: Context) {
  ctx.agentKitAdmin.registerEntry({ ...entry, health: () => ({ status: 'ok', detail: `${conn.state}` }) })
}
```

- 保存业务行与基础包的行共用同一套版本冲突检测；只替换被保存的那一行，其他行的文本逐字节不变。
- 校验失败时返回 `invalid_config` 和按字段的错误（`path` 为 `<行 id>.<字段>`），与基础包自己的行一致。
- 业务行的密钥只写入 dsh 凭据文件（`$DSH_HOME/.credentials.yaml`），插件运行时用 `ctx.credentials.resolve(ref)` 或基础包导出的 `resolveSecretRef(ref)`（`@mc/dsh-agent-kit` 或 `@mc/dsh-agent-kit/secrets`）读取（环境变量优先）。
- 业务行被停用时照常检查：配置错误记为警告，不让 `doctor` 因一个未启用的行失败；启用后记为失败。

## 路线图

- [x] 完成设计文档中的「实施前需核实」项
- [x] 四个 Service 的首个实现与测试
- [x] 飞书推送与渠道无关的通知（`ctx.feishu`、`ctx.notify`）
- [x] 渠道登录状态与设备流登录（`status()` / `login()` / `logout()`）
- [x] 运维工具拆分为可选的 `@mc/dsh-agent-kit-admin`
- [ ] 发布 `0.1.0` 到 npm
- [ ] 通用的「Agent 执行 → Jev 校验 → 升级」级联 helper
- [ ] 钉钉卡片消息

## 开发

```sh
npm install
npm run typecheck
npm test                 # 单元 + 集成测试（集成测试会先构建 lib/，并在真实 dsh loader 中加载 patch.yml）
npm run test:coverage
npm run test:e2e         # 端到端冒烟，按环境变量启用，见 tests/e2e/smoke.test.ts
```

admin 包在 `admin/` 目录下，有自己的 `npm install`、`npm run typecheck`、`npm test`。

## 许可证

[MIT](LICENSE)
