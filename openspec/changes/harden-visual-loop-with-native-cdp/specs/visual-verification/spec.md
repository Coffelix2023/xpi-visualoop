## MODIFIED Requirements

### Requirement: Explicit comparability checks

每次复核 SHALL 输出 comparable 或 not-comparable 状态及原因。系统 SHALL 检查会话和检查上下文、页面与路由、视口、设备像素比、滚动位置、图像坐标转换、浏览器环境和显式声明的交互状态是否一致，并检查两次证据的就绪状态。目标样式或尺寸变化属于待观察结果，MUST 不仅因为目标变大或移动就拒绝比较；共同的视口坐标空间不一致或状态缺失时 MUST 不声称可比较。comparable 仅表示已检查条件一致，不表示全部应用数据相同。基准已声明交互状态而调用方未显式声明时，系统 SHALL 拒绝复核并说明需要显式声明，MUST 不沿用基准的声明假定状态未变。可比性判定 SHALL 由单一判据产生，同一次复核的所有输出面 MUST 报告同一结论。

#### Scenario: Compatible local captures

- **WHEN** 基准与新证据具有一致的检查条件且均未报告不稳定或缺失的必要条件
- **THEN** 系统返回 comparable，列出已核对的条件，并展示前后证据

#### Scenario: Viewport or interaction state changed

- **WHEN** 视口、设备像素比、滚动位置、路由或声明的交互状态与基准不一致
- **THEN** 系统返回 not-comparable 及具体差异，不偷偷重置页面以制造匹配

#### Scenario: Baseline declared a state and the caller did not

- **WHEN** 基准已声明交互状态，调用方请求复核时未显式声明交互状态
- **THEN** 系统拒绝复核并说明需要显式声明该状态或确认状态未变，不生成比较结果

#### Scenario: Intended target layout changed

- **WHEN** 检查条件一致，但目标元素的间距、尺寸或位置因修改而改变
- **THEN** 系统把变化作为比较内容保留，在共同视口坐标中展示，不仅因目标边界改变而判定不可比较

#### Scenario: Readiness or target resolution failed

- **WHEN** 新页面持续变化、必要资源未就绪，或基准选择器已无法唯一定位
- **THEN** 系统返回 not-comparable 及原因；若有有效新截图则保留它供人工检查，不返回自动通过结论

### Requirement: Side-by-side evidence and bounded summaries with explicit budgets

系统 SHALL 返回前后截图引用、可比较性、可用的目标边界与样式变化、以及各自独立的诊断摘要,并提供前后图的并排查看入口。局部比较 SHALL 保留共同坐标区域和裁切来源,使用户能区分目标变化与裁切偏移。首版 SHALL 不要求像素差异热图或变化比例,且 MUST 不依靠它们自动判断设计质量。默认返回 SHALL 只包含共同坐标区域的前后图;视口整图 SHALL 仅在调用方显式请求时返回。结构化比较结果的文本 SHALL 受与采集结果相同的 **modelPayloadBudget**(16 KiB)约束。默认返回内容 SHALL 使图像总量保持在 **evidenceDiskBudget**(单次 4 MiB)内,超出时 SHALL 裁剪默认内容或明确失败。
#### Scenario: Inspect a changed region

- **WHEN** 用户查看一组包含局部目标的复核结果
- **THEN** 前后图明确标注版本和目标区域，裁切使用共同坐标范围，并提供视口图供检查周边变化

#### Scenario: Default output stays within budget

- **WHEN** 用户请求一次普通复核而未显式要求视口整图
- **THEN** 系统默认只返回共同区域的前后图，图像总量与结构化结果均处于既定预算内

#### Scenario: Caller explicitly requests full viewport images

- **WHEN** 调用方显式要求返回视口整图
- **THEN** 系统返回视口整图，并在超预算时按既定规则裁剪或明确失败，不静默截断数据

#### Scenario: Diagnostics are incomplete

- **WHEN** 两次证据的诊断观察窗口不同或其中一项未采集
- **THEN** 系统分别展示其范围和缺失状态，不把缺失项参与“错误减少”的结论
