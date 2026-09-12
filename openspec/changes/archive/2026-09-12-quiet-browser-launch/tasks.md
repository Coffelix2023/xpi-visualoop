## 1. 配置

- [x] 1.1 `config.ts` 增加 `launch` 键（`"minimized" | "headless" | "windowed"`，默认 `"minimized"`）与 fail-closed 校验；验证：`tests/visual-loop-config.test.ts` 新增用例覆盖三种合法值、非法取值被拒、缺省时为 `minimized`
- [x] 1.2 未知字段仍然 fail-closed 且新键不改动既有 `cdpUrl` / `glimpseModulePath` 行为；验证：既有 config 测试全部通过且未被放宽

## 2. 启动参数与窗口状态

- [x] 2.1 `chrome.ts` 按 `launch` 组装启动参数：`headless` 加 `--headless=new`，`minimized` / `windowed` 加 `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-features=CalculateNativeWinOcclusion`；验证：单测断言三种形态各自的参数集合，并断言 `windowed` 不含最小化相关动作
- [x] 2.2 端点就绪后，经**浏览器级**连接执行 `Browser.getWindowForTarget` + `Browser.setWindowBounds({ windowState: "minimized" })`；验证：单测用 fake CDP 断言两个方法被调用且参数正确（实现说明：既有 `CdpClient` 连的就是 `/json/version` 的浏览器级 endpoint，`Browser.*` 直接在该连接上发送，不需要第二条连接）
- [x] 2.3 窗口操作失败（无窗口、方法不可用）时不使准备失败，降级为"窗口状态未知"并如实返回该状态；验证：单测构造失败响应，断言准备仍成功且返回值标记状态未知
- [x] 2.4 浏览器级连接在 `disconnect` 与 `connect` 失败清理两条路径上都关闭；验证：单测断言两条路径均无连接泄漏（fake CDP 记录 close 次数）（实现说明：该连接即 `active.cdp`，两条路径各关闭一次，`openSockets` 计数归零）

## 3. 启动形态的声明

- [x] 3.1 准备结果携带启动形态与"用户能否手动操作页面"，并在无头形态下明确报告页面不可见；验证：`tests/visual-loop-tool.test.ts` 断言 `visual_prepare` 返回体含形态字段，且无头/最小化两种取值下的可操作性声明不同
- [x] 3.2 最小化形态的声明包含"窗口已最小化及如何恢复"的提示；验证：单测断言提示文本存在且不声称窗口在前台

## 4. 浏览器探测

- [x] 4.1 darwin 候选增加 Brave / Edge / Arc，linux 候选增加 `microsoft-edge` / `brave-browser`；验证：单测断言候选顺序、`XPI_VISUALOOP_CHROME` 覆盖优先级最高
- [x] 4.2 未找到任何可用浏览器时的错误提示包含两条可执行恢复步骤（指定可执行文件路径、或自行在已配置端点上启动）；验证：单测断言错误消息同时包含两条路径，且不静默改用其他浏览器（实现说明：提示由 `noBrowserMessage()` 生成，含 `--remote-debugging-port` 与 `--user-data-dir` 两个可直接执行的参数）

## 5. 验收

- [x] 5.1 默认形态真实验收：删除 `launch` 配置后触发扩展自启，窗口状态读回为 `minimized`，且 `visual_prepare` + `visual_capture` 得到正确的视口渲染（与有头可见形态逐项一致）；验证：窗口状态查询结果与截图尺寸/内容（脚本 `docs/references/native-cdp-probes/launch-forms.mjs`，Chrome 152 / macOS：窗口读回 `minimized`，PNG 900x560，`#target` crop 120x50，与 windowed 逐项一致）
- [x] 5.2 无头形态真实验收：`launch: "headless"` 下 `visual_prepare` + `visual_capture`（视口与 selector 各一次）全部成功，且准备结果声明用户不可操作页面；验证：三次调用返回体与准备结果声明（同脚本：进程命令行含 `--headless=new`，`userOperable=false`，两次采集均成功）
- [x] 5.3 回归验收：`windowed` 形态行为与变更前一致，且"不触碰用户日常 profile、不结束用户拥有的浏览器进程"未被破坏；验证：用 `launch: "windowed"` 跑一遍准备与采集，并确认用户日常浏览器进程 PID 未变（同脚本：窗口 `windowState=normal`、未发送窗口命令；替身"用户浏览器"PID 在每个用例后均存活，扩展自启进程只用 `--user-data-dir=~/.cache/xpi-visualoop/chrome-profile`）
- [x] 5.4 门禁：`pnpm typecheck`、`pnpm -w run lint`、`pnpm test` 三条全绿；验证：三条命令输出全部通过（163 passed / 6 skipped）
- [x] 5.5 文档同步：`README.md` 与 `README.zh-CN.md` 的 Setup 增加 `launch` 说明、"Chrome"措辞改为"Chromium 系浏览器"、Limits 增加最小化与无头对用户交互能力的差异，并标注默认行为变更属 BREAKING；验证：双语文档各自包含三种形态说明与恢复步骤
