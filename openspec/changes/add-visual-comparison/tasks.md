## 1. 前置修复（独立提交，先于本变更落地）

- [x] 1.1 给面板的 `#before-image` 与 `#evidence-image` 加 `draggable="false"` 与 CSS `-webkit-user-drag: none`，并注册 `dragstart` 守卫；验证：新增单测把 `<img>` 数量与 `draggable="false"` 数量对齐，防止后续新增面板图片时静默回归
- [x] 1.2 该修复作为单条 `fix(visual-loop)` 提交落地（`1f59771`），不与本变更混提；验证：`git log --oneline -1` 只有该修复，且 `pnpm test` 全绿

## 2. 证据层：比较的模式与标签

- [x] 2.1 `Comparison` 增加必填 `mode: "regression" | "variant"` 与可选 `labels: [string, string]`，同步更新 `validateComparison` 与 `freezeComparison`；验证：新增 `tests/visual-loop-comparison-mode.test.ts` 覆盖 mode 必填、labels 必须是定长 2、非法值被拒
- [x] 2.2 `verify` 产出的比较声明 `mode: "regression"`；验证：`pnpm test` 全绿（104 passed），3 个既有夹具只补 `mode` 字段、未放宽任何断言

## 3. 比较原语

- [x] 3.1 `VisualLoopManager.compare(leftId, rightId, labels)` 组装比较并复用 `addComparison` 校验落库，`status` 取 `comparable`，可比性差异写入 `reasons` 作为信息；验证：`tests/visual-loop-compare.test.ts` 覆盖「两张不同 URL 的截图仍得 comparable 且 reasons 含 page URL changed」「任一侧不可用返回明确错误」，并用 `failAfter: 3` 陷阱 + `versionHits` 不变断言**未触发任何新采集或端点探测**
- [x] 3.2 `compare` 返回两侧完整视口图引用，不生成共同区域裁剪；验证：测试断言返回体含两条不同图像路径、`commonRegion` 为 undefined、两侧 capture 仍为 available
- [x] 3.3 `compare` 不要求 `stateLabel`，且无法覆盖 `mode`；验证：测试断言两侧声明不同交互状态时仍得 comparable 且 reasons 含该差异，并以参数个数断言不存在 mode/stateLabel 参数

## 4. 工具面

- [x] 4.1 注册 `visual_compare` 与 typebox 参数（`leftCaptureId` / `rightCaptureId` / `labels`），返回结构化结果加两张图像；验证：`tests/visual-loop-tool.test.ts` 断言工具已注册、参数校验生效（缺 id 被拒、额外字段被拒、labels 必须恰为 2 项）、返回值形状符合 spec；边界测试更新为五个只读工具且 CDP 白名单未变（该工具不发任何 CDP 方法）
- [x] 4.2 variant 两侧图像合计超预算时明确失败；验证：测试用两张各 `MAX_VERIFY_IMAGE_BYTES / 2 + 1` 字节的图构造超预算，断言抛出 `byte budget`，不静默只交付一侧
- [x] 4.3 `skills/xpi-visualoop/SKILL.md` 的 `description` 增加「在两个设计版本之间做选型」场景，并补 `visual_compare` 用法段与「变体比较不是回归检查」规则；验证：`scripts/trigger-eval.sh` 三例全部 PASS（正例 `visual_prepare` 调用数 2 与 1，负例 0）。**副作用见交付说明：负例 prompt 会让嵌套 agent 修改仓库**

## 5. 面板：结构化提问

- [x] 5.1 `FeedbackParameters` 增加 `question`（≤200）与 `options`（2–4 项、每项 ≤40），两者必须成对；验证：单测覆盖只提供其一时被拒绝（`feedbackQuestion` 抛 together）、`schema` 层拒绝 1 项与 5 项 options，且拒绝发生在打开面板之前
- [x] 5.2 `renderFeedbackPanel` 支持选项形态：渲染原生 radio 单选控件、该形态下 region 与 comment 均可选、`question` 与选项按数据转义渲染；验证：单测断言 HTML 含 `type="radio"` 与 `choiceMode = true`、注入的 `<script>` 与 `<img onerror>` 被转义、选项形态下无 `autofocus`，且**无选项时区域形态逐项不变**
- [x] 5.3 bridge 增加 `choice` 消息与 `chosen` 状态，`validateFeedbackBridgeMessage` 改为按面板形态决定合法消息集合；验证：单测覆盖 choice 仅在选项形态合法、空白答案被拒、选项形态下 submit 被拒、`accept` 仍仅在比较形态合法、choice 可携带可选区域与意见（仅两者齐全时生成 draft）
- [x] 5.4 比较形态的面板用 `labels` 指代两侧，variant 下按钮改为明确选择并说明选的是哪一张；验证：单测断言传入 labels 时图注与按钮使用 labels、variant 无 labels 时退化为不暗示先后的 Left/Right、regression 保持 Before/After 与 `Accept result`

## 6. 面板：点选元素

- [x] 6.1 内部目标脚本扩为候选集合（仅可见、面积超阈值、文档顺序、上限 N）并附 tag→role 映射；验证：新增 `tests/visual-loop-candidates.test.ts` **在 fixture DOM 上执行真实页面脚本**（`new Function`，边界测试只扫 `src/` 故允许），断言上限 60、不可见/过小/离屏被过滤、无任何 ARIA 时 role 与 selector 仍非空、selector 优先级（role > #id > data-testid > .class > tag）、文档顺序、只裁剪可见矩形
- [x] 6.2 采集结果携带候选列表并随面板输入一并交付；验证：`tests/visual-loop-cdp-actions.test.ts` 让伪造端点回吐 `MAX_CANDIDATES + 5` 条，断言 capture 恰好保留 `MAX_CANDIDATES` 条且首条字段通过校验；`tests/visual-loop-feedback.test.ts` 断言 `feedbackPanelInput` 原样透传候选（数量与顺序都不丢）
- [x] 6.3 面板渲染热点层与候选列表：悬停高亮并显示 `selector · role`，点击取该元素边界，键盘可在候选间移动并确认；验证：单测断言候选框按 `coordinateScale` 映射进图像像素（缩放到半则框减半），并以**真实渲染的面板**在浏览器里逐项实测：悬停显示 `#cancel-button · button`、点击热点使字段变为页面框 ×0.5、`↓` 同步焦点与选中、拖动 stage 画框并清空点选
- [x] 6.4 反馈记录区域来源与元素身份：点选携带 `selector` / `role` / `text`，拖动不带身份；验证：单测覆盖两种来源的返回体与记录差异（pick 带 target、drag 无 target、未知 source 被拒），并以真实面板实测提交载荷：点选得 `source:"pick"` + 三项 target，拖动得 `source:"drag"` 且无 target

## 7. 面板：语言与主题

- [x] 7.1 内联 `zh-CN` / `en` 文案表（38 条固定文案），语言由 `language` 参数声明、未声明时按运行时区域设置推断（`resolvePanelLanguage` 可注入 locale，便于测试）；验证：单测断言两种语言下每条文案非空、**短语级**跨语言不泄漏、选项/比较形态用同一语言，且调用方传入的中文 question/options 在 `language:"en"` 下原样呈现不被翻译
- [x] 7.2 面板 CSS 改为引用 token 变量（取值与原型 Palette A 一致）并补齐深/浅两套；验证：单测断言两套 token 都在、CSS 中无硬编码 hex、透明底控件用 `--foreground` 且全文不含 `--secondary-foreground`（把原型踩过的坑锁死）；另以真实面板在深/浅两种 token 下截图比对，标题、缩放按钮、候选列表、选项、字段标签、意见框与两个按钮均可见

## 8. 取消与追问

- [ ] 8.1 取消先落定，再在同一窗口内弹出追问，返回值携带 `reopenRequested` / `suppressForRound`；追问内再按 Esc 只关闭追问并回到面板保持未提交；验证：单测覆盖三种选择与追问内 Esc 四条路径的返回值
- [ ] 8.2 `suppressForRound` 边界为一次检查上下文，抑制期内再次请求不开面板并返回 `suppressed`，inspection 结束后恢复；验证：单测覆盖抑制期内调用与 inspection 结束后的恢复

## 9. 集成验收

- [ ] 9.1 真实交互验收（选型）：`prepare v1 → capture → prepare b1 → capture → prepare b2 → capture → visual_compare → visual_feedback(question, options)` 并选择 B1；验证：返回 `chosen: "B1"`，且两侧图像均出现在模型侧结果中（含日志/返回体证据）
- [ ] 9.2 真实交互验收（点选）：用点选取 `#save-button` 并提交；验证：区域等于该元素边界且反馈携带 `selector` / `role` / `text`
- [ ] 9.3 回归验收：`visual_verify` 的 `not-comparable` 行为未被污染；验证：对 URL 变化后的目标复核仍返回 `not-comparable` 且 `reasons` 含页面地址差异
- [ ] 9.4 门禁：`pnpm typecheck`、`pnpm -w run lint`、`pnpm test` 三条全绿；验证：三条命令输出全部通过，测试总数较变更前增加
- [ ] 9.5 文档同步：`README.md` 与 `README.zh-CN.md` 的工具表、预算章节与 Setup 说明更新；验证：README 中列出的工具数量与代码实际注册数量一致
