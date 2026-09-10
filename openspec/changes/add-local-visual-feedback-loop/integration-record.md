# 本地视觉反馈环接入验证记录

变更：`add-local-visual-feedback-loop`
记录时间：2026-09-09T07:46:08Z
验证平台：Darwin 25.6.0 arm64

## 1.1 Pi、图像结果、生命周期与 Glimpse

实际安装版本：

- Node.js：`v24.20.0`
- pnpm：`12.3.4`
- Python：`3.12.10`
- `@earendil-works/pi-coding-agent`：`0.84.4`
- `@earendil-works/pi-tui`：`0.85.1`
- `typebox`：`1.3.28`（项目声明 `^1.0.0`）
- Glimpse：`0.8.1`，安装包路径 `/Users/felix/.pi/agent/npm/node_modules/glimpseui/src/glimpse.mjs`
- browser-harness：`0.1.13`，使用仓库内 git launcher；当时未安装全局 `browser-harness` 命令

已完整阅读并以安装类型为准核对：

- Pi `docs/extensions.md`、`docs/sdk.md`、`docs/security.md`、`docs/session-format.md`、`docs/json.md`
- `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- `@earendil-works/pi-coding-agent/dist/core/exec.d.ts`
- Glimpse `skills/glimpse/SKILL.md`
- 仓库内 Harness `AGENTS.md`、`install.md`、`run.py`、`helpers.py`、`paths.py`、`_ipc.py`、`daemon.py`、`telemetry.py`

采用的实际签名与边界：

- 扩展入口：`export default function (pi: ExtensionAPI): void`。
- 工具注册：`pi.registerTool(tool)`；工具执行签名为 `execute(toolCallId, params, signal, onUpdate, ctx)`。
- 工具结果：`Promise<AgentToolResult<TDetails>>`；内容可为 `TextContent | ImageContent`。图像内容使用 `source: { type: "base64", mediaType, data }`。
- 工具取消：`signal` 是 `AbortSignal | undefined`；Pi 类型和文档要求嵌套的外部进程、fetch 与 UI 工作传递该 signal。
- 上下文：`ctx.isProjectTrusted(): boolean`、`ctx.hasUI: boolean`、`ctx.signal: AbortSignal | undefined`、`ctx.mode` 均可用。
- 会话事件：`session_start` 的 `event.reason` 为 `startup | reload | new | resume | fork`；`session_before_switch` 的 `event.reason` 为 `new | resume`，可返回 `{ cancel: true }`；`session_shutdown` 的 `event.reason` 为 `quit | reload | new | resume | fork`，用于释放会话资源。
- `ctx.hasUI` 在 TUI（终端用户界面）和 RPC（远程过程调用）模式为真，在 JSON/print 模式为假；基础采集不能依赖 UI。
- `pi.exec()` 的 `ExecOptions` 实际只有 `signal?: AbortSignal`、`timeout?: number`、`cwd?: string`，没有 stdin 或独立 env。固定脚本适配必须使用 Node 标准库 `child_process.spawn()`，并显式设置 `shell: false`、stdin 与白名单环境。
- Glimpse API 实际提供 `prompt(html, options)` 与 `open(html, options)`；`prompt()` 用户关闭返回 `null`；`open()` 实例支持 `ready`、`message`、`closed` 事件及 `send()`、`setHTML()`、`close()`；页面桥为 `window.glimpse.send(data)` 与 `window.glimpse.close()`。扩展必须从已安装包的绝对路径动态加载并 fail-closed。

## 1.2 专用 Chrome、页面信息与截图

使用的临时资源：

- HTTP 页面：`http://127.0.0.1:8765/index.html`
- Chrome profile：`/tmp/xpi-visualoop-validation/chrome-profile`
- CDP（Chrome 开发者工具协议）endpoint：`http://127.0.0.1:9333`
- Harness home/config/workspace/runtime/tmp：均在 `/tmp/xpi-visualoop-validation/` 下的私有目录
- 启动 Chrome：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --disable-gpu --no-first-run --no-default-browser-check --user-data-dir=/tmp/xpi-visualoop-validation/chrome-profile --remote-debugging-port=9333 about:blank`
- 调用入口：`cd docs/references/browser-harness && ./browser-harness`

执行环境变量：

- `BU_CDP_URL=http://127.0.0.1:9333`
- `BH_CONFIG_DIR=/tmp/xpi-visualoop-validation/harness-home/config`
- `BH_AGENT_WORKSPACE=/tmp/xpi-visualoop-validation/harness-workspace`
- `BH_RUNTIME_DIR=/tmp/xpi-visualoop-validation/harness-runtime`
- `BH_TMP_DIR=/tmp/xpi-visualoop-validation/harness-tmp`
- `BH_RECORD=0`
- `BH_TAB_MARKER=0`
- `BH_TELEMETRY=0`
- `BU_AUTOSPAWN=0`

结果：

- Harness `--version`：`0.1.13`
- Chrome：`Google Chrome 152.0.7977.82`
- `doctor --json --require-existing-daemon`：`healthy: true`、`browser_ready: true`、`daemon.alive: true`、`install_mode: git`
- `new_tab()` 创建并绑定自有 target：`61CE05402E09F00775F15F1358362A9F`
- 固定设置：CSS viewport `640×360`、`deviceScaleFactor=2`
- `page_info()`：`w=640`、`h=360`、`sx=0`、`sy=0`、`url=http://127.0.0.1:8765/index.html`
- `window.devicePixelRatio`：`2`
- 截图路径：`/tmp/xpi-visualoop-validation/harness-tmp/viewport.png`
- 截图实际尺寸：`1280×720`，PNG，`36,254` bytes
- stdout 为一个 JSON 对象，stderr 为空；没有切换到其他标签页或浏览器

## 1.3 标准输入、结构化结果、事件与取消

固定脚本通过 stdin 执行，脚本只调用已读核对的 helpers。采集脚本结果为单条 JSON：

```json
{"consoleErrorCount":1,"eventCount":25,"http404Count":1,"loadingFailedCount":0,"privateEnvLoaded":"loaded-from-private-workspace","secondDrainCount":0,"userHelperLoaded":false,"userEnvLoaded":null,"workspaceFiles":[]}
```

验证事实：

- `stdout` 只含一条结构化结果；`stderr` 为空。
- 私有 workspace 的 `.env` 能被 Harness 加载，证明环境加载路径可控。
- 默认 Harness home 中预置用户 `agent_helpers.py` 与 `.env`，但显式指定空私有 `BH_AGENT_WORKSPACE` 后：`userHelperLoaded=false`、`userEnvLoaded=null`、私有 workspace 文件列表为空。
- 额外探针确认 Harness 本身会导入被指定 workspace 中的 `agent_helpers.py`；因此实现必须每个检查上下文创建空且权限受限的私有 workspace，不能把 Harness 自动忽略用户 helper 当作保证。
- `Runtime.consoleAPICalled` 捕获 1 条受控 console error。
- `Network.responseReceived` 捕获 1 条 HTTP 404。普通 HTTP 404 不会产生 `Network.loadingFailed`，所以 Harness 的 `loadingFailed` 不是完整 HTTP 失败历史；实现必须保留状态范围和 unknown/不完整语义，不能将 `loadingFailedCount=0` 解读为网络无错误。
- `drain_events()` 后再次调用返回 `secondDrainCount=0`，事件观察窗口具备清空语义。
- 取消测试：启动一个 `wait(20)` 脚本后终止调用方进程，进程退出码 `143`，stdout/stderr 均无输出。调用方终止不会自动停止 daemon；随后显式执行 `./browser-harness --reload`，runtime socket/PID 被删除。因此扩展必须自己监听 AbortSignal，并在会话结束、断开和取消路径显式清理 daemon/所有权资源。
- 录制：`recordings` 返回 `auto-recording: off (BH_RECORD)`、`active: none`、`latest: none`。
- telemetry（遥测）：`telemetry status` 返回 `enabled: false`、`disabled_by_env: true`，无 telemetry 配置写入私有验证目录。
- 未执行更新、录制、云启动或认证命令。
- 未启用完整 DOM（文档对象模型）转储、像素差异算法、网络请求正文/认证头/Cookie 收集；事件检查仅覆盖本次显式 `Network.enable` / `Runtime.enable` 后的窗口。

## 清理结果与已知限制

- 已执行 `./browser-harness --reload`，Harness runtime 的 socket/PID 清理通过。
- 验证使用 headless Chrome，不代表 macOS 可见窗口或 Fedora/WebKitGTK/Glimpse 窗口已验证。
- 使用仓库参考 launcher，不代表全局 `uv tool install` 后的安装包路径行为已验证。
- 1.3 的“无用户 helper”成立的条件是扩展创建并显式传入空私有 workspace；Harness 若被指向含 helper 的 workspace 会导入它，这个事实必须进入后续实现约束。
