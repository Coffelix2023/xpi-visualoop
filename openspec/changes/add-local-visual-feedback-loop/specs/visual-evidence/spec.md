## Purpose

为 Agent 与用户提供来自本地开发页面的可引用视觉事实，将截图、采集时的页面状态和辅助定位信息绑定到同一份不可变证据。该能力让局部意见具有明确的坐标和会话归属，并在浏览器不稳定或信息缺失时诚实报告限制。

## ADDED Requirements

### Requirement: Explicit local browser preparation

系统 SHALL 仅连接用户明确配置的专用本地浏览器端点，并将页面准备与观察分开。页面准备 SHALL 明确指定本地页面地址和视口；它可以创建扩展拥有的标签页、导航和设置视口。采集 SHALL 不隐式导航、滚动、调整视口、点击、输入或选择另一个标签页。连接失败 MUST 不回退到用户日常浏览器或云浏览器。

#### Scenario: Prepare a local page

- **WHEN** 用户已配置专用本地端点并显式请求准备一个受支持的本地页面
- **THEN** 系统在扩展拥有的标签页中打开页面，记录绑定的页面和实际视口，并返回准备结果

#### Scenario: Observe an existing interaction state

- **WHEN** 用户已在绑定页面打开弹窗或改变滚动位置并请求采集
- **THEN** 系统采集当前状态，不刷新页面、不重置滚动、不关闭弹窗

#### Scenario: Endpoint or target is unavailable

- **WHEN** 端点不可达、绑定标签页已关闭，或页面已离开允许的本地范围
- **THEN** 系统返回明确失败及恢复提示，不改用其他标签页或浏览器

### Requirement: Immutable capture identity and coordinate metadata

每次成功采集 SHALL 生成唯一且不可覆盖的截图标识，关联当前 Pi 会话和检查上下文，并包含采集时间、页面地址、标题、实际视口、设备像素比、滚动位置、图像像素尺寸，以及截图覆盖区域到页面坐标的转换信息。系统 SHALL 将显示缩放与原始图像坐标区分。返回给模型的截图、展示给用户的截图和反馈引用 MUST 来自同一份证据。

#### Scenario: Repeated captures

- **WHEN** 对同一页面连续采集两次
- **THEN** 两次返回不同标识和独立图像，第二次不覆盖第一次，之前的反馈仍指向原图

#### Scenario: Resized image

- **WHEN** 截图为满足图像大小限制而等比缩小
- **THEN** 证据记录实际图像尺寸与坐标转换，后续反馈不把显示像素误当成页面像素

### Requirement: Localized evidence with honest target resolution

系统 SHALL 支持当前视口截图，以及可选选择器指向的可见局部证据；局部图 SHALL 从该次视口图派生。指定目标必须唯一匹配；不存在、多重匹配或位于视口外时 SHALL 返回具体目标错误，不自动选择第一个结果或滚动。可用的辅助信息 SHALL 包含元素边界、受限文本与无障碍信息、相关布局和视觉计算样式。系统 MUST 不将区域或选择器声明为已经确定的源码位置。

#### Scenario: Visible unique target

- **WHEN** 选择器唯一匹配一个可见元素
- **THEN** 系统返回视口图、该图中目标可见部分的局部图、完整元素边界、实际裁切区域和受限样式信息

#### Scenario: Ambiguous or invisible target

- **WHEN** 选择器匹配多个元素或唯一元素完全位于视口外
- **THEN** 系统报告多重匹配或不可见，不猜测目标，也不改变页面状态

#### Scenario: Region without an element

- **WHEN** 用户关注的是留白、阴影或画布中的区域
- **THEN** 系统允许后续基于图像区域反馈，元素信息缺失不使有效截图失效

### Requirement: Bounded readiness and diagnostic coverage

采集 SHALL 在有限时间内等待文档、字体和当前可见图片达到可检查状态，并检测采集前后已知的页面或布局变化。超时、缺失资源或检测到变化时 SHALL 返回降级原因；无法获得有效图像时 SHALL 失败。系统 MUST 不以网络空闲推断页面已完成交互状态初始化，也不声称截图与所有结构信息原子同步。控制台错误和网络失败摘要 SHALL 独立于图像返回，并声明观察范围；未采集到的历史信息 MUST 不表示为“零错误”。

#### Scenario: A page with continuous network traffic

- **WHEN** 页面持续保持连接，但可见内容已加载且检查条件满足
- **THEN** 系统在期限内完成采集，不无限等待网络空闲

#### Scenario: Page changes during capture

- **WHEN** 采集前后检测到导航、滚动或目标布局变化
- **THEN** 系统将证据标记为不稳定并说明原因，不将定位信息标记为完全可靠

#### Scenario: Diagnostics were not observed

- **WHEN** 连接前的控制台历史或网络失败无法取得
- **THEN** 结果明确标记观察窗口及缺失项，不声称页面没有发生过错误

### Requirement: Bounded and trusted data handling

系统 SHALL 限制图像像素和字节数、结构化输出、文本、诊断条数、子进程输出及执行时间。项目配置 SHALL 仅在项目受信任时生效。页面文本、选择器、端点响应和外部工具输出 MUST 按不可信数据验证；不允许它们变成任意脚本、命令或输出文件路径。系统 SHALL 不默认收集认证头、Cookie、完整请求正文或完整页面源码，且不自动开启录制。

#### Scenario: Untrusted project configuration

- **WHEN** 未受信任的项目提供后端路径、端点或采集配置
- **THEN** 系统不使用这些配置执行程序或建立连接，并说明配置未生效

#### Scenario: Oversized or invalid output

- **WHEN** 外部采集结果超过预算或不符合约定格式
- **THEN** 系统返回有界错误并放弃该结果，不把截断数据作为有效证据

### Requirement: Session-scoped evidence lifecycle

系统 SHALL 将临时证据限定在所属会话的检查生命周期内，只清理自己创建的文件和后台资源。证据过期、被删除或会话已替换时 SHALL 返回不可用状态，不静默重新采集替代。使用说明 SHALL 区分扩展临时文件、Pi 会话保存和当前模型的数据处理；系统 MUST 不承诺已发送的图像从未持久化。

#### Scenario: Capture is no longer available

- **WHEN** 用户引用已清理的截图或其他会话中的截图
- **THEN** 系统报告证据不可用并要求重新采集，不从当前页面重建同名证据

#### Scenario: Session shutdown

- **WHEN** 会话结束、切换或扩展重载
- **THEN** 系统取消未完成采集、失效旧引用并清理所属临时资源，保留用户拥有的浏览器进程和配置目录
