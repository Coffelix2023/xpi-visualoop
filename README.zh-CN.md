# xpi-visualoop

**English**: [README.md](./README.md)

面向 Pi Coding Agent 的本地视觉反馈闭环扩展：通过用户准备的回环浏览器观察本地页面，将不可变截图返回给模型，在 Glimpse 中收集可选的局部意见，并比较基准截图与修改后的新截图。

> 无构建步骤：Pi 直接加载 `src/index.ts`。本扩展不会安装、启动或关闭浏览器。

## 环境要求

- 已验证开发环境使用 Node.js `24.20.0`、pnpm `12.3.4`。
- 单独安装 `browser-harness` 可执行程序。扩展使用固定脚本和 `shell: false` 调用它。
- 使用独立的 Chrome/Chromium profile（配置目录）和回环 CDP（Chrome DevTools Protocol，Chrome 开发者工具协议）端点。不要连接日常登录 profile。
- 图形反馈可选依赖 Glimpse；已验证路径使用 Glimpse `0.8.1`。

本变更已验证：macOS Darwin `25.6.2` arm64、Node.js `24.20.0`、pnpm `12.3.4`、Python `3.12.10`、Pi `0.84.4`、browser-harness `0.1.13`、Glimpse `0.8.1`、Chrome `152.0.7977.84`。Fedora Linux 未在本变更中验证。

## 快速开始

```bash
mise install
pnpm install
pnpm typecheck
pnpm -w run lint
pnpm test
```

无需编译即可加载扩展：

```bash
pi -e ./src/index.ts
```

日常开发可软链到 Pi 扩展目录，在 Pi 内使用 `/reload`：

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/xpi-visualoop
```

## 专用浏览器设置

扩展只接受明确配置的 `http://` 回环端点，以及 `localhost`、`127.0.0.1` 或 `::1` 上的本地页面地址。它会拒绝凭据、端点查询/片段、离开回环范围的顶层导航，以及跳转到其他主机的端点响应。

macOS 示例：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.cache/xpi-visualoop/chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

Fedora 示例（本变更未验证；按实际安装的浏览器调整可执行文件路径）：

```bash
google-chrome \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.cache/xpi-visualoop/chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

profile 和端点由用户负责准备。扩展不会启动浏览器、修改日常 profile，也不会回退到其他浏览器。

## 配置

用户配置文件位于 `<agentDir>/xpi-visualoop.json`。项目被信任时，可用 `<cwd>/.pi/xpi-visualoop.json` 覆盖用户配置；未受信任项目的配置会被忽略。未知字段和不安全路径会 fail-closed（失败闭合）。

```json
{
  "cdpUrl": "http://127.0.0.1:9333/",
  "harnessPath": "/absolute/path/to/browser-harness",
  "glimpseModulePath": "/absolute/path/to/glimpseui/src/glimpse.mjs"
}
```

`harnessPath` 必须是绝对可执行路径或安全命令名；`glimpseModulePath` 可选且必须是绝对路径。配置不接受任意命令参数、页面脚本、Token、Cookie 或凭据。

`browser-harness` 保持在扩展包外。本仓库的 `docs/references/browser-harness/browser-harness` 是本地验证用的固定参考可执行文件，不是自动安装器，也不是扩展运行时打包依赖。

## 四个工具与命令

标准流程是显式、串行的：

1. `visual_prepare`：准备一个本地 URL、视口、DPR（设备像素比）和可选声明 `stateLabel`。它可以创建或导航扩展拥有的标签页。
2. `visual_capture`：采集当前视口，可选解析一个唯一且可见的选择器。不会导航、滚动、调整视口、点击或输入。模型会收到实际 PNG 图像内容块和有界 JSON 元数据。
3. `visual_feedback`：检查一个 `captureId` 或一个 `comparisonId`。Glimpse 支持单个图像区域、数字坐标、文字意见、提交、取消和比较认可。
4. `visual_verify`：复用基准截图的检查上下文和目标，生成修改后的新截图，返回 `comparable` 或 `not-comparable`、独立诊断、目标/样式变化和有界前后图像。

人工交互或代码修改后，应使用准确的声明状态再次调用 `visual_capture` 或 `visual_verify`。`stateLabel` 是调用方声明，不是浏览器自动证明。

命令仍可使用：

```text
/xpi-visualoop status
/xpi-visualoop disconnect
```

`status` 返回当前检查上下文。`disconnect` 会取消在途操作、使旧证据失效、清理扩展拥有的临时文件和后台资源，但不会关闭浏览器进程或删除其 profile。

## 预算与降级

初始固定预算不开放为配置矩阵：

- 导出截图最长边不超过 2,000 像素，且不超过 4 MiB。
- 单次工具 JSON 结果不超过 64 KiB；面向模型的采集文本不超过 16 KiB。
- console 与 network 失败摘要各最多 20 条，并标记截断。
- 用户意见最多 2,000 字符。
- 单次操作 30 秒；就绪等待 5 秒；反馈面板等待 10 分钟。
- 一个检查上下文最多 20 次采集，证据及中间文件合计 128 MiB。

就绪与诊断状态保持诚实区分：`ready`、`degraded`、`failed`、`observed`、`unknown` 不互相替代。扩展不会用网络空闲推断页面交互已初始化，不默认收集认证头、Cookie、请求正文，不自动开启录制，也不声称取得完整原子 DOM（文档对象模型）快照。

Glimpse 不可用但 Pi 有 UI（用户界面）时，反馈降级为明确的**整图文字反馈**，保留图像路径和引用。没有对话界面时返回 `unavailable`，采集功能仍不依赖图形窗口。

## 文件、隐私边界与回滚

截图和中间文件位于检查上下文私有的临时目录。清理逻辑只删除本扩展创建的文件和浏览器资源；硬崩溃后可能留下残留，下一次启动只按所有权检查。浏览器进程和 profile 始终属于用户。

工具结果中的截图可能被 Pi 会话保存，或发送给配置的模型服务。清理扩展临时目录不会删除这些副本。因此“本地采集”不等于图像绝不会离开本机。

回滚步骤：

1. 在当前 Pi 会话执行 `/xpi-visualoop disconnect`。
2. 删除扩展软链或 Pi 扩展配置中的加载项，或回退本仓库变更。
3. 仅删除为本扩展准备的专用 profile 和临时目录；不要删除日常浏览器 profile。

没有数据库迁移，也不要求迁移浏览器配置。

## 开发门禁

```bash
pnpm typecheck       # TypeScript strict 检查
pnpm -w run lint     # Biome 全仓检查
pnpm test            # 只运行 tests/ 下的 Vitest 测试
```

Vitest 配置只收集 `tests/**/*.test.ts`；`docs/references` 含有依赖不同的第三方源码和测试，不属于本扩展测试范围。

## 仓库结构

```text
.
├── mise.toml / package.json / biome.jsonc / vitest.config.ts / tsconfig.json
├── AGENTS.md / CONTEXT.md / DESIGN.md
├── docs/                    # 工作流、参考说明和验证记录
├── openspec/                # proposal、spec、design、tasks
├── src/index.ts             # Pi 扩展注册入口
├── src/visual-loop/         # 配置、Harness 适配、证据、反馈、上下文
└── tests/                   # 聚焦单元/集成测试
```
