## Purpose

让用户直接在真实页面截图上表达局部修改意见，并将区域、文字和原始视觉证据一同交回 Agent。该能力保证用户看到的版本就是反馈引用的版本，区分提交与取消，并阻止旧窗口或重复操作向错误的 Pi 会话发送意见。

## ADDED Requirements

### Requirement: Review an identified capture

系统 SHALL 通过有效截图标识打开反馈面板，展示该截图、页面摘要、采集时间和已知限制。用户 SHALL 能缩放和查看局部；面板 MUST 不加载或执行被观察页面的原始内容。打开面板本身 SHALL 不导航浏览器、不重新采集，也不提交修改请求。

#### Scenario: Open an existing capture

- **WHEN** 用户或 Agent 请求检查当前会话中的有效截图
- **THEN** 面板显示该截图的固定版本及其摘要，页面随后变化不会替换面板中的图像

#### Scenario: Unavailable capture

- **WHEN** 截图标识不存在、已过期或所属会话不同
- **THEN** 系统返回不可用原因，不打开显示另一张截图的面板

### Requirement: Image region and textual feedback

用户 SHALL 能在截图上框选一个矩形区域并输入非空文字意见；每次提交包含一个区域和一条意见。区域 SHALL 保存为所引用图像的原始像素坐标，并限制在图像范围内。系统 SHALL 正确处理缩放、面板滚动、图像留白和反向拖动；零面积、非有限数值或越界数据 MUST 不被接收。反馈 SHALL 保留所引用图像和截图标识，不要求区域对应唯一页面元素。

#### Scenario: Submit after zooming

- **WHEN** 用户缩放或滚动面板后框选区域并提交意见
- **THEN** Agent 收到的区域对应原始图像中同一位置，不包含面板边距或显示缩放造成的偏移

#### Scenario: Comment on whitespace

- **WHEN** 框选区域是留白或无法取得元素信息的画布内容
- **THEN** 系统仍接收区域和文字，并明确没有确定的元素映射

#### Scenario: Invalid submission

- **WHEN** 用户提交空白意见、零面积区域，或面板消息包含非法坐标
- **THEN** 系统拒绝提交并显示可修正的提示，不向 Agent 发送半成品反馈

### Requirement: Explicit submission and single delivery

面板 SHALL 区分提交、取消和关闭。只有用户明确提交的有效意见 SHALL 作为一次反馈交回请求该面板的 Agent 工具调用；打开、缩放、取消和关闭 MUST 不创建新的修改任务。对同一面板的重复提交 SHALL 最多交付一次；系统 SHALL 不自动修改项目代码。

#### Scenario: Submit feedback

- **WHEN** 用户提交有效区域和意见
- **THEN** 工具结果返回 submitted 状态、截图引用、区域及意见，供 Agent 在当前任务中继续处理

#### Scenario: Close without submitting

- **WHEN** 用户关闭窗口、按取消键或取消工具调用
- **THEN** 系统返回 cancelled 状态，不把取消解释成认可、拒绝或修改意见

#### Scenario: Duplicate bridge message

- **WHEN** 同一面板因双击或重复消息发送两次提交
- **THEN** 只有第一次有效提交交付给 Agent，后续消息被忽略

### Requirement: Session and panel lifecycle integrity

反馈面板 SHALL 绑定创建时的会话、检查上下文和截图版本。会话切换、扩展重载、断开检查上下文或取消操作后，旧面板 SHALL 失效并结束等待。系统 MUST 不把旧面板消息交给新会话。系统 SHALL 在同一会话中最多保留一个等待提交的反馈面板，后续请求明确返回忙碌状态。

#### Scenario: Switch session while reviewing

- **WHEN** 用户在反馈面板打开期间切换 Pi 会话
- **THEN** 旧面板被关闭或失效，迟到提交不会进入新会话

#### Scenario: Request another panel

- **WHEN** 同一会话已有等待提交的反馈面板，又请求打开另一张截图
- **THEN** 系统返回 busy 状态和已有面板的截图引用，不静默替换用户正在填写的意见

### Requirement: Accessible interaction and explicit fallback

图形反馈面板 SHALL 支持可见焦点、键盘提交与取消，并提供不依赖鼠标拖动的区域输入方式。动态文本 MUST 作为数据转义。图形窗口不可用但 Pi 支持对话时，系统 SHALL 提供标明降级状态的文字反馈，保留截图路径和引用，以整图作为明确的反馈范围；没有对话界面时 SHALL 返回 unavailable，不伪造用户意见。基础截图采集 SHALL 不依赖图形面板可用。

#### Scenario: Keyboard-only feedback

- **WHEN** 用户只使用键盘查看和填写反馈
- **THEN** 用户能输入或调整区域坐标、填写意见、提交或取消，焦点位置清楚可见

#### Scenario: Native window unavailable

- **WHEN** 图形窗口无法打开但 Pi 对话可用
- **THEN** 系统提示当前为整图文字反馈，展示截图路径并允许明确提交或取消，不声称提供了框选体验

#### Scenario: No interaction surface

- **WHEN** 当前运行环境没有可用的用户对话界面
- **THEN** 反馈工具返回 unavailable，保留证据引用，不自动提交空意见
