# visual-verification Specification

## Purpose
帮助用户和 Agent 检查局部修改前后的真实页面表现，将基准截图与修改后的新证据成对呈现，并说明两次观察是否满足比较条件。该能力提供可追溯的视觉复核材料，避免把像素变化或成功截图误解释成设计验收通过。

## Requirements

### Requirement: Verification references an immutable baseline

系统 SHALL 接受当前检查上下文中的有效基准截图标识，并在绑定页面重新采集一份新的证据作为修改后版本。复核 SHALL 复用基准的目标范围和检查条件，不修改或覆盖基准。复核 MUST 不自动导航、刷新、滚动、恢复交互步骤或修改项目代码；条件已变化时 SHALL 报告原因。

#### Scenario: Capture after a local code change

- **WHEN** 本地页面已呈现代码修改后的状态，用户或 Agent 使用基准截图请求复核
- **THEN** 系统创建新的截图标识，并返回引用基准与新证据的比较结果

#### Scenario: Baseline is expired

- **WHEN** 基准已过期、被清理或属于其他会话
- **THEN** 系统拒绝复核，不重新拍摄当前页面冒充修改前版本

### Requirement: Explicit comparability checks

每次复核 SHALL 输出 comparable 或 not-comparable 状态及原因。系统 SHALL 检查会话和检查上下文、页面与路由、视口、设备像素比、滚动位置、图像坐标转换、浏览器环境和显式声明的交互状态是否一致，并检查两次证据的就绪状态。目标样式或尺寸变化属于待观察结果，MUST 不仅因为目标变大或移动就拒绝比较；共同的视口坐标空间不一致或状态缺失时 MUST 不声称可比较。comparable 仅表示已检查条件一致，不表示全部应用数据相同。

#### Scenario: Compatible local captures

- **WHEN** 基准与新证据具有一致的检查条件且均未报告不稳定或缺失的必要条件
- **THEN** 系统返回 comparable，列出已核对的条件，并展示前后证据

#### Scenario: Viewport or interaction state changed

- **WHEN** 视口、设备像素比、滚动位置、路由或声明的交互状态与基准不一致
- **THEN** 系统返回 not-comparable 及具体差异，不偷偷重置页面以制造匹配

#### Scenario: Intended target layout changed

- **WHEN** 检查条件一致，但目标元素的间距、尺寸或位置因修改而改变
- **THEN** 系统把变化作为比较内容保留，在共同视口坐标中展示，不仅因目标边界改变而判定不可比较

#### Scenario: Readiness or target resolution failed

- **WHEN** 新页面持续变化、必要资源未就绪，或基准选择器已无法唯一定位
- **THEN** 系统返回 not-comparable 及原因；若有有效新截图则保留它供人工检查，不返回自动通过结论

### Requirement: Side-by-side evidence and bounded summaries

系统 SHALL 返回前后截图引用、可比较性、可用的目标边界与样式变化、以及各自独立的诊断摘要，并提供前后图的并排查看入口。局部比较 SHALL 保留共同坐标区域和裁切来源，使用户能区分目标变化与裁切偏移。首版 SHALL 不要求像素差异热图或变化比例，且 MUST 不依靠它们自动判断设计质量。

#### Scenario: Inspect a changed region

- **WHEN** 用户查看一组包含局部目标的复核结果
- **THEN** 前后图明确标注版本和目标区域，裁切使用共同坐标范围，并提供视口图供检查周边变化

#### Scenario: Diagnostics are incomplete

- **WHEN** 两次证据的诊断观察窗口不同或其中一项未采集
- **THEN** 系统分别展示其范围和缺失状态，不把缺失项参与“错误减少”的结论

### Requirement: User acceptance remains distinct from evidence collection

复核结果 SHALL 将技术采集状态与用户验收分开。系统 MUST 不因为图片相同、图片不同或采集成功就输出设计已通过。用户明确认可或继续提出意见时 SHALL 关联到比较结果及其中的截图版本；取消或关闭 SHALL 保留为未验收。

#### Scenario: Comparison succeeds without user review

- **WHEN** 复核成功生成可比较的前后证据，但用户尚未表达验收意见
- **THEN** 系统报告证据已就绪且用户未验收，不输出 PASS 或等同的设计通过状态

#### Scenario: User requests another adjustment

- **WHEN** 用户在比较面板中对修改后截图框选区域并提交新意见
- **THEN** 反馈引用修改后截图与该比较结果，不继续引用基准图上的旧坐标

#### Scenario: User accepts or cancels

- **WHEN** 用户明确点击认可，或直接关闭比较面板
- **THEN** 前者返回关联比较标识的用户认可，后者返回取消并保持未验收，两者不会混淆
