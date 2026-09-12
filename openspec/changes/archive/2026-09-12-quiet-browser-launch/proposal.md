## Why

扩展在端点空闲时会自行启动一个专用 Chrome。该浏览器目前以**有头窗口**启动，于是每次会话第一次使用视觉工具都会弹出一个窗口并抢占前台焦点——在被观察页面属于用户日常工作流时（比如本地 dev server），这个弹窗是纯干扰。

同时，`visual-evidence` 的 `Observe an existing interaction state` 场景要求「用户已在绑定页面打开弹窗或改变滚动位置后再采集」，这隐含了一个用户看得见的窗口。因此「不弹窗」不能只当成启动参数问题——它决定了**用户是否还能参与这个回路**，必须显式声明而不是悄悄改变。

## What Changes

- 新增配置项 `launch`，取值 `"minimized"`（默认）、`"headless"`、`"windowed"`：
  - `minimized`：有头启动并立即最小化，附带防止被遮挡时渲染节流的参数。不干扰前台，用户需要时可恢复窗口手动操作页面。
  - `headless`：`--headless=new`，完全不出现窗口，但用户**无法**看到或操作页面。
  - `windowed`：当前行为，保留给调试。
- 未知取值 fail-closed（与现有 `cdpUrl` 校验风格一致），不静默回退到默认。
- 准备结果中**声明当前上下文的启动形态**，使模型能判断用户能否手动操作页面；无头形态下明确报告页面不可见。
- Chromium 系浏览器探测扩展：darwin 增加 Brave / Edge / Arc，Linux 增加 `microsoft-edge` / `brave-browser`；`XPI_VISUALOOP_CHROME` 仍为最高优先级的显式覆盖。
- 文档把「Chrome」措辞统一为「Chromium 系浏览器」，并说明三种启动形态对用户交互能力的影响。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `visual-evidence`: 扩展自有浏览器的启动形态成为可声明、可观测的行为，并明确它如何限制用户的交互能力。

## Impact

- 代码：`src/visual-loop/config.ts`（新增 `launch` 与 fail-closed 校验）、`src/visual-loop/chrome.ts`（启动参数与最小化调用）、`src/visual-loop/context.ts`（准备结果携带启动形态）、`src/index.ts`（`visual_prepare` 返回体字段）。
- 实现注意：`Browser.getWindowForTarget` / `Browser.setWindowBounds` 属于**浏览器级 session**，而现有 `CdpClient` 连接的是页面级 endpoint；需要额外一条浏览器级连接，并在 `disconnect` 中一并释放。
- 文档：`README.md` / `README.zh-CN.md` 的 Setup、Limits、Files 与回滚章节。
- 默认行为变更：**BREAKING**（启动形态从有头窗口改为最小化），需在 release note 中说明。
- 与 `add-visual-comparison` 无耦合，可独立发布。
