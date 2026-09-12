## Context

- `EvidenceStore.addComparison` 已经接受任意两张同一 epoch 的截图，只校验存在性；底层**不需要新结构**。缺的只是"谁有权调用它"——目前唯一调用点在 `context.ts` 的 `verify` 内。
- 面板是 `src/visual-loop/feedback.ts` 里的一个 HTML 字符串常量，运行在 Glimpse webview。仓库**无构建步骤**，且不能假设 webview 联网。
- 回传通道：面板内 `window.glimpse.send(msg)` → Glimpse `message` 事件 → `validateFeedbackBridgeMessage`。bridge 目前只接受 `submit` / `cancel` / `accept`。
- 坐标映射已存在且已被 `visual_feedback` 复用：`displayRegionToImageRegion` + `image.sourceRegion` + `image.coordinateScale`。新输入方式必须复用它，不得自算。
- `resolveTarget` 已用扩展自有的内部脚本枚举元素并返回 `bounds` / `visibleBounds` / `styles` / `accessibility` / `text`，`accessibility` 只读 HTML 属性。
- 已知约束：`visual_verify` 在 `not-comparable` 时不产出共同区域，因此也不向模型返回任何图像——而同一份比较在面板里仍会展示两张图。

## Goals / Non-Goals

**Goals:**

- 把"两张既有证据的比较"变成一等操作，且不新增存储结构、不新增往返。
- 让面板能提出一个问题并收回一个结构化答案，使选型结论不再依赖解析自由文本。
- 让区域输入在不使用鼠标拖动的前提下可用，并使区域携带元素身份。
- `regression` 路径、既有 97 个测试、以及 `visual-verification` 的可比性契约保持不变。

**Non-Goals:**

- 3 张以上的并排网格与变体切换快捷键（MVP 定长 2）。
- 像素差异热图或变化比例。
- 选型结论的落盘／决策记录（`disconnect` 清空临时目录是刻意的隐私边界）。
- "严格比较两张既有截图"的入口（见 D1）。
- 引入构建步骤、新运行时依赖、新监听端口。

## Decisions

### D1. `mode` 由产生比较的操作决定，不是调用方参数

- 选择：`visual_verify` → `regression`，新的 `visual_compare` → `variant`；`Comparison.mode` 是记录事实的字段，调用方无法覆盖。
- 备选与理由：把 `mode` 做成参数（或做成 `ignoredConditions` 那种忽略清单）等于让调用方自己关掉可比性判定——这是被明确否掉的设计，因为它会让"可比性是判定的、不是假设的"这条产品主张失效。工具名即语义，更少可用错的面。
- 代价：没有严格比较两张既有截图的入口。记为非目标。

### D2. `visual_compare` 不重新截图，直接组装

- 取值两张 capture → 组装 `Comparison` → 走既有 `addComparison` 校验落库。
- 备选：泛化 `verify`（会把"重新采集"这条职责混进纯比较），或新增 `ComparisonStore`（重复已存在的 epoch/存在性校验）。

### D3. variant 的差异降级为信息，`status` 保持两态

- `compareCaptureConditions` **不修改**：它是回归路径的单点判据，改它会同时污染 `verify`。
- `compare()` 在 variant 下把该判据的输出写进 `reasons`（信息），`status` 直接取 `comparable`。
- 备选：新增 `status: "variant"`（被否：面板文案、模型消费方、`validateComparison` 枚举、97 个测试与 `visual-verification` 契约全部要改三态，收益只是措辞更显式）。

### D4. variant 返回两侧的完整视口图，不做共同区域裁剪

- 选型比的是整体版式，裁剪反而丢信息；同时避开对 `target` 边界与 `commonViewportRegion` 的依赖（variant 的两侧通常没有 selector target）。
- 预算：沿用既有单次 4 MiB 图像预算与"超预算明确失败"的规则，不新增规则。
- 备选：复用 `commonViewportRegion` 对齐共同区域（被否：对整页选型无意义，且把回归的裁剪机器拖进新路径）。

### D5. 面板 bridge 扩一个消息类型

- 消息：`submit` / `cancel` / `accept` / 新增 `choice`（携带 `choice` 字符串）。
- 返回状态：`submitted` / `accepted` / `cancelled` / 新增 `chosen` / 新增 `suppressed`。
- `validateFeedbackBridgeMessage` 目前用 `allowAcceptance` 布尔开关控制 `accept` 是否合法；改为由**面板形态**决定合法消息集合（选项形态只接受 `choice`/`cancel`，比较形态接受 `accept`/`submit`/`cancel`）。

### D6. 元素候选复用现有内部脚本，不新增往返

- 把该脚本从"一个 selector"扩成"候选集合"：只取可见且面积大于阈值的元素，按文档顺序取前 N 个，随采集结果一起存进 evidence；打开面板时随面板输入一并交付。
- `role` 由 tag→role 映射补齐（未知标签回退为标签名本身，保证非空），`text` 复用现有受限文本。
- 备选：新增一次 `Accessibility.getPartialAXTree` 往返取真实无障碍树（被否：多一次往返且对大页面更重；记为后续可换的实现细节，不影响 spec 的可观察行为）。

### D7. i18n 内联文案表

- `feedback.ts` 内两张文案表（`zh-CN` / `en`），语言由 `visual_feedback` 的新可选参数声明，未声明时按会话环境推断。
- 调用方传入的 `question` / `options` / `labels` 一律原样转义渲染，不翻译。
- 备选：面板不做 i18n（被否：面板是用户唯一的界面，语言不可选会在英文会话里产生混排）。

### D8. 手写 CSS 引用 token

- 面板 CSS 全部引用 `var(--token)`，token 值与 `docs/design/prototype/panel-prototype.html` 的 Palette A 一致；面板自行声明 `color-scheme` 与深/浅两套值。
- 备选：Tailwind（被否：仓库无构建步骤，且不能假设 Glimpse webview 联网；原型与实装的样式机制必须同源，否则原型失去验收基准的资格）。
- 注意：Palette A 的浅色 `--secondary-foreground` 在透明底控件上不可见，面板不得在透明底使用该变量（原型里已踩过）。

### D9. 取消追问是面板内的模态，不是关窗再开

- 取消先落定并返回 `cancelled`，随后在**同一窗口内**弹出追问。因此追问被 Esc 关闭时只关闭追问、回到面板且保持未提交，不会产生"取消了取消"的状态。
- 「本轮」边界 = 一次 inspection：管理器记住抑制标志，inspection 结束时清零；被抑制期间 `visual_feedback` 不开面板，直接返回 `suppressed`。

### D10. 面板尺寸沿用现状

capture 形态沿用现有尺寸，比较形态沿用 1280 宽；variant 不新开尺寸档位。

## Risks / Trade-offs

- [候选元素过多导致面板卡顿] → 可见 + 面积阈值 + 上限 N + 文档顺序；超限时明确标记截断，不静默丢弃。
- [tag→role 映射覆盖不全] → 未知标签回退为标签名，保证识别描述非空；后续可替换为无障碍树实现而不改 spec。
- [variant 返回两张整图可能超预算] → 沿用既有预算与明确失败；文档提示降低 dpr 或改用 selector 采集。
- [扩展 bridge 影响既有 cancellation 语义] → `validateFeedbackBridgeMessage` 的单次交付与 `cancelled` 语义加测试锁死，新增形态只在既有语义之上叠加。
- [Glimpse 不可用时的选项形态] → 复用 `ctx.ui.select`（它本身就是选项列表），这是唯一一处文本降级比图形面板更贴合的场景；但该路径下 `region` 不可用，只有选项答案。
- [回归风险] → 既有 97 个测试不得修改；新增测试覆盖 variant 组装、choice 通道、点选区域身份、取消追问返回值。

## Migration Plan

- 无持久化数据，无字段迁移。`Comparison` 只存在于会话内的临时证据目录。
- 回滚：移除新工具注册与面板新分支即可；`Comparison.mode` 为新增字段，回滚不残留。
- 分步顺序：① 原生图片拖拽修复（独立提交，前置）② `evidence.ts` 加 `mode`/`labels` ③ `context.ts` 加 `compare` ④ 注册 `visual_compare` 与 spec ⑤ 面板 question/options ⑥ 面板点选与元素身份 ⑦ i18n 与主题 ⑧ `scripts/trigger-eval.sh` 验证触发面。

## Open Questions

- 候选元素的上限 N 与面积阈值的具体取值：可在实现时按实测调整，不影响 spec 与任务拆分。
