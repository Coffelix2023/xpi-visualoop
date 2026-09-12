## Why

当前版本只有一种比较：`visual_verify` 产出的「同一绑定目标的前后对比」。`comparisonId` 全仓只有一个产生点（`context.ts` 的 `verify`），所以「两个设计版本之间做选型」这件事没有原语可用——实测中只能拿回归检测工具冒充选型，API 自己返回 `not-comparable`（`reasons: ["page URL changed"]`），且该分支**不返回任何图像**。

同时，面板只有一种提问形式：框选一个矩形 + 自由文本。用户的真实结论因此塞进自然语言，模型必须解析它。实测证据：用户在 B1|B2 面板中选的是 **B1**，但工具只能返回 `status:"submitted"` + `comment:"通过"`，且 `afterCaptureId` 指向 **B2** —— 意图在通道里丢失。

区域输入本身也不可用：面板的 `<img>` 是浏览器原生可拖拽元素，按住左键一拖即启动原生图片拖拽并接管指针事件，框选收不到 `pointermove`。（该缺陷作为独立修复先行提交，本变更不重复承载。）

## What Changes

**新增对比原语**

- 新增 `visual_compare` 工具：把**任意两张已有截图**组成一个比较，**不重新截图**。复用既有 `EvidenceStore.addComparison` 的校验（同 epoch、两张 capture 均存在），不新增存储结构。
- `Comparison` 增加 `mode: "regression" | "variant"` 与可选 `labels: [string, string]`。
- **`variant` 模式下 URL、DPR、滚动位置等可比性差异降级为信息**，`status` 仍为 `comparable`；`regression` 路径与 `visual_verify` 行为**完全不变**（既有 97 个测试不得改动）。
- `variant` 模式不要求 `stateLabel`；`regression` 模式保持现有「基准已声明则调用方必须显式声明」的契约。
- MVP 只支持两张并排，`labels` 定长 2。

**面板支持结构化提问**

- `visual_feedback` 增加可选 `question`（≤200 字符）与 `options`（2–4 项，每项 ≤40 字符）；二者必须同时出现或同时缺省。
- 有 `options` 时 `region` 与 `comment` 变为**可选**，面板渲染单选控件，返回 `{ status: "chosen", choice }`。
- `Accept result` 在 `variant` 模式下改为明确的选择按钮，并在文案中标明选的是哪一张；`Before`/`After` 改用调用方传入的 `labels`。

**区域输入改为点选为主、拖拽兜底**

- 面板渲染元素热点：悬停高亮 + 显示 `selector · role`，点击即取该元素的 box。候选元素列表可键盘 `↑↓` 选择，满足「不依赖鼠标拖动的输入方式」。
- 反馈写入元素身份 `target: { selector, role, text }`；`region` 增加 `source: "pick" | "drag"` 以区分区域质量（点选有身份、拖拽没有）。
- 元素 `role` 由内部脚本的 tag→role 映射补齐——当前 `accessibility` 只读 HTML 属性，普通 `<button>` 的 `role` / `label` / `description` 三项全空。

**面板国际化与取消语义**

- 面板固定文案支持 `zh-CN` 与 `en`；调用方传入的 `question` / `options` / `labels` 由调用方按语言提供。
- `ESC` 等于取消：取消**立即**返回 `cancelled` 且不带任何意见；取消后追问用户是否重新打开面板，返回值附带 `reopenRequested` / `suppressForRound`。`suppressForRound` 的「本轮」边界定义为**一次 inspection**。

**面板外观**

- 采用项目 shadcn 风格 OKLCH token，**手写 CSS 引用 `var()`**（无构建步骤、离线可用），原型已落在 `docs/design/prototype/panel-prototype.html` 作为验收基准。

## Capabilities

### New Capabilities

- `visual-comparison`: 将两张既有视觉证据组成一次显式比较，区分「回归检测」与「设计选型」两种语义，并为选型提供结构化提问与答案通道。

### Modified Capabilities

- `visual-feedback`: 区域从必填改为「区域或结构化选择二者其一」；反馈可携带元素身份与区域来源；新增面板语言与取消后追问的返回值。

## Impact

- 代码：`src/index.ts`（新增工具与参数类型）、`src/visual-loop/context.ts`（新增 `compare`）、`src/visual-loop/evidence.ts`（`Comparison` 结构、`validateComparison`/`freezeComparison`）、`src/visual-loop/feedback.ts`（面板重写）、`src/visual-loop/cdp-actions.ts`（候选元素枚举与 tag→role 映射）。
- 触发面：`skills/xpi-visualoop/SKILL.md` 的 `description` 需增加「选型对比」场景，改该字段等同于改产品行为，**必须跑 `scripts/trigger-eval.sh` 验证**。
- 文档：`README.md` / `README.zh-CN.md` 的工具表与预算章节、`openspec/specs/visual-feedback/spec.md` 经 delta 更新。
- 不引入新运行时依赖；不引入构建步骤；不新增监听端口。
- 与 `quiet-browser-launch` 变更无耦合，可独立发布。
- 前置：面板 `<img>` 原生拖拽缺陷已作为独立修复先行提交。
