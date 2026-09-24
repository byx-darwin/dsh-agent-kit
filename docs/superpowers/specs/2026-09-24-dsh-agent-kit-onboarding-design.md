# @mc/dsh-agent-kit 配置引导设计：doctor、setup 与 Web 设置页

- 日期：2026-09-24
- 状态：待评审
- 前置文档：[2026-09-23-dsh-agent-kit-design.md](2026-09-23-dsh-agent-kit-design.md)

## 背景

`@mc/dsh-agent-kit` 打包后分发给第三方（主要是在自己电脑上开发调试的业务包开发者），他们目前只能通过 README 和规格文档了解需要设置什么：Profile 中启用哪些 Service、各自的配置、dws 登录、TypeSafe Key、subagent provider 与权限声明。配错时 Service 虽然会以明确的错误启动失败，但缺少事前引导。

本设计新增三种配置引导方式：

- `doctor`：命令行检查，列出缺什么、怎么修。
- `setup`：命令行交互式配置。
- Web 设置页：在 dsh Web 界面中查看状态、启用或禁用 Service、修改配置、保存密钥。

## 目标

- 第三方不读文档也能完成配置并确认可用。
- Linux、macOS、Windows 三平台都可用。
- 配置只有一个事实来源；命令行、Web 页与手动编辑的效果一致。
- 密钥不写入任何配置文件，Web 页只能写入不能读回。

## 非目标

- 不编辑 dsh 全局的 `$DSH_HOME/cordis.patch.yml`，只处理 Profile 级的 `cordis.patch.yml`。
- 不保存 dws 的登录凭据；只负责拉起 `dws auth login`。
- 不接入 dsh 自带的「插件配置」页与 `settings.yaml`（见「备选方案」）。
- 第一版命令行与 Web 页只提供中文，文案集中存放，便于以后增加英文。

## 关键决策

### 配置的事实来源：Profile 的 `cordis.patch.yml`

四个 Service 的启用状态与配置都保存在 Profile 的 `cordis.patch.yml` 中 id 为 `agent-kit-*` 的行里，例如：

```yaml
- id: agent-kit-dingtalk
  disabled: false
  config:
    identity: bot
    robotCode: dingxxxx
```

`setup` 与 Web 页都通过同一个 patch 文件编辑模块修改这些行。Profile 为 `patchReload: live`（web 模板与自定义 Profile 的默认值）时，dsh 监视该文件，变化后用新配置重启对应 Service；为 `startup` 时提示需要重启 dsh。

备选方案与放弃原因：

- 配置放 dsh 设置服务（`$DSH_HOME/settings.yaml`）、启用状态放 patch 文件：形成两个来源，patch 中的配置是底层、`settings.yaml` 覆盖其上，最终值来源难以理解；四个 Service 都需支持运行中热更新配置；不启动 dsh 的 `setup` 难以安全地写 `settings.yaml`；且 dsh 的设置机制不能切换 `disabled`，禁用的 Service 也不会注册配置项。
- 本包自己的配置文件：偏离 dsh 约定，`dsh --dump-config` 看不到。

### 密钥存储

TypeSafe Key 的读取顺序（三平台一致）：

1. 环境变量 `TYPESAFE_API_KEY`。
2. macOS 钥匙串：仅在 macOS 且配置了 `keychainService` 时读取（例如与 gitflow-cli 共享的 `ai.typesafe.api-key`，迁移见 byx-darwin/gitflow-cli#407）。
3. dsh 凭据服务 `ctx.credentials`（`@deepseek-ai/dsh-credentials-local`，dsh base bundle 默认加载，行 id `credentials`）：保存在 `$DSH_HOME/.credentials.yaml`，权限不是仅本人可读时 dsh 拒绝启动；它自身还会回退到项目 `.env` 与 `$DSH_HOME/.env`。

保存位置：macOS 默认写钥匙串 `ai.typesafe.api-key`（可选改写 dsh 凭据服务）；Linux 与 Windows 写 dsh 凭据服务。

不对接 Linux `secret-tool` 与 Windows 凭据管理器：前者在无桌面的机器上通常不存在，后者没有可直接读出密码的命令行工具。dsh 凭据文件与 `.env` 一样是明文，只靠文件权限保护，且 Agent 子进程以同一用户运行，理论上可以读到；文档中明确说明。

### 命令行形式

dsh 的启动器不允许插件添加子命令，因此以本包自带的可执行文件提供：

```sh
npx @mc/dsh-agent-kit doctor [--profile <名字>] [--json]
npx @mc/dsh-agent-kit setup  [--profile <名字>]
```

它直接定位 `$DSH_HOME/profiles/<名字>/`（`DSH_HOME` 默认为用户主目录下的 `.dsh`，路径处理兼容三平台），不需要启动 dsh。未指定 `--profile` 时，若只有一个 Profile 安装了本包则直接使用，否则让用户选择。

## 结构

```text
src/
  profile/   Profile 定位与 patch 文件编辑（纯 Node，不依赖 dsh 运行）
  secrets/   TypeSafe Key 的读取与保存
  checks/    doctor 的检查项
  cli/       可执行文件 dsh-agent-kit：doctor、setup
  admin/     常驻的服务端 Service agentKitAdmin，供 Web 页调用
  client/    Web 设置页（React，构建为 dsh 前端模块格式）
```

各模块的职责与接口如下。

### profile/

- `locateProfile(name?)`：返回 Profile 目录、patch 文件路径、`package.json` 中的 bundle 列表与 `patchReload` 模式。
- `readKitEntries(profile)`：返回四个 Service 的 `{ id, enabled, config }` 与文件版本（内容 SHA-256）。
- `writeKitEntries(profile, changes, expectedVersion)`：
  - 用 `yaml` 库的 Document API 修改，保留注释与本包以外的行。
  - 本包的行不存在时，追加形如 `- id: agent-kit-xxx` 的补丁行；存在时只改 `disabled` 与 `config`。
  - 当前文件版本与 `expectedVersion` 不一致时拒绝写入（冲突）。
  - 本包的行含 `!!js` 表达式时拒绝修改，报告具体行号。
  - 先写同目录临时文件再重命名，实现原子写入（Windows 上目标已存在时的重命名行为需一并处理）。
- 写入前用 Service 自己的 Config schema 与跨字段校验函数校验 `config`；不合法时不写入，返回按字段的错误。

### secrets/

- `resolveTypesafeKey({ env, keychainService, keychainAccount, credentials })` → `{ key, source } | undefined`，`source` 为 `env`、`keychain:<服务名>` 或 `credentials`。
- `saveTypesafeKey(target, value)`：`target` 为 `keychain`（仅 macOS）或 `credentials`。
- `describeTypesafeKey(...)` → `{ configured, source }`，不返回值。
- 钥匙串读写使用 `/usr/bin/security`（不经过 shell，写入时通过标准输入传值，不出现在命令行参数中）。
- 命令行中不启动 dsh 时，dsh 凭据服务通过直接读写 `$DSH_HOME/.credentials.yaml` 实现，格式与 `dsh-credentials-local` 一致，并保持文件权限为仅本人可读（Windows 上设置仅当前用户可访问的 ACL）；实施计划第一步核实该文件格式与并发写入行为。
- JevService 改为调用 `resolveTypesafeKey`，新增第 3 级来源，注入 `credentials` 为可选依赖。

### checks/

每个检查项为 `{ id, service, title, run(context) → { status: 'pass' | 'warn' | 'fail' | 'skip', detail, fix? } }`。只检查已启用 Service 需要的项。

| 范围 | 检查项 |
|---|---|
| 通用 | Node 版本；dsh 版本；本包是否在 Profile 的 bundle 列表中；`patchReload` 模式 |
| 各 Service | 配置能否通过 schema 与跨字段校验 |
| dingtalk | dws 是否安装；`dws auth status` 是否已登录（`dryRun` 与 webhook 身份跳过）；bot 身份是否有 robotCode；webhook 身份的环境变量是否存在 |
| agentTasks | 所选 provider 包是否安装；不支持工具过滤的 provider 是否有 `declaredPermissions`；工作目录能否写入 |
| jev | `@typesafe-ai/sdk` 是否安装；Key 能否取到及其来源（不输出值） |

### cli/

- `doctor`：逐项输出状态与修复命令；`--json` 输出 `{ profile, results: [...] }`；有 `fail` 时退出码为 1。
- `setup`：
  1. 选择 Profile；本包不在 bundle 列表中时，提示 `dsh plugin --profile <名字> add @mc/dsh-agent-kit` 并退出。
  2. 多选要启用的 Service，已启用的默认勾选。
  3. 逐个配置，当前值作为默认值：
     - dingtalk：选择身份；user 身份未登录时询问是否运行 `dws auth login`；默认目标可按群名搜索（`dws chat` 搜索）后选择或直接输入 ID；可选「发送一条测试消息给我自己」。
     - agentTasks：工作目录；provider；为不支持工具过滤的 provider 声明权限上限并说明含义。
     - jev：Key 不回显输入；显示保存位置；已有 Key 时可保留。
  4. 以差异视图展示 patch 文件改动，确认后写入；密钥单独保存，不出现在差异中。
  5. 自动运行 `doctor`。
- 任何一步取消都不写入文件；已保存的密钥保留。
- 交互使用 `@inquirer/prompts`。

### admin/

- `patch.yml` 新增一行常驻行（无 `disabled`）：`- id: agent-kit, name: '@mc/dsh-agent-kit'`。dsh 只从名字恰好等于包名且启用的行加载前端模块，因此本包根入口导出一个服务端 `apply`，挂载 `AgentKitAdmin`；前端部分由 `package.json` 的 `exports["./client"]` 与 `dsh.client` 声明。
- `AgentKitAdmin extends TypertRemoteService`，服务键 `agentKitAdmin`，依赖 `loader`，可选依赖 `credentials`：
  - `status()`：四个 Service 的启用状态、loader 中的运行阶段、运行中 Service 的 `health()`、当前配置（不含密钥）、doctor 结果、密钥描述、patch 文件版本、`patchReload` 模式、当前是否允许写入。
  - `saveService(id, enabled, config, expectedVersion)`：经 `profile/` 写入，返回新版本或按字段的校验错误、冲突错误。
  - `setSecret(target, value)` / `clearSecret(target)`：经 `secrets/` 保存或清除。
- 访问控制：写入类方法仅在 dsh Web 服务绑定本机地址时可用，否则返回只读原因；如何判断见「风险」第 2 项。
- 错误以 dsh 远程调用的错误形式返回，信息经过统一脱敏。

### client/

- 在 dsh 设置中新增一页「Agent Kit」（`settings.section` 插槽）。
- 每个 Service 一张卡片：启用开关、健康状态、doctor 结果、配置表单（按 Service 手写表单，dsh 不提供按 schema 自动生成的表单）。jev 卡片的密钥区域只显示「已配置（来源：…）」，可重新设置或清除。
- 保存时携带读取时的文件版本；冲突时提示刷新；保存成功后轮询 `status()` 直到对应 Service 按新配置重新运行（或提示需要重启 dsh）。
- 只读时禁用所有编辑控件并显示原因。
- 使用 dsh 前端共享的 `react`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`，不重复打包这些模块。
- 构建产物使用 dsh 前端的模块外包装（`window.__ModuleLoader__.load({ id, factory })`），由本包的构建脚本生成。

### 对现有部分的改动

- JevService：密钥读取改为 `secrets/`。
- 子进程终止：Windows 上用 `taskkill /T /F /PID <pid>` 结束进程树，其他平台保持进程组方式。
- CI：矩阵增加 `windows-latest`。
- 新增依赖：`yaml`、`@inquirer/prompts`（`dependencies`）；前端构建工具进 `devDependencies`。

## 测试

- `profile/`：真实 patch 文件样例：保留注释、只改本包行、追加缺失行、`!!js` 拒绝、版本冲突、原子写入；Windows 与 POSIX 路径。
- `secrets/`：三级来源的优先顺序；钥匙串部分使用可替换的读写函数，另有只在 macOS 运行的真实读写测试（临时服务名，测后删除）；dsh 凭据文件读写使用临时目录，并验证文件权限。
- `checks/` 与 `doctor`：每个检查项的各分支；外部命令使用假 dws 与临时 Profile；`--json` 结构与退出码。
- `setup`：脚本化输入驱动，从空 Profile 配置到 doctor 全部通过；取消、校验失败、不同意改动的路径。
- `admin/`：在真实 dsh loader 中测试 `status`、`saveService`（含 dsh 按新配置重启 Service）、版本冲突、只读状态、`setSecret`。
- `client/`：组件测试覆盖卡片渲染、保存、冲突与只读；在真实 dsh Web 中手动走查一遍并截图记录。
- CI 在 Linux、macOS、Windows 上运行。

## 风险与实施前验证

实施计划的第一步用原型验证以下三点：

1. **前端模块格式**：dsh 前端模块的外包装没有官方构建工具。先做一个最小插件，验证能在 dsh Web 中加载并注册设置页。若不可行，Web 页降级为由 `AgentKitAdmin` 提供的独立本地页面，其余部分不变。
2. **本机访问判断**：确认服务端远程方法能否获知 dsh Web 的绑定地址或请求来源。若不能，改为由 `AgentKitAdmin` 的配置项 `allowWrite` 控制写入，默认仅在 dsh Web 绑定 `127.0.0.1` 时允许。
3. **前端类型包**：`@deepseek-ai/dsh-client-ui-slots`、`dsh-client-ui-primitives` 等的已发布版本落后于 dsh 0.1.5-rc.3，可能需要在本包内维护一份类型声明。

另需核实：`dsh-credentials-local` 文件格式与并发写入行为（见 `secrets/`）。
