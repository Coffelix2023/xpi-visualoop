# 视觉选型比较接入验证记录

变更：`add-visual-comparison`
记录时间：2026-09-12T00:26:16Z
验证平台：Darwin 26.6.2 arm64

实际版本：

- Node.js `v24.20.0`、pnpm `12.3.4`
- Pi `0.85.1`、`@earendil-works/pi-coding-agent` `0.84.4`
- Glimpse（`glimpseui`）`0.8.1`
- Chrome `152.0.7977.84`

验证方式：扩展按 `~/.pi/agent/settings.json` 里的本地路径包加载，源码改动用 `/reload` 热载；面板是真实 Glimpse 窗口，操作由人工在窗口内完成。复现页面放在
`~/.cache/xpi-accept/{v1,b1,b2,settings}.html`，由
`python3 -m http.server 8765 --bind 127.0.0.1 --directory ~/.cache/xpi-accept` 提供；采集参数统一为 viewport `1000×700`、`dpr: 1`。

## 9.1 选型链路（variant + 结构化提问）

`reload` 后的一次完整链路：

- `visual_prepare http://127.0.0.1:8765/b1.html` → `inspection-mtxmnczp-14558jr1`，target `D324AE1E9E1CC4E8692A197517377A9F`
- `visual_capture` → `capture-mtxmpnf6-a7kn6oux`（B1 页）
- `visual_prepare http://127.0.0.1:8765/b2.html` + `visual_capture` → `capture-mtxmpqe4-7quzlp1h`（B2 页）
- `visual_compare {left: B1, right: B2, labels: ["B1 紧凑版","B2 宽松版"]}` →

```json
{"afterCaptureId":"capture-mtxmpqe4-7quzlp1h","beforeCaptureId":"capture-mtxmpnf6-a7kn6oux","comparisonId":"comparison-mtxmprpg-fb2b7rpq","labels":["B1 紧凑版","B2 宽松版"],"mode":"variant","status":"comparable","reasons":["page URL changed"]}
```

同一结果文本还带回两侧图像：

```text
left viewport: capture-mtxmpnf6-a7kn6oux · B1 紧凑版
right viewport: capture-mtxmpqe4-7quzlp1h · B2 宽松版
```

模型侧因此拿到两张图（B1 蓝色紧凑版、B2 绿色宽松版），与面板展示的是同一对图，没有出现「用户看得到、模型看零张」的不一致。`reasons` 里的页面地址差异是信息，不是拒绝理由（`status` 仍为 `comparable`）。

- `visual_feedback {comparisonId, question: "两个版本选哪个？", options: ["B1 紧凑版","B2 宽松版","两版都还要改"]}`，用户在面板选择 `B1 紧凑版` →

```json
{"afterCaptureId":"capture-mtxmpqe4-7quzlp1h","beforeCaptureId":"capture-mtxmpnf6-a7kn6oux","comparisonId":"comparison-mtxmprpg-fb2b7rpq","choice":"B1 紧凑版","options":["B1 紧凑版","B2 宽松版","两版都还要改"],"question":"两个版本选哪个？","status":"chosen"}
```

结论：`chosen: "B1 紧凑版"`，选型结论以结构化 `choice` 交付，不再依赖解析自由文本。

## 9.2 点选元素（capture 形态）

`reload` 后（含下述缺陷 2 的修复）：

- `visual_prepare http://127.0.0.1:8765/settings.html` → `inspection-mtxn84wt-7cl96kjh`，target `0578FB31A37C818091EA91A14002F412`
- `visual_capture` → `capture-mtxn86hm-ifrsky4l`
- 用户悬停 `Save changes`（面板显示 `#save-button · button`）后点击并提交 →

```json
{"captureId":"capture-mtxn86hm-ifrsky4l","feedback":{"comment":"成功了","feedbackId":"feedback-fef55d48-7a4f-40de-982f-e26e72f53e77","region":{"height":34,"width":114,"x":347,"y":179},"source":"pick","target":{"role":"button","selector":"#save-button","text":"Save changes"}},"status":"submitted"}
```

结论：区域等于该元素在图像坐标系中的边界，`source: "pick"`，且反馈携带 `selector` / `role` / `text` 三项元素身份。

### 缺陷 2 修复前的同一操作（对照）

同一 capture、同一操作，在修复前返回：

```json
{"feedback":{"comment":"点击之后,xy宽高的数值没有改变","region":{"height":1,"width":1,"x":0,"y":0},"source":"drag"},"status":"submitted"}
```

即默认 1×1 区域 + `source: "drag"`，点选完全未生效。

## 8.1 / 8.2 取消追问与抑制（真实面板补充验收）

- `visual_feedback {captureId}` → 用户在面板按 `Esc` → 面板内追问出现（重新打开面板 / 跳过这一步 / 本轮不再询问）→ 选择「本轮不再询问」 →

```json
{"captureId":"capture-mtxn86hm-ifrsky4l","reopenRequested":false,"suppressForRound":true,"status":"cancelled"}
```

即取消状态先落定，追问答案只是对同一 `cancelled` 的细化，没有把取消变成认可或拒绝。

- 同一 inspection 内立即再次 `visual_feedback {captureId}` → 面板**未打开**，调用即时返回：

```json
{"captureId":"capture-mtxn86hm-ifrsky4l","status":"suppressed"}
```

```text
The user chose not to be asked again this inspection round, so no panel was opened.
```

结论：「本轮」边界落在一次 inspection 上：抑制期内不再开面板，inspection 结束后（`disconnect` / `/reload`）自动恢复询问。

## 9.3 回归验收（`visual_verify` 未被污染）

- `visual_prepare http://127.0.0.1:8765/v1.html` + `visual_capture` → `capture-mtxmx3xk-24v6xgvf`
- `visual_prepare http://127.0.0.1:8765/settings.html`（同一 target 换地址）
- `visual_verify {baselineCaptureId: "capture-mtxmx3xk-24v6xgvf"}` →

```json
{"comparisonId":"comparison-mtxmx66f-bytvxgdu","mode":"regression","status":"not-comparable","reasons":["page URL changed"]}
```

结论：variant 的差异降级不影响回归口径，`visual_verify` 仍按既有严格判定返回 `not-comparable`。

## 验收中发现并修复的两个缺陷

1. **比较 + 结构化提问时出现两个答案通道**（commit `0a9a468`）：variant 比较叠加调用方 `options` 时，面板同时渲染 `Accept result` 与单选列表，而 bridge 在 choice 形态下拒绝 `accept`，点这个可见按钮会让整次调用失败（实测报 `accept is only valid for a comparison panel`）。修复为选项形态不渲染 accept 按钮。
2. **点选热点在真实面板里无效**（commit `007dd2d`）：`stage.setPointerCapture()` 把 `click` 重定向到捕获元素，热点自身的 `click` 监听器永远不触发。用独立 Chrome + `Input.dispatchMouseEvent` 三变体实测确认：

   | 变体 | 记录结果 |
   | --- | --- |
   | `setPointerCapture`（修复前面板逻辑） | `null`（热点 click 从未触发） |
   | 不调用 `setPointerCapture` | `"hotspot click"` |
   | `setPointerCapture` + `pointerup` 命中测试（修复后逻辑） | `"pointerup pick"` |

   修复后在 `pointerup` 做命中测试决定点选，位移超过 4 像素仍判为拖动，因此从热点上开始的拖动照旧画框。回归测试 `tests/visual-loop-panel-events.test.ts` 在 fixture DOM 上执行真实面板脚本并驱动浏览器同样的指针序列：未修复版本 2 个用例失败，修复后通过。

## 面板宿主 stderr 污染编辑器（独立修复 `3145155`）

每一轮面板操作中偶发出现的日志行 `glimpse[PID:…] error messaging the mach port for IMKCFRunLoopWakeUpReliable` 不是本扩展的业务错误，而是 macOS InputMethodKit 由 Glimpse 原生窗口进程写入 **stderr** 的噪声：`glimpseui` 用 `stdio: ["pipe", "pipe", "inherit"]` 启动宿主进程，stderr 继承自 Pi 主进程，于是这行日志写进 TUI、盖住用户输入编辑器。

修法（与 `xpi-model-cfg` 同源，不修改 `node_modules/glimpseui`，依赖升级不会丢失）：

- 首次加载 Glimpse 模块时，用 `import.meta.resolve` 拿到模块自身路径，取同级 `glimpse` 原生二进制，生成一行包装脚本 `exec <real> "$@" 2><log>`。
- 只在 `open()` 期间设置 `GLIMPSE_BINARY_PATH` 指向包装脚本，调用结束（正常或抛错）立即恢复原值，避免影响其他扩展与后续窗口。
- 调用方自己声明的 `GLIMPSE_BINARY_PATH` / `GLIMPSE_HOST_PATH` 优先，不覆盖；只在 macOS 生效（同一 override 会翻转 `glimpseui` 的 `supportsOpenLinks` 判定，对 Linux 宿主不成立）；模块旁没有原生二进制时（Linux/Chromium 后端）不做处理。
- 日志每次启动覆盖写，保留诊断但不会无限增长。

验证：

- 真实 shell 实测：包装脚本运行后调用方 stderr 为 `0` 字节，宿主 stderr 落入日志文件，参数照常透传。
- 真机路径核对：模块同级二进制存在（`~/.pi/agent/npm/node_modules/glimpseui/src/glimpse`），生成的包装脚本为 `0755` 且指向该二进制。
- 单测 4 条（`tests/visual-loop-feedback.test.ts`）：包装脚本内容、`open()` 期间设置与环境恢复（含抛错路径与既有值保留）、无可静默对象时返回 `null`、真实临时模块生成可执行包装脚本。测试总数因此由 141 增至 145。
- 现场实证：`/reload` 后开一次面板，包装脚本于 08:35 重新生成，宿主噪声于 08:36:12 落入 `$TMPDIR/xpi-visualoop-glimpse/glimpse-stderr.log`（107 字节）：

  ```text
  2026-09-12 08:36:12.639 glimpse[31330:126706] error messaging the mach port for IMKCFRunLoopWakeUpReliable
  ```

  同一时刻 Pi 输入框未再出现该行（人工确认），即原先写进 TUI 的 stderr 已被改道。

## 9.4 门禁

在全部改动落地后执行：

```text
pnpm typecheck   → 通过
pnpm -w run lint → 0 errors、0 warnings、5 infos（与变更前基线一致）
pnpm test        → 18 passed | 2 skipped（测试 141 passed | 6 skipped）
再跑一次（含面板宿主 stderr 修复与新增 4 条单测）→ 145 passed | 6 skipped
```

测试数由变更前的 133 passed（6 skipped）增加到 145 passed（6 skipped）。

## 9.5 文档同步

`src/index.ts` 实际注册 5 个工具；README 两张工具表各 5 行，逐项与代码一致（脚本核对输出）：

```text
registered: 5 visual_capture visual_compare visual_feedback visual_prepare visual_verify
README.md: 5 … match=true
README.zh-CN.md: 5 … match=true
```

同时更新：`visual_compare` 的 variant 语义与 `labels`、面板的选项形态与取消追问、预算章节改为 `visual_verify` 与 `visual_compare` 共用、Setup 增加 Glimpse 可选依赖与面板语言说明；`skills/xpi-visualoop/SKILL.md` 补齐第五个工具与 `chosen` / `suppressed` 返回值。

## 已知限制与环境陷阱

- 面板验收依赖人工点击 Glimpse 窗口，单测无法覆盖真实窗口的焦点与事件语义；上述两个缺陷正是只有真实交互才能暴露的。
- 页面服务中断时，`visual_prepare` 会把 Chrome 错误页当成页面地址，抛出 `url must use http or https`，错误信息与「URL 非法」无法区分。后续可把「导航后落到非目标协议」单独报错。
- `/reload` 是否生效可用 `inspectionId` / `targetId` 是否变化判断；未生效时面板与源码不一致，会误导验收结论。
- 验证使用扩展自起的 Chrome（headless 启动路径未经本次改动），未覆盖 Fedora Linux 与 WebKitGTK。
