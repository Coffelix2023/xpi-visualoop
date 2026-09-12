## Purpose

让用户与 Agent 能把同一检查上下文中的任意两张既有视觉证据组成一次显式比较，并区分「回归检测」与「设计选型」两种语义：前者回答「我的改动是否只改了预期的东西」，后者回答「这两个设计版本我要哪一个」。

## ADDED Requirements

### Requirement: Comparison of two existing captures

系统 SHALL 允许把当前检查上下文中任意两张有效截图组成一次比较，并返回新的比较标识。组成比较 MUST 不重新截图、不导航、不刷新、不滚动、不改变页面状态。两张截图 SHALL 属于同一会话与同一检查上下文；任一张不存在、已过期或属于其他上下文时 MUST 返回明确错误，且 MUST 不改用重新采集来替代。

#### Scenario: Combine two captured versions

- **WHEN** 检查上下文中存在两张有效截图，用户或 Agent 请求把它们组成一次比较
- **THEN** 系统返回新的比较标识，引用这两张既有截图，并保持两张截图各自不可变

#### Scenario: One side is unavailable

- **WHEN** 请求中的某一张截图不存在、已过期或属于其他会话
- **THEN** 系统返回明确错误，不重新采集，不用当前页面冒充缺失的一侧

#### Scenario: No page state is touched

- **WHEN** 组成比较被调用时页面正处于某个交互状态
- **THEN** 页面地址、滚动位置、视口与交互状态保持不变，被观察页面不收到任何输入

### Requirement: Comparison mode states the intent

每次比较 SHALL 声明 `mode`，取值为 `regression`（同一目标的修改前后）或 `variant`（两个设计版本）。`mode` 由产生该比较的操作决定，调用方 MUST 不能覆盖它。`mode` SHALL 出现在返回给模型的结构化结果与展示给用户的面板中。

#### Scenario: Regression comparison

- **WHEN** 比较由基准截图的再次采集产生
- **THEN** 系统声明 `mode: "regression"`，可比性判定沿用既有严格口径

#### Scenario: Variant comparison

- **WHEN** 比较由两张既有截图组成
- **THEN** 系统声明 `mode: "variant"`，调用方无法把它改成 `regression`

### Requirement: Variant comparisons keep differences as information

`variant` 模式下，页面地址、设备像素比、滚动位置等条件差异 SHALL 记入差异列表作为信息，`status` SHALL 仍为可比较；系统 MUST 不因这些差异拒绝比较，也 MUST 不隐藏它们。`regression` 模式的可比性判定 MUST 保持原有行为不变。

#### Scenario: Two versions served from different URLs

- **WHEN** 两张截图来自同一个检查上下文中不同的本地页面地址
- **THEN** 系统返回可比较状态，并在差异列表中说明页面地址不同，且不把该差异当作拒绝理由

#### Scenario: Regression path is untouched

- **WHEN** 同一目标在页面地址、视口或滚动位置变化后被复核
- **THEN** 系统仍按既有口径返回不可比较及具体差异

### Requirement: Variant comparisons do not require an interaction-state declaration

`variant` 模式下系统 MUST 不要求调用方声明交互状态。`regression` 模式下，基准已声明交互状态而调用方未声明时 SHALL 继续拒绝复核。

#### Scenario: Variant comparison without a state label

- **WHEN** 两张既有截图的任一侧声明过交互状态，调用方请求组成 `variant` 比较时未声明状态
- **THEN** 系统仍完成比较，不因缺少状态声明而拒绝

#### Scenario: Regression still demands the declaration

- **WHEN** 基准声明过交互状态，调用方请求复核时保持沉默
- **THEN** 系统拒绝复核并要求显式声明

### Requirement: A variant comparison returns both sides as evidence

无论状态为何，`variant` 比较 SHALL 在返回给模型的结果中提供所比较的两张图像，并在图像与文本预算内保持这一事实；系统 MUST 不出现「用户能在面板中看到两张图，而模型收到零张图」的不一致。超出预算时 SHALL 明确失败或按既定规则裁剪，MUST 不静默丢弃其中一侧。

#### Scenario: Both sides reach the model

- **WHEN** `variant` 比较完成且两张图像合计处于预算内
- **THEN** 模型收到两张图像与结构化结果，面板展示同一对图像

#### Scenario: Over budget

- **WHEN** 两张图像合计超出单次返回的图像预算
- **THEN** 系统明确报告超预算并按既定规则裁剪或失败，不静默只给出一侧

### Requirement: Caller-provided labels replace regression vocabulary

调用方 SHALL 能为比较的两侧提供标签（定长两项）。面板与模型输出 SHALL 使用这些标签指代两侧，MUST 不把 `variant` 比较的两侧称为「修改前 / 修改后」。未提供标签时，系统 SHALL 使用明确中性的标签，且 MUST 不暗示先后或因果。

#### Scenario: Labels are provided

- **WHEN** 调用方为 `variant` 比较提供两个标签
- **THEN** 面板与结构化结果中的两侧均以这些标签标识

#### Scenario: Labels are absent

- **WHEN** 调用方未提供标签
- **THEN** 系统使用中性标签，且不把两侧描述成时间上的前后关系
