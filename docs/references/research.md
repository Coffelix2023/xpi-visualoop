# 项目初始化研究结论

## 用户需求
目标: 打造一个pi-package: xpi-visualoop - 让Agent和用户用视觉化方式交流/反馈
 解决痛点: Agent(即便是视觉模型)与用户沟通关于UI修改的问题, 经常反复几十次修改一个小地方,最后可能仍
 未达到预期. 所以Agent如果能真实第看到web界面,并精准定位设计调整,同时通过图像(或Html等视觉表现)直观
 展示给用户来交流,(不要等待正版webui全出来再改,可以快速修正细节局部), 而不是传统的一对asc编码图案,
 该如何选择技术栈?或者已经有成型的热门github高星仓库工具推荐? 参考仓库(优先移植/复用模块组件, 避免
 重复造轮子, 但要注意许可证权限) - docs/references/


## 架构师决策
 这个项目不该变成另一个 Browser Use 或 Screenshot-to-Code。核心应是 Pi 内的“视觉反馈编排层”：

 ```text
   Agent 修改代码
       |
       v
   浏览器运行时采集
       |
       +--> Screenshot：给模型看真实画面
       +--> DOM / A11y：精准定位元素
       +--> Bounding Box / CSS：说明问题在哪里
       +--> Console / Network：补充运行时证据
       |
       v
   Pi 展示结果，用户反馈
       |
       v
   Agent 局部修改并重新验证
 ```

 推荐技术路线：

 - Pi 扩展核心：TypeScript + Pi registerTool() + ctx.ui.*
 - 浏览器控制：外部 Browser Harness / Playwright / Chrome DevTools MCP，不嵌入重型浏览器依赖
 - 视觉证据：PNG 截图 + DOM/A11y 快照 + 元素坐标 + computed style
 - 用户展示：Pi TUI 状态与摘要，支持 Glimpse 时打开原生 HTML 预览窗口
 - OmniParser：只作为 Canvas、桌面应用、无 DOM 页面时的后备能力
 - Screenshot-to-Code / HTML Anything：用于未来的快速原型与局部 HTML 试验，不作为第一阶段核心依赖

 问题重构

 真正的痛点不是“Agent 不会生成 UI”，而是：

 │ Agent 和用户缺少一个共享的、可定位的视觉事实。

 纯 ASCII 或 DOM 文本会丢失：

 - 实际布局
 - 间距和比例
 - 字体渲染
 - 图片裁切
 - 溢出与遮挡
 - hover、弹窗、滚动后的状态
 - 用户真正看到的视觉层级

 但单独给模型截图也不够，因为截图不能稳定回答：

 - 这是哪个 DOM 元素？
 - 对应哪个源代码？
 - 是 CSS、布局、资源还是运行时错误？
 - 修改后是否只影响目标区域？

 所以应使用双通道：

 ```text
   视觉通道:
     screenshot / cropped screenshot / visual diff

   结构通道:
     DOM / Accessibility Tree / selector / bbox / computed style / console
 ```

 截图负责“看起来哪里不对”，结构数据负责“准确改哪里”。

 参考仓库职责判断

 ┌────────────────────┬─────────────────────────────────────┬─────────────────────────────────────┐
 │ 项目               │ 适合复用的部分                      │ 不适合直接搬进 Pi                   │
 ├────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┤
 │ browser-harness    │ 本地 Chrome CDP、截图、页面信息、录 │ Python + uv 运行时，不应复制 CDP 实 │
 │                    │ 制、MCP 工具                        │ 现                                  │
 ├────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┤
 │ browser-use        │ 浏览器 Agent 方法论、QA 流程、真实  │ 完整 Agent 编排过重，和 Pi 的 Agent │
 │                    │ 浏览器使用经验                      │ 重复                                │
 ├────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┤
 │ openbrowser        │ TypeScript MCP Bridge、DOM/A11y     │ Playwright、模型适配、Sandbox 全部  │
 │                    │ Snapshot、截图和视觉追踪            │ 嵌入会破坏轻量扩展边界              │
 ├────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┤
 │ OmniParser         │ 截图中的交互区域检测、bbox 定位     │ Python 模型、权重、GPU、模型许可和  │
 │                    │                                     │ 启动成本                            │
 ├────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┤
 │ html-anything      │ 单文件 HTML、流式预览、iframe       │ 完整 Next 应用和大量模板对本项目过  │
 │                    │ sandbox、局部原型思想               │ 重                                  │
 ├────────────────────┼─────────────────────────────────────┼─────────────────────────────────────┤
 │ screenshot-to-code │ Screenshot-to-code 交互、局部预览、 │ 视觉代码生成不是 xpi-visualoop 的核 │
 │                    │ 截图审查流程                        │ 心职责                              │
 └────────────────────┴─────────────────────────────────────┴─────────────────────────────────────┘

 许可证方面：

 - browser-harness：MIT
 - browser-use：MIT
 - openbrowser：MIT
 - screenshot-to-code：MIT
 - html-anything：Apache-2.0
 - OmniParser：仓库许可证为 CC BY 4.0，部分检测器和模型权重还有额外许可证，尤其不能直接把权重打进
   Pi 包

 结论是：优先做外部工具适配器，不要直接 vendoring 第三方完整项目。

 与 Pi API 的匹配度

 当前 Pi API 已经覆盖核心能力：

 ```text
   registerTool()
     -> Agent 可调用视觉工具

   ExtensionContext
     -> cwd / signal / mode / hasUI / ui

   ctx.ui.custom()
     -> TUI 内交互式检查面板

   ctx.ui.setWidget()
     -> 显示当前视觉检查状态

   pi.exec()
     -> 调用外部 browser-harness、Playwright CLI 或 MCP sidecar

   AgentToolResult.content
     -> 返回 text + ImageContent
 ```

 Pi 的图片内容类型是：

 ```ts
   {
     type: "image",
     data: string,
     mimeType: "image/png"
   }
 ```

 因此截图可以作为工具结果直接回传给支持视觉输入的模型，不需要先转成 ASCII。

 建议的第一阶段能力

 第一阶段只做观察和反馈，不做自动修复：

 ```text
   visual_capture
     输入:
       - URL 或当前页面
       - viewport
       - selector / region
       - fullPage
       - 是否包含 DOM / A11y / console

     输出:
       - screenshot
       - page URL / title
       - viewport
       - selector 与 bbox
       - 相关 computed styles
       - A11y 摘要
       - console errors
       - network errors
 ```

 可以先压缩成三个工具：

 ```text
   visual_capture
     截图 + 页面基本信息

   visual_inspect
     指定 selector，返回 bbox、computed style、局部截图

   visual_verify
     修改后重新捕获，并对比前后状态
 ```

 只读工具和变更工具应分开：

 ```text
   只读:
     visual_capture
     visual_inspect
     visual_verify
     visual_console

   可能产生副作用:
     visual_click
     visual_type
     visual_navigate
     visual_eval
 ```

 默认不开放 visual_eval，避免 Agent 通过页面脚本执行不可控操作。

 浏览器运行时选择

 ### 方案 A：Browser Harness

 适合：

 - 复用用户当前 Chrome
 - 使用用户已经登录的会话
 - 需要真实浏览器状态
 - 希望快速接入现有 MCP 工具

 ```text
   Pi extension
       |
       v
   browser-harness CLI / MCP
       |
       v
   本地 Chrome CDP
 ```

 优点：

 - 已有截图、页面信息、Tab 管理
 - 支持本地 Chrome 登录态
 - 已有录制和隐私提示
 - MIT

 代价：

 - 依赖 Python / uv
 - 需要 Chrome 远程调试
 - 截图可能包含用户隐私
 - 本地 Chrome 是共享状态，多个任务必须串行

 ### 方案 B：Playwright sidecar

 适合：

 - 本地开发服务器
 - 可复现视觉检查
 - 固定 viewport、固定初始状态
 - CI 或回归测试

 ```text
   Pi extension
       |
       v
   Playwright sidecar
       |
       v
   isolated Chromium
 ```

 优点：

 - 状态更确定
 - 不污染用户真实 Chrome
 - 元素选择、等待、截图、对比能力完整
 - 适合做 visual_verify

 代价：

 - 需要额外浏览器安装
 - 本地登录态复用较麻烦
 - 不应把 Playwright 直接作为 Pi 扩展运行时依赖打包进去

 ### 方案 C：Chrome DevTools MCP

 ChromeDevTools/chrome-devtools-mcp 更适合参考其工具面：

 - screenshot
 - accessibility snapshot
 - console
 - network
 - performance
 - DOM / CDP
 - 浏览器调试

 它适合作为“能力参考”或外部 MCP sidecar。Pi 扩展需要一个很薄的 MCP stdio 客户端，或者通过命令行桥接
 ，不能假设 Pi 会自动继承其他客户端的 MCP 配置。

 我的建议

 按用途分成两个 backend：

 ```text
   +----------------------+---------------------------+
   | 用途                 | Backend                  |
   +----------------------+---------------------------+
   | 真实用户浏览器       | browser-harness          |
   | 本地可复现视觉回归   | Playwright sidecar       |
   +----------------------+---------------------------+
 ```

 默认不要引入 OmniParser。

 网页开发场景中，DOM、Accessibility Tree、bbox 和 computed style 通常比纯视觉检测更准确。OmniParser
 只在以下情况启用：

 - Canvas UI
 - SVG 绘制的复杂控件
 - 跨域 iframe 内部无法读取 DOM
 - 桌面应用或非网页界面
 - DOM 结构严重缺失的页面

 “用户也能直观看到”的展示方案

 Pi TUI 本身适合显示：

 ```text
   [VISUAL] http://localhost:3000/dashboard
   viewport: 1440x900
   target: .hero-card
   bbox: 40,120 640x280
   console: 0 errors
   network: 1 failed request
   artifact: /tmp/xpi-visualoop/...
 ```

 但 TUI 不适合展示完整 PNG。建议双轨：

 ```text
   模型:
     ImageContent 直接接收截图

   用户:
     TUI 显示摘要和 artifact 路径
     Glimpse 可用时打开 800x600 原生 HTML 面板
     无 Glimpse 时打开系统默认图片/浏览器
 ```

 Glimpse 适合做：

 - 当前截图
 - 前后截图并排
 - 局部放大
 - bbox 高亮
 - selector、尺寸、颜色、字体信息
 - 用户输入“这里不对”的反馈

 不建议第一阶段构建完整 Web UI。那会把项目从 Pi 扩展变成一个新的前端应用，偏离核心问题。

 局部快速修正的关键

 不要只支持整页截图，应把“局部观察”作为一等能力：

 ```text
   visual_inspect({
     url: "http://localhost:3000",
     selector: ".pricing-card",
     viewport: { width: 1440, height: 900 }
   })
 ```

 返回：

 ```text
   page screenshot
   cropped element screenshot
   selector
   bounding box
   computed width / height
   margin / padding / gap
   font family / size / line height
   color / background / border
   overflow state
   nearby DOM context
 ```

 这样 Agent 可以先修：

 ```text
   .hero
   .hero-title
   .pricing-card
   .mobile-nav
   .dialog
 ```

 不必等待整站所有功能完成。

 需要保留的工程约束

 视觉闭环必须固定运行条件，否则前后截图不可比：

 - 固定 viewport
 - 固定 DPR
 - 固定浏览器字体
 - 等待字体和图片加载完成
 - 等待 hydration 和网络请求稳定
 - 固定 URL、路由和交互状态
 - 限制截图尺寸和工具输出大小
 - 默认不持久化截图
 - 用户明确同意后才录制
 - 敏感页面不上传外部视觉模型
 - console、网络错误和截图分别返回，避免模型只看图片

 现在已经确定的方向

 问题：Agent 修改 UI 时缺少真实视觉证据和精确定位能力。

 核心策略：结构化页面信息负责定位，截图负责视觉判断，Pi 负责编排和反馈。

 第一阶段不做：

 - 不训练视觉模型
 - 不嵌入 OmniParser
 - 不复制 Browser Use 的 Agent
 - 不创建完整 Next.js Web UI
 - 不自动根据截图生成整个项目
 - 不默认保存用户浏览记录
 - 不自动执行浏览器副作用操作

 优先研究对象：

 1. Browser Harness 的截图、页面信息和 MCP 工具
 2. Open Browser 的 TypeScript MCP Bridge 与 Snapshot Builder
 3. Chrome DevTools MCP 的工具边界
 4. Glimpse 的原生预览面板
 5. Screenshot-to-Code / HTML Anything 的局部预览模式

 当前没有创建 OpenSpec change，也没有修改文件。下一步最关键的选择是：这个工具的第一用户场景优先是“
 检查本地开发中的 Web 页面”，还是“观察用户当前已经登录的真实 Chrome 页面”。
```

## 附录 A：浏览器后端决策记录（2026-09-10 修订）

### 决策

- **浏览器后端改为扩展内建的 Node CDP 客户端**，不再 `spawn` 外部 `browser-harness` 命令。
- `docs/references/browser-harness` 本地 clone 删除；固定参考点见下方「参考点」。
- 本文第 2 节「参考仓库职责判断」中 browser-harness 一行与第 4 节「方案 A」保留为**历史决策记录**，不再是当前实现在用方案。

### 当前运行方式（2026-09-12 补充）

无外部运行时依赖：只需要 Node.js 和一个可达的回环 CDP 端点。启动一个专用 Chrome，独立 profile、独立调试端口，不触碰日常 profile：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.cache/xpi-visualoop/chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

配置只需 `cdpUrl`；`glimpseModulePath` 可选：

```json
{"cdpUrl":"http://127.0.0.1:9333/"}
```

**配置破坏性变更**：`harnessPath` 已从配置解析器移除。仍带该键的配置会 fail-closed 拒绝启动，并返回迁移提示；迁移动作只有一步——删除该键。可复现的验收脚本见 `docs/references/native-cdp-probes/verify.mjs`。

### 依据

1. **支付成本但未获得收益。** browser-harness 的架构价值是 daemon + AF_UNIX IPC，服务「多 agent 进程共享同一浏览器、接管用户已登录 Chrome 标签页」。本项目实际用法是专用 Chrome、私有 workspace、私有 runtime dir、单进程顺序调用（`src/visual-loop/harness.ts` 的 `environment()` 把所有 `BH_*` 指向私有目录），daemon 的复杂度全部付账，核心能力一项未用。
2. **实际依赖面只有约 12 个 CDP 调用。** `harness.ts` 的固定脚本使用 `_send` / `new_tab` / `switch_tab` / `current_tab` / `close_tab` / `cdp` / `goto_url` / `wait_for_load` / `page_info` / `capture_screenshot` / `js` / `drain_events`，加上 PIL 裁剪。
3. **Node 24 内置 `WebSocket`**（`typeof WebSocket === "function"`），CDP 是 WebSocket 上的 JSON，直连无需任何新增依赖。
4. **坐标系可以统一。** `Page.captureScreenshot` 的 `clip` 复合类型 `Page.Viewport` 字段 `x` / `y` / `width` / `height` 官方语义为 DIP（device independent pixel），与现有 `visibleBounds` 的 CSS 像素同系；现有 `scale_x = raw_width / page_before["w"]` 的 DPR 换算与 PIL 裁剪可整体删除。
5. **Pi 包机制不支持 Python。** 官方 `docs/packages.md`：第三方运行时依赖放 `dependencies`，安装时只跑 `npm install`；`bundledDependencies` 仅用于嵌套 Pi 包。无 pip / uv 钩子。
6. **vendor Python 子集解决不了依赖问题。** `cdp-use==1.4.5` / `websockets==15.0.1` / `pillow==12.3.0` 仍需用户自行安装；既然仍需 `uv tool install browser-harness`，vendor 源码只增加仓库体积与双份维护。

### 参考点（clone 删除后从这里重取）

- 仓库：`https://github.com/browser-use/browser-harness`
- 已核对 commit：`afbcc381b963040c19627d788e40c7e7663171ee`（`v0.1.13-24-gafbcc38`，2026-09-07）
- 当时版本：`browser-harness 0.1.13`，许可证 MIT
- 重取方式：`git clone https://github.com/browser-use/browser-harness.git "$(mktemp -d)/browser-harness"`

### 未验证项（必须真实 Chrome 冒烟确认）

- **输出像素上限。** 现实现用 PIL 缩到 2000px/边、4MB，CDP 无等价原生能力；`clip.scale` 是页面缩放因子（与 DPR 相乘），能否精确控制输出像素未实测。兜底：prepare 阶段把 viewport 限到 1000×1000。
- **Chrome 144+ 每连接授权弹窗。** 上游用 `mac-approve` 绕开前台弹窗，直连 CDP 会撞上，需确认降级方案。
- **事件路由。** `Target.attachToTarget` 使用 `flatten: true` 后事件带 `sessionId`，必须按 sessionId 过滤。
- **断连语义。** daemon 做了重连与 `cdp_disconnected` 处理，单进程客户端需明确「一次操作一连接」还是「长连接 + 重连」。

### 重写必须保持的等价行为

- 固定条件：`Emulation.setDeviceMetricsOverride` 锁 viewport / DPR；readiness 三重检查（`readyState` / `document.fonts.status` / 可见图片 `complete && naturalWidth > 0`）5 秒 deadline，超时降级为 `degraded` 并附 reasons。
- 不隐式副作用：capture 前后比对 URL、滚动位置与 target bounds，变化即记 reasons；保留 `allowTargetFailure` 分支语义。
- diagnostics：只收 `Runtime.consoleAPICalled`（`error` / `assert`）与 `Network.responseReceived`（`status >= 400`）/ `Network.loadingFailed`，上限 20 条，URL 截为 scheme + host，message 双重脱敏。
- target 归属：`close` 必须校验 URL 未变，防误关用户标签页。
- 进程边界：超时 30s、stdout 64KB / stderr 16KB 上限、SIGTERM 后 500ms SIGKILL；重写后改用 `AbortSignal`。

### 收尾事项

- `openspec/changes/add-local-visual-feedback-loop/proposal.md` 的 Impact 声明（「外部 `browser-harness` 命令」）与 `design.md` 术语需在 MVP 完成后同步修订。
- `src/visual-loop/config.ts` 的 `harnessPath` 字段在 Node 版中失去意义，属 breaking config 变更，需保留一个迁移期 diagnostic。
