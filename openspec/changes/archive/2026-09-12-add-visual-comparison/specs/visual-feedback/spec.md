## MODIFIED Requirements

### Requirement: Image region and textual feedback

用户 SHALL 能在截图上框选一个矩形区域并输入非空文字意见；每次提交包含一个区域和一条意见。区域 SHALL 保存为所引用图像的原始像素坐标，并限制在图像范围内。区域 SHALL 记录它的产生方式（点选元素或拖动框选）。系统 SHALL 正确处理缩放、面板滚动、图像留白和反向拖动；零面积、非有限数值或越界数据 MUST 不被接收。反馈 SHALL 保留所引用图像和截图标识，不要求区域对应唯一页面元素。

#### Scenario: Submit after zooming

- **WHEN** 用户缩放或滚动面板后框选区域并提交意见
- **THEN** Agent 收到的区域对应原始图像中同一位置，不包含面板边距或显示缩放造成的偏移

#### Scenario: Comment on whitespace

- **WHEN** 框选区域是留白或无法取得元素信息的画布内容
- **THEN** 系统仍接收区域和文字，并明确没有确定的元素映射

#### Scenario: Invalid submission

- **WHEN** 用户提交空白意见、零面积区域，或面板消息包含非法坐标
- **THEN** 系统拒绝提交并显示可修正的提示，不向 Agent 发送半成品反馈

#### Scenario: Region produced by dragging declares its source

- **WHEN** 用户通过拖动框选提交区域
- **THEN** 该区域的产生方式记录为拖动，且结果 MUST 不声称它具有元素身份

### Requirement: Explicit submission and single delivery

面板 SHALL 区分提交、取消和关闭。只有用户明确提交的有效意见 SHALL 作为一次反馈交回请求该面板的 Agent 工具调用；打开、缩放、取消和关闭 MUST 不创建新的修改任务。对同一面板的重复提交 SHALL 最多交付一次；系统 SHALL 不自动修改项目代码。取消 SHALL 立即生效并返回未提交状态，MUST 不被解释成认可、拒绝或修改意见；取消生效后系统 SHALL 追问用户后续意图，并把「重新打开面板」「跳过这一步骤」「本轮不再询问」作为三种可区分的返回值交付，其中「本轮」的边界为一次检查上下文。

#### Scenario: Submit feedback

- **WHEN** 用户提交有效区域和意见
- **THEN** 工具结果返回 submitted 状态、截图引用、区域及意见，供 Agent 在当前任务中继续处理

#### Scenario: Close without submitting

- **WHEN** 用户关闭窗口、按取消键或取消工具调用
- **THEN** 系统返回 cancelled 状态，不把取消解释成认可、拒绝或修改意见

#### Scenario: Duplicate bridge message

- **WHEN** 同一面板因双击或重复消息发送两次提交
- **THEN** 只有第一次有效提交交付给 Agent，后续消息被忽略

#### Scenario: Cancel is followed by an explicit intent question

- **WHEN** 用户按取消键取消评审
- **THEN** 取消状态先被确定，随后面板询问用户是要重新打开、跳过还是本轮不再询问，并把用户的选择作为可区分的返回值交付

#### Scenario: Cancel question is itself escapable

- **WHEN** 取消追问出现后用户再次按取消键
- **THEN** 系统只关闭追问，回到面板并保持未提交状态，不把这次按键当作对追问的回答

#### Scenario: A suppressed round does not reopen the panel

- **WHEN** 用户已经选择「本轮不再询问」，同一检查上下文中再次请求打开反馈面板
- **THEN** 系统不打开面板，直接返回一个明确说明本轮已被抑制的结果，不把抑制当作取消或认可

## ADDED Requirements

### Requirement: Element picking as the primary region input

面板 SHALL 提供元素点选作为区域输入的首选方式：候选元素的边界与可识别名称 SHALL 可视化，用户 SHALL 能在不拖动鼠标的情况下在候选之间移动并确认其中一个。由点选产生的区域 SHALL 与其元素身份（选择器、角色、受限文本）一同记录；由拖动产生的区域 MUST 不附带元素身份。候选元素的识别信息 SHALL 来自被观察页面的实际结构，MUST 不要求页面提供 ARIA 标注，MUST 不向被观察页面注入调用方提供的脚本。

#### Scenario: Pick one element

- **WHEN** 用户在面板上指向一个元素并确认
- **THEN** 区域等于该元素的边界，反馈同时携带该元素的选择器、角色与受限文本

#### Scenario: Keyboard-only picking

- **WHEN** 用户只使用键盘操作面板
- **THEN** 用户能逐个移动候选元素、确认其中一个、提交或取消，且当前候选与焦点位置清楚可见

#### Scenario: Element without usable naming

- **WHEN** 候选元素既没有 ARIA 标注也没有可读文本
- **THEN** 系统仍按元素自身语义给出可区分的角色与位置标识，不把空的识别信息当作有效名称交付

#### Scenario: Picking does not depend on the page cooperating

- **WHEN** 被观察页面没有任何 ARIA 属性
- **THEN** 点选仍然可用，候选列表中的每项都有非空的可识别描述

### Requirement: Structured choice feedback

调用方 SHALL 能随面板请求提供一个问题与 2 至 4 个选项。提供时，面板 SHALL 以这些选项作为答案形式，用户的选择 SHALL 作为结构化答案返回，区域与文字意见在此形态下均为可选。系统 MUST 不把选项答案解释成视觉证据的变化、设计已通过或代码修改授权。选项内容 SHALL 按不可信数据处理。问题与选项 MUST 同时提供或同时缺省；只提供其一时系统 SHALL 拒绝该请求。

#### Scenario: Choose one option

- **WHEN** 调用方提供问题与选项，用户选择其中一项并提交
- **THEN** 工具结果返回已选择状态与该选项，且不需要区域或文字意见

#### Scenario: Choice is not an acceptance verdict

- **WHEN** 用户通过选项作答
- **THEN** 系统只报告用户选择了哪一项，不输出设计通过、视觉验收或代码修改结论

#### Scenario: Half a question is rejected

- **WHEN** 调用方只提供问题或只提供选项
- **THEN** 系统拒绝该请求并说明两者必须同时提供，不打开只展示一半信息的面板

### Requirement: Panel language

面板固定文案 SHALL 支持简体中文与英文，单次渲染 SHALL 使用同一种语言，MUST 不混用。调用方声明渲染语言时 SHALL 使用该语言；未声明时系统 SHALL 按会话环境推断并使用其中之一。调用方提供的问题、选项、标签与用户填写的内容 SHALL 原样呈现，系统 MUST 不翻译、不改写它们。

#### Scenario: Declared language renders all fixed text

- **WHEN** 调用方声明面板语言为英文
- **THEN** 标题、区块标题、按钮、提示与取消追问等全部固定文案均以英文呈现

#### Scenario: Caller text is never translated

- **WHEN** 面板语言与调用方提供的问题或选项所用语言不同
- **THEN** 问题与选项按原样显示，系统只翻译自身固定文案
