## MODIFIED Requirements

### Requirement: Explicit local browser preparation

系统 SHALL 仅连接用户明确配置的专用本地浏览器端点，并将页面准备与观察分开。页面准备 SHALL 明确指定本地页面地址和视口；它可以创建扩展拥有的标签页、导航和设置视口。采集 SHALL 不隐式导航、滚动、调整视口、点击、输入或选择另一个标签页。连接失败 MUST 不回退到用户日常浏览器或云浏览器。系统 SHALL 在扩展进程内直接与已配置端点建立连接，MUST 不通过外部浏览器命令、脚本运行时或包管理器间接驱动浏览器。扩展自行启动浏览器时，其启动形态 SHALL 由配置声明，取值包含有头可见、有头最小化与无头三种；未配置时的默认形态 MUST 不抢占用户前台窗口与键盘焦点。任何启动形态下系统 MUST 不触碰用户日常浏览器配置目录，MUST 不结束用户拥有的浏览器进程。

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

#### Scenario: Unknown launch form is rejected

- **WHEN** 配置中的启动形态不是三种受支持取值之一
- **THEN** 系统拒绝该配置并说明合法取值，不静默回退到默认形态

#### Scenario: Minimized launch keeps the page operable

- **WHEN** 扩展以有头最小化形态启动浏览器并完成准备
- **THEN** 用户能把该窗口带入前台并手动改变页面交互状态，随后的采集反映该状态

## ADDED Requirements

### Requirement: Declared launch form limits user interaction

系统 SHALL 在准备结果中声明本次上下文所用浏览器的启动形态。无头形态下系统 SHALL 明确报告页面不可见，MUST 不指示用户去操作一个不存在的窗口，也 MUST 不把需要用户交互的验证描述为可完成。可见形态（有头可见、有头最小化）下系统 SHALL 允许用户把窗口带入前台，以便手动改变页面交互状态后再采集。

#### Scenario: Headless context is declared as not user-operable

- **WHEN** 当前上下文由无头形态提供
- **THEN** 准备结果声明页面不可见且用户无法手动改变页面交互状态

#### Scenario: Visible context is declared as user-operable

- **WHEN** 当前上下文由有头形态提供
- **THEN** 准备结果声明用户可以看到并手动操作该页面

#### Scenario: Interaction-dependent verification in a headless context

- **WHEN** 调用方在无头上下文中请求依赖用户手动交互的复核
- **THEN** 系统说明该上下文无法由用户产生该交互状态，不假装该状态可达

### Requirement: Extension-started browsers do not steal focus

扩展自行启动浏览器时 SHALL 以不打断用户当前前台工作的方式启动；默认形态 MUST 不使新窗口出现在用户前台，也 MUST 不夺取键盘焦点。显式选择有头可见形态时，系统 MAY 让窗口出现在前台，但该选择 SHALL 由用户配置决定，MUST 不成为默认行为。

#### Scenario: Default launch does not interrupt

- **WHEN** 会话首次需要一个尚不存在的端点并以默认形态启动浏览器
- **THEN** 用户当前的前台窗口与键盘焦点不被打断

#### Scenario: Explicit windowed launch may show the window

- **WHEN** 用户显式配置有头可见形态
- **THEN** 系统允许窗口出现在前台，且该行为只源于用户配置

### Requirement: Browser vendor is not fixed

系统 SHALL 接受任何提供兼容远程调试端点的 Chromium 系浏览器，MUST 不要求特定厂商。未显式配置可执行文件时，系统 SHALL 按平台探测常见候选；用户 SHALL 能显式指定可执行文件路径覆盖探测结果。未找到任何可用浏览器时 SHALL 返回包含可执行恢复步骤的提示，MUST 不静默改用其他浏览器或云服务。

#### Scenario: Another Chromium browser is found

- **WHEN** 环境中有另一个 Chromium 系浏览器而没有默认首选的那个
- **THEN** 系统使用可用者启动端点，并在失败信息中说明实际使用的可执行文件

#### Scenario: Explicit override wins

- **WHEN** 用户显式指定了浏览器可执行文件路径
- **THEN** 系统只使用该路径，不再探测平台候选

#### Scenario: No usable browser

- **WHEN** 环境中不存在任何受支持的 Chromium 系浏览器
- **THEN** 系统返回可执行的恢复提示（指定可执行文件路径，或自行在已配置端点上启动浏览器）
