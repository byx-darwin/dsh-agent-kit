# dsh-agent-kit 官网设计

- 日期：2026-09-24
- 状态：待评审
- 参考：`../gitflow-cli/website/`（工程做法）；视觉为全新设计

## 背景与目标

`@mc/dsh-agent-kit` 需要一个面向第三方开发者的官网，介绍它能做什么、如何安装配置、每个 Service 的接口与配置，以及与 dsh 的关系。工程做法参考同作者的 gitflow-cli 官网（Astro 静态站 + GitHub Pages + `llms.txt` + JSON-LD + 一致性测试），视觉采用全新的「编辑部长文」风格。

目标：

- 第三方开发者从官网即可完成「了解 → 安装 → 配置 → 查接口」的全过程。
- 配置项、默认值等随代码变化的内容由源码生成，不手抄，避免网站与代码脱节。
- 部署到 `https://byx-darwin.github.io/dsh-agent-kit/`，`website/**` 变更推送到 main 后自动发布。

非目标：

- 搜索、深色模式、英文版。
- 评价第三方产品；对比页只比较本包自身能证实的点。

## 页面结构

全站中文。内容来源：README、`docs/superpowers/specs/` 下的两份规格、源码。

| 路径 | 页面 | 主要内容 |
|---|---|---|
| `/` | 首页 | 观点句「让业务包只写业务」；四件事（壹 连接 agentWs、贰 推送 dingtalk、叁 委托 agentTasks、肆 校验 jev）各一段；默认安全与按需启用；一段业务包代码示例；指向快速开始 |
| `/quickstart` | 快速开始 | 安装 dsh 与本包 → `npx @mc/dsh-agent-kit setup` → `doctor` → Web 设置页；三平台密钥存储位置 |
| `/docs` | 文档总览 | 四个 Service 与配置引导的入口 |
| `/docs/agent-ws`、`/docs/dingtalk`、`/docs/agent-tasks`、`/docs/jev` | 各 Service | 接口示例、配置项表（生成）、错误码与是否可重试、关键行为 |
| `/docs/onboarding` | 配置引导 | `doctor`、`setup`、Web 设置页，只读条件 |
| `/docs/security` | 安全 | 密钥来源与存储、子进程环境变量白名单、不可信数据与 `untrusted()`、权限声明、Web 写入限制 |
| `/architecture` | 架构 | 与 dsh / cordis 的关系、bundle patch 层与默认禁用、业务包如何 inject；一张架构图 |
| `/compare` | 对比 | 「每个项目自行实现」「直接调用 CLI / SDK」「使用本包」三列对比：重连与背压、密钥处理、健康状态、测试替身、配置引导等 |
| `/compatibility` | 兼容性 | Node、dsh、cordis、dws、subagent provider、`@typesafe-ai/sdk` 版本；Linux / macOS / Windows 状态（链接 CI） |
| `/support` | 支持与 FAQ | 提交 issue 的方式；常见问题 |
| `/changelog` | 更新日志 | v0.1.0 |
| `/blog`、`/blog/resident-agent-worker`、`/feed.xml` | 博客 | 首篇《用 dsh 搭一个常驻 Agent Worker》；RSS |
| `/llms.txt`、`/llms-full.txt`、`/llms-config.txt` | 给 AI 读 | 概述；完整文档；命令与配置项 |

本包尚未发布到 npm 时，所有安装命令旁显示「尚未发布」提示框（由 `src/data/release.ts` 的 `published` 开关控制）。

## 视觉系统

方向：编辑部长文（米白纸感、中文衬线标题、朱红点缀、留白多）。

- 字体（自托管，经 `@fontsource`）：标题 Noto Serif SC 700；正文 Noto Sans SC 400，16px，行高 1.85，每行不超过约 36 个汉字；代码 JetBrains Mono 13px。
- 配色（`global.css` 中的 CSS 变量）：

  | 变量 | 值 | 用途 |
  |---|---|---|
  | `--paper` | `#FAF7F0` | 页面底色 |
  | `--card` | `#F1EBDF` | 卡片底色 |
  | `--ink` | `#2A2622` | 正文、标题 |
  | `--muted` | `#6B6258` | 次要文字 |
  | `--rule` | `#E3DCCD` | 分隔线、边框 |
  | `--accent` | `#B4532A` | 小标题、链接、强调线、少量按钮 |
  | `--code-bg` | `#1F1B18` | 代码块底色 |
  | `--code-fg` | `#EFE7DA` | 代码块文字 |

  朱红只用于小面积元素；大面积只有纸色与墨色。正文文字与背景的对比度满足 WCAG AA。
- 版式：正文列最宽 720px 居中；首页与架构页可放宽到 1080px。顶栏细线分隔、无阴影；页脚一行小字。「壹贰叁肆」给四个 Service 编号，贯穿全站。
- 移动端：两侧 16px 留白，卡片单列，表格可横向滚动，无横向页面滚动。
- 组件：`CopyCommand`（命令 + 复制按钮）、`ServiceCard`（编号卡片）、`ConfigTable`（配置项表）、`Notice`（左侧朱红线提示框）、`Figure`（图与图注）、引文样式。

## 工程实现

### 目录

`website/` 是独立 npm 项目（有自己的 `package.json` 与 lockfile），不进入本包的发布内容（根 `package.json` 的 `files` 白名单不含它）。

```text
website/
  astro.config.mjs        site: https://byx-darwin.github.io/dsh-agent-kit，base: /dsh-agent-kit；集成 mdx、sitemap
  src/layouts/Base.astro  顶栏、页脚、title / description / canonical / OG、JSON-LD
  src/components/         CopyCommand、ServiceCard、ConfigTable、Notice、Figure
  src/data/               services.ts、config-tables.ts、faq.json、blog.ts、changelog.ts、release.ts
  src/lib/                paths.ts（withBasePath）、jsonld.ts
  src/pages/              各页面；长文用 .mdx
  src/styles/global.css   视觉系统
  public/                 llms*.txt、robots.txt、架构图
  tests/                  vitest
```

站内链接一律经 `withBasePath(import.meta.env.BASE_URL, path)` 生成。

### 由源码生成的内容

- `config-tables.ts` 在构建时导入本包源码 `../src/ws/config.ts`、`../src/dingtalk/config.ts`、`../src/agent-tasks/config.ts`、`../src/jev/service.ts` 中的 schemastery schema，遍历字段生成「字段 / 默认值 / 取值范围 / 说明」。取值范围来自 schema 的 min / max / pattern / 枚举，说明来自 `.description()`。跨字段约束（如 `readTimeoutMs ≥ 2 × pingIntervalMs`）在 `services.ts` 中以文字补充。
- 错误码表、CLI 命令、共享钥匙串服务名 `ai.typesafe.api-key` 等引用源码导出的常量；源码未导出为常量的部分在 `services.ts` 中维护，由测试与源码交叉校验。
- 版本号取自根 `package.json`。

### 部署

新增 `.github/workflows/website.yml`（参照 gitflow-cli）：

- 触发：`website/**`、本包 `src/**/config.ts`、`src/jev/service.ts`、`package.json`、该 workflow 自身有变更时，push 到 main 或 PR 到 main。
- `build` job：Node 22；先在仓库根目录 `npm ci`（配置表生成需要导入本包源码及其依赖 schemastery / cordis），再在 `website/` 下 `npm ci`、`npm test`、`npm run build`；push 时上传 `website/dist` 为 Pages artifact。
- `deploy` job：仅 push 时，`actions/deploy-pages@v4`。
- 权限：`contents: read`、`pages: write`、`id-token: write`；并发组 `website-${{ github.ref }}`，取消进行中的旧构建。

### 上线前的仓库操作

由用户授权后执行：

1. 扫描完整 git 历史，确认没有密钥、token、个人或公司信息（含 `tests/fixtures/dws/` 录制输出）；发现问题先处理再公开。
2. `gh repo edit byx-darwin/dsh-agent-kit --visibility public --accept-visibility-change-consequences`
3. 启用 Pages 并设来源为 GitHub Actions：`gh api -X POST repos/byx-darwin/dsh-agent-kit/pages -f build_type=workflow`。
4. 设置仓库主页为官网地址：`gh repo edit --homepage https://byx-darwin.github.io/dsh-agent-kit/`。

## 测试

`website/tests/`（vitest），在 website workflow 中运行：

- `paths`：`withBasePath` 的各种输入。
- `links`：构建后扫描 `dist/` 中所有 HTML 的站内 `href` / `src`，都以 `/dsh-agent-kit/` 开头且对应文件存在。
- `config-tables`：生成的配置表字段集合与各 schema 的字段一致；抽查默认值（如 `dingtalk.timeoutMs = 15000`、`agentTasks.maxConcurrency = 2`）与源码一致。
- `geo-consistency`：JSON-LD、`llms.txt`、首页 description 中的定位语、仓库地址、npm 包名、版本号一致。
- `feed`：RSS 结构正确，文章链接带 base。

另外手动走查：用无头浏览器在桌面与手机宽度下截取首页、快速开始、一个 Service 文档页、架构页，确认无横向滚动、字体加载、代码块与表格可读。
