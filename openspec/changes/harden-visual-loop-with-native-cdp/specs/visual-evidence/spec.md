## MODIFIED Requirements

### Requirement: Explicit local browser preparation

系统 SHALL 仅连接用户明确配置的专用本地浏览器端点，并将页面准备与观察分开。页面准备 SHALL 明确指定本地页面地址和视口；它可以创建扩展拥有的标签页、导航和设置视口。采集 SHALL 不隐式导航、滚动、调整视口、点击、输入或选择另一个标签页。连接失败 MUST 不回退到用户日常浏览器或云浏览器。系统 SHALL 在扩展进程内直接与已配置端点建立连接，MUST 不通过外部浏览器命令、脚本运行时或包管理器间接驱动浏览器。

#### Scenario: Prepare a local page

- **WHEN** 用户已配置专用本地端点并显式请求准备一个受支持的本地页面
- **THEN** 系统在扩展拥有的标签页中打开页面，记录绑定的页面和实际视口，并返回准备结果

#### Scenario: Observe an existing interaction state

- **WHEN** 用户已在绑定页面打开弹窗或改变滚动位置并请求采集
- **THEN** 系统采集当前状态，不刷新页面、不重置滚动、不关闭弹窗

#### Scenario: Endpoint or target is unavailable

- **WHEN** 端点不可达、绑定标签页已关闭，或页面已离开允许的本地范围
- **THEN** 系统返回明确失败及恢复提示，不改用其他标签页或浏览器

#### Scenario: No external browser runtime is required

- **WHEN** 系统在只具备扩展自身运行时依赖的环境中启动并连接已配置端点
- **THEN** 准备、采集、裁剪和关闭全部可用，不要求用户另行安装浏览器自动化命令行工具、脚本解释器或图像库

#### Scenario: Backend path configuration is no longer accepted

- **WHEN** 用户配置中存在旧的浏览器后端可执行文件路径字段
- **THEN** 系统拒绝该字段并说明它已移除及其替代配置，不静默忽略，也不回退到任何外部命令

### Requirement: Localized evidence with honest target resolution

系统 SHALL 支持当前视口截图,以及可选选择器指向的可见局部证据。视口截图与局部截图 SHALL 在同一稳定状态下独立采样;两次采样之间 MUST 做前后稳定性校验,确保页面未发生导航、滚动或布局变化。指定目标必须唯一匹配;不存在、多重匹配或位于视口外时 SHALL 返回具体目标错误,不自动选择第一个结果或滚动。可用的辅助信息 SHALL 包含元素边界、受限文本与无障碍信息、相关布局和视觉计算样式。系统 MUST 不将区域或选择器声明为已经确定的源码位置。按区域裁剪 SHALL 使用与元素边界相同的页面坐标口径,MUST 不对显示像素与原始图像像素做隐式换算。

#### Scenario: Visible unique target

- **WHEN** 选择器唯一匹配一个可见元素
- **THEN** 系统返回视口图、该图中目标可见部分的局部图、完整元素边界、实际裁切区域和受限样式信息

#### Scenario: Ambiguous or invisible target

- **WHEN** 选择器匹配多个元素或唯一元素完全位于视口外
- **THEN** 系统报告多重匹配或不可见，不猜测目标，也不改变页面状态

#### Scenario: Region without an element

- **WHEN** 用户关注的是留白、阴影或画布中的区域
- **THEN** 系统允许后续基于图像区域反馈，元素信息缺失不使有效截图失效

#### Scenario: Cropped region in a scaled or high density context

- **WHEN** 设备像素比大于 1 或页面缩放不为 1 时按页面坐标请求裁剪
- **THEN** 裁切结果的覆盖范围与请求的页面坐标一致，记录的区域边界与视口坐标可比，不因显示像素换算产生偏移

### Requirement: Bounded and trusted data handling

系统 SHALL 限制图像像素和字节数、结构化输出、文本、诊断条数、子进程输出及执行时间。**evidenceDiskBudget**(临时文件磁盘预算)SHALL 限制单次采集的图像字节数上限为 4 MiB,单个会话的累计磁盘占用上限为 100 MiB。**modelPayloadBudget**(注入模型的上下文预算)SHALL 限制单次采集返回的结构化文本上限为 16 KiB。项目配置 SHALL 仅在项目受信任时生效。页面文本、选择器、端点响应和外部工具输出 MUST 按不可信数据验证;不允许它们变成任意脚本、命令或输出文件路径。系统 SHALL 不默认收集认证头、Cookie、完整请求正文或完整页面源码,且不自动开启录制。系统 SHALL 同样限制复核返回的结构化结果与图像总量,MUST 不因一次调用而超出 modelPayloadBudget 与 evidenceDiskBudget 设定的预算。
#### Scenario: Untrusted project configuration

- **WHEN** 未受信任的项目提供后端路径、端点或采集配置
- **THEN** 系统不使用这些配置执行程序或建立连接，并说明配置未生效

#### Scenario: Oversized or invalid output

- **WHEN** 外部采集结果超过预算或不符合约定格式
- **THEN** 系统返回有界错误并放弃该结果，不把截断数据作为有效证据

#### Scenario: Verification result exceeds the output budget

- **WHEN** 复核的结构化结果或默认返回的图像合计超过预算
- **THEN** 系统按既定规则裁剪默认返回内容或明确失败，不把超量数据交给模型

### Requirement: Session-scoped evidence lifecycle

系统 SHALL 将临时证据限定在所属会话的检查生命周期内，只清理自己创建的文件和后台资源。证据过期、被删除或会话已替换时 SHALL 返回不可用状态，不静默重新采集替代。使用说明 SHALL 区分扩展临时文件、Pi 会话保存和当前模型的数据处理；系统 MUST 不承诺已发送的图像从未持久化。系统 SHALL 释放自己建立的浏览器连接，且 MUST 不终止用户拥有的浏览器进程或删除其配置目录。

#### Scenario: Capture is no longer available

- **WHEN** 用户引用已清理的截图或其他会话中的截图
- **THEN** 系统报告证据不可用并要求重新采集，不从当前页面重建同名证据

#### Scenario: Session shutdown

- **WHEN** 会话结束、切换或扩展重载
- **THEN** 系统取消未完成采集、失效旧引用并清理所属临时资源，保留用户拥有的浏览器进程和配置目录

#### Scenario: Connection is released without owning the browser

- **WHEN** 扩展断开或重载时仍有其他标签页与页面处于打开状态
- **THEN** 系统关闭自己的连接与自有标签页，不关闭用户的其他标签页，不结束浏览器进程
