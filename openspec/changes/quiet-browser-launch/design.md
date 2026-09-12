## Context

- `src/visual-loop/chrome.ts` 的 `ensureEndpoint` 目前以**固定参数**直接 `spawn` 浏览器：`--remote-debugging-port` / `--user-data-dir` / `--no-first-run` / `--no-default-browser-check` / `about:blank`，`detached: false`、`stdio: "ignore"`；`stopOwnedChrome()` 用 `child.kill()`，`reapOnExit()` 在 Pi 退出时回收。进程所有权模型不变。
- `CdpClient` 连接的是**页面级** endpoint（`/json/list` 里某个 target 的 `webSocketDebuggerUrl`）。
- `Browser.getWindowForTarget` / `Browser.setWindowBounds` 需要**浏览器级** session，页面级连接上不可用。
- 配置目前只有 `cdpUrl` 与 `glimpseModulePath`，未知字段与非法值一律 fail-closed。
- 本轮已实测（Chrome 152 / macOS）：① `--headless=new` 下 `prepare` / `capture` / selector 抓取（含 `target.bounds`、`styles`、`text`）全部正常；② 有头启动后经 `Browser.setWindowBounds({ windowState: "minimized" })`，`prepare` + `capture` 仍得到正确的 900×560 渲染。

## Goals / Non-Goals

**Goals:**

- 默认启动形态不打断用户当前前台工作。
- 保留用户把窗口带入前台手动改变页面交互状态的能力（即 `visual-evidence` 的 `Observe an existing interaction state` 场景仍然成立）。
- 启动形态可声明、可观测，使模型能判断用户在此上下文中能否参与。
- 不把浏览器厂商写死。

**Non-Goals:**

- 不支持非 Chromium 系浏览器（Safari 走 WebKit Debug Protocol，Firefox 已弃用 CDP）。
- 不做"需要用户交互时自动把窗口带回前台"（记为后续增强）。
- 不记忆窗口尺寸与位置。
- 不改变"绝不使用用户日常 profile、绝不结束用户拥有的浏览器进程"这两条既有约束。

## Decisions

### D1. 默认形态取「有头最小化」，不取无头

- 理由：无头会**静默砍掉**一条既有能力——用户先在绑定页面里打开弹窗或滚动，再采集那个状态。`visual-evidence` 明确规定这条场景必须成立，而它要求窗口存在。
- 代价：进程仍在，用户能在 Dock 看到它。相对"弹窗抢焦点"，这是可接受的最小干扰。
- 备选：无头作默认（被否，能力回退且无提示）；有头可见作默认（被否，即当前问题）。

### D2. 最小化通过 CDP 窗口状态 API，而不是屏幕外坐标

- 用 `Browser.getWindowForTarget` + `Browser.setWindowBounds({ windowState: "minimized" })`。
- 理由：这是受支持的窗口状态接口，能读回真实 `windowState` 供断言与声明；`--window-position=-32000,-32000` 一类做法不改变窗口状态、在多显示器与不同平台上不可靠，且用户无从恢复。
- 备选：负坐标定位（被否，见上）。

### D3. 为窗口状态单独开一条浏览器级连接

- 用 `/json/version` 的 `webSocketDebuggerUrl` 开一条独立连接，**只**用于窗口操作，随 `disconnect` 与 `connect` 失败清理路径一并关闭。
- 理由：`Browser.*` 不能在页面 session 上调用；把浏览器级 session 混进 `CdpClient` 会污染它"单一页面连接"的职责与错误处理。
- 备选：`Target.attachToBrowserTarget` 在既有连接上复用（被否，同上）。

### D4. 启动形态写在准备结果上，不写在每次采集结果上

- 形态是**上下文属性**，`visual_prepare` 是上下文的起点，也是调用方唯一需要据此决定"要不要让用户去操作页面"的时机。

### D5. 配置键 `launch`，未知值 fail-closed

- 与既有 `cdpUrl` / `glimpseModulePath` 的校验风格保持一致：拼错的键名或非法取值一律拒绝，不静默回退默认。

### D6. 探测候选扩到 Chromium 系，显式覆盖保持最高优先级

- `XPI_VISUALOOP_CHROME` → darwin（Chrome / Chromium / Brave / Edge / Arc）→ linux（`google-chrome` / `google-chrome-stable` / `chromium` / `chromium-browser` / `microsoft-edge` / `brave-browser`）。
- 纯增量，且与 spec 的"不锁定厂商"一致。

## Risks / Trade-offs

- [最小化的窗口在部分平台或版本被节流，截图可能拿到陈旧帧或挂起] → 启动参数带 `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-features=CalculateNativeWinOcclusion`；若仍复现，退化路径是 `launch: "headless"`。本轮在 Chrome 152 / macOS 上已实测通过。
- [窗口状态设置存在启动竞态：进程刚起来时可能还没有可操作的窗口] → 设置动作放在端点就绪之后；失败**不使准备失败**，降级为"窗口状态未知"并如实声明，不假装已最小化。
- [浏览器级连接扩大了释放面] → 在 `disconnect` 与 `connect` 失败清理两条路径上都关闭，并用测试锁住"失败时不泄漏连接"。
- [默认行为变更属 BREAKING] → README 与 release note 明示；`launch: "windowed"` 一键回到旧行为。
- [最小化后用户找不到窗口] → 准备结果的声明中说明窗口已最小化以及如何恢复；自动恢复留作后续增强。

## Migration Plan

- 无持久化数据与字段迁移。
- 回滚：把 `launch` 显式设为 `"windowed"`（或删除该键并回退默认值）即恢复旧行为。
- 分步顺序：① `config.ts` 新键与校验 ② `chrome.ts` 启动参数与窗口状态（含浏览器级连接）③ 准备结果的形态声明 ④ 探测候选扩展 ⑤ 双语文档与 release note。

## Open Questions

- 「需要用户交互时自动把窗口带回前台」是否要做：本轮是非目标，不影响 spec 与任务拆分。
