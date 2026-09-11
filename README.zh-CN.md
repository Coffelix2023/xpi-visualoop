# xpi-visualoop

[English](./README.md) · **简体中文**

**给模型一双眼睛,给你一个评审面板。** xpi-visualoop 通过你准备的浏览器观察一个本地页面,把不可变截图交给模型,在原生 Glimpse 面板里收集局部意见,并在复核时给出「是否可比」的判定。

**An extension that gives the model eyes and gives you a review panel.** xpi-visualoop observes one local page through a browser you prepared yourself, returns immutable screenshots to the model, collects regional comments in a native Glimpse panel, and reports a comparability verdict when you ask it to verify a change.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)

```text
> 准备 http://localhost:3000/settings,说说你看到了什么
> 采集 #save-button 区域
> 现在复核:还是同一个对话框,还是我的改动把它变了?
```

## 为什么

问编码 Agent「这个页面长什么样」,你得到一段散文。问它「我的改动有没有改到目标元素」,你得到一个自信的猜测。两者都不是证据。

本扩展用三条硬规则把这个环闭上:

- **要像素,不要段落。** `visual_capture` 返回真实的 PNG 图像内容块加上有界 JSON 元数据,模型对着真实渲染结果推理。
- **人能直接指。** `visual_feedback` 在一张截图或一组前后对比上打开 Glimpse 面板,评审变成在图上圈一块区域,而不是在对话里写一段话。
- **可比性是判定出来的,不是假设出来的。** 调用方不肯声明交互状态时 `visual_verify` 直接拒绝复核;它返回 `comparable` 或 `not-comparable`,而不是把一次导航造成的差异悄悄报成代码改动。

它刻意保持只读。Agent 只能看,不能点击、输入、滚动或执行页面脚本。全部操作走专用浏览器 profile 与 Chrome DevTools Protocol(CDP,Chrome 开发者工具协议),不依赖外部浏览器后端,也不需要 Python 运行时;传输用 Node.js 内置的 `WebSocket`,启动器用 `node:child_process`,因此本包新增运行时依赖为零。

## 安装

前置条件:Pi,以及你自己在回环调试端口上启动的 Chrome/Chromium。

```bash
pi install git:github.com/Coffelix2023/xpi-visualoop
```

| 安装位置 | 命令 |
| --- | --- |
| 全局(用户设置) | `pi install git:github.com/Coffelix2023/xpi-visualoop` |
| 仅当前项目(`.pi/settings.json`) | `pi install -l git:github.com/Coffelix2023/xpi-visualoop` |
| 本地 checkout,原地引用 | `git clone https://github.com/Coffelix2023/xpi-visualoop.git && pi install ./xpi-visualoop` |

`pi install` 写入 `~/.pi/agent/settings.json`;加 `-l` 写入项目设置,项目被信任后 Pi 启动时会自动安装。本地路径是**引用**而非拷贝,所以在该 checkout 里 `git pull` 就是你的更新方式。固定 git ref 与带版本的 npm 规格不会被 `pi update` 移动。

```bash
pi list                                        # 已安装的包
pi update --extensions                         # 更新所有包
pi remove git:github.com/Coffelix2023/xpi-visualoop
```

本包直接分发 TypeScript 源码,没有构建步骤:`package.json` 让 Pi 直接加载 `./src/index.ts`。

## 配置

扩展从不碰你的日常 profile,也不会回退到别的浏览器。只有当视觉工具需要端点而该端口上没有任何监听时,它才会启动一个自己的 Chrome。那个 Chrome 是子进程:`/xpi-visualoop disconnect` 会关掉它,Pi 退出时也会回收。你自己启动的浏览器不会被接管,也不会被关闭。

想自己控制窗口,就手动准备一个专用实例:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.cache/xpi-visualoop/chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

Linux 上换成你发行版的 Chrome 或 Chromium 可执行文件,参数相同。

配置是可选的。没有配置时,扩展使用默认端点 `http://127.0.0.1:9333/`,也就是上面那条命令里的端口。要换成别的地址,把配置写到 `<agentDir>/xpi-visualoop.json`;受信任的项目可用 `<cwd>/.pi/xpi-visualoop.json` 覆盖。

```json
{
  "cdpUrl": "http://127.0.0.1:9333/"
}
```

`cdpUrl` 必须是 `http://` 回环端点。`glimpseModulePath` 可选,必须是绝对路径。未知字段、写错的 `cdpUrl`、无法解析的文件依然 fail-closed(失败闭合)拒绝,只有「键缺失」这一种情况回退到默认值。

Chrome 不在默认位置(macOS 的 `/Applications`,或 `PATH` 上的 `google-chrome` / `chromium`)时,把 `XPI_VISUALOOP_CHROME` 设成浏览器的绝对路径。


评审面板是一个 Glimpse 窗口(`glimpseui`)。它是可选的:未安装时评审降级为整张截图的文字反馈。面板固定文案跟随会话语言,除非工具调用显式声明 `language`;你传的问题、选项与标签一律原样呈现,不会被翻译。
### 从 `harnessPath` 迁移

旧版本调用单独安装的 `browser-harness` 可执行程序。该后端已删除,`harnessPath` 现在是**破坏性变更**,不是「废弃键」。仍带该键的配置会被拒绝启动,并返回迁移提示。

1. 从 `<agentDir>/xpi-visualoop.json` 和受信任项目的 `<cwd>/.pi/xpi-visualoop.json` 里删除 `harnessPath` 键。
2. 确认 `cdpUrl` 指向你的专用端点。
3. 重新加载 Pi 并执行 `/xpi-visualoop status`,应报告上下文可配置且没有迁移诊断。

没有数据库迁移,也不要求迁移浏览器 profile。

## 工具与命令

流程显式且串行。只有五个只读工具,没有第六个。

| 工具 | 作用 |
| --- | --- |
| `visual_prepare` | 准备一个回环 URL、视口、DPR(设备像素比)和可选声明 `stateLabel`。可能创建或导航扩展拥有的标签页。 |
| `visual_capture` | 采集当前视口,或采集一个唯一且可见的选择器。不会导航、滚动、调整视口、点击或输入。 |
| `visual_compare` | 把两张已存在的截图组成一次比较。不采集、不导航、不滚动,并始终记录 `mode: "variant"`。 |
| `visual_feedback` | 在 Glimpse 里评审一个 `captureId` 或 `comparisonId`:点选元素或拖动框选区域加一条意见,或调用方提供问题与选项时收回一个结构化选择。 |
| `visual_verify` | 复用基准截图的上下文与目标生成新的「修改后」截图。返回 `comparable` 或 `not-comparable`、独立诊断、目标/样式变化和有界前后图。 |

`stateLabel` 是调用方声明,永远不是浏览器给出的证明。基准声明过 `stateLabel` 时,`visual_verify` 会拒绝沉默的调用方,要求传同一个标签(交互状态没变)或新标签(已变)。少了这道检查,一次「因为打开菜单而产生的差异」会被报成「因为你的代码改动而产生的差异」。

`visual_verify` 默认只返回共同区域的前后图。传 `includeViewportImages` 才会连整视口前后图一起返回。

`visual_compare` 把两张已有截图组成一次比较,并记录 `mode: "variant"`——这是「两个设计版本」,不是「改动前后」,所以页面地址、设备像素比、滚动位置这类差异会作为信息返回,而不是拒绝比较。传 `labels` 给两侧命名;不传时面板说左右,而不是前后。variant 比较会把两侧图像都返回,模型看到的和面板展示的是同一对图。

面板里可以点选元素(悬停显示 `selector · role`)或拖动框选区域;只有点选产生的区域带元素身份。`question` 与 `options` 一起传时,面板只问一个问题,答案以结构化 `choice` 返回。`Esc` 先落定取消,再问是要重新打开面板、跳过这一步,还是本轮不再询问;答案以 `reopenRequested` 与 `suppressForRound` 返回,被抑制的这一轮后续调用直接返回 `suppressed`,不会再开面板。

```text
/xpi-visualoop status        # 当前检查上下文
/xpi-visualoop disconnect    # 取消在途操作、释放自有文件、关闭它自己启动的浏览器
```

`disconnect` 会取消在途操作、使旧证据失效、清理扩展拥有的临时文件和浏览器资源,并关闭本扩展自己启动的那个 Chrome 进程。你自己启动的浏览器保持不动。

## 预算与降级

预算刻意固定,不是可配置矩阵。

- 导出截图:最长边不超过 2,000 设备像素,且不超过 4 MiB。
- 单次工具 JSON 结果不超过 64 KiB;面向模型的采集文本不超过 16 KiB。
- `visual_verify` 与 `visual_compare`:文本不超过 16 KiB,图像合计不超过 4 MiB;任一超限都明确失败,不会静默丢弃证据。
- console 与 network 失败摘要各最多 20 条,并标记截断。
- 用户意见最多 2,000 字符。
- 单次操作 30 秒;就绪等待 5 秒;反馈面板 10 分钟。
- 一个检查上下文最多 20 次采集,证据及中间文件合计 128 MiB。

就绪与诊断状态保持诚实而不是方便:`ready`、`degraded`、`failed`、`observed`、`unknown` 不互相替代。扩展不会用网络空闲推断页面交互已初始化,不收集认证头、Cookie 或请求正文,不自动开启录制,也不声称取得完整原子 DOM(文档对象模型)快照。

Glimpse 不可用但 Pi 有 UI(用户界面)时,反馈降级为对**整张截图**的明确文字反馈,并保留图像路径和引用。没有对话界面时反馈返回 `unavailable`,采集功能仍然可用,不依赖图形窗口。

已知限制:

- 本包标记为 `private`,因此不能用 `npm:` 方式安装,请用上面的 git 或本地路径方式。
- Fedora Linux 未验证。已验证环境为 macOS Darwin `25.6.2` arm64,Chrome `152.0.7977.84`,Node.js `24.20.0`,Pi `0.85.1`。
- 截图是你页面的真实像素。指向任何屏幕上会出现凭据的页面之前,先读下面的隐私边界。

## 文件、隐私边界与回滚

截图和中间文件位于检查上下文私有的临时目录。清理只删除本扩展创建的内容;硬崩溃可能留下残留,下次启动只按所有权检查。扩展启动的 Chrome 是 Pi 进程的子进程,退出时会被回收;它写入的 profile 是专用目录 `~/.cache/xpi-visualoop/chrome-profile`,永远不是日常 profile。

工具结果中的截图可能被 Pi 会话持久化,或发送给你配置的模型服务。清理扩展临时目录不会删除这些副本。「本地采集」不等于图像绝不会离开本机。

回滚步骤:

1. 在当前 Pi 会话执行 `/xpi-visualoop disconnect`。
2. `pi remove git:github.com/Coffelix2023/xpi-visualoop`,或删除本地路径条目。
3. 只删除本扩展用过的专用 profile 和临时目录;永远不要删除日常浏览器 profile。

## 开发

```bash
mise install
pnpm install
pnpm typecheck       # tsc --noEmit
pnpm -w run lint     # Biome 全仓检查
pnpm test            # Vitest,只跑 tests/
```

提交前三条必须全绿。Vitest 配置只收集 `tests/**/*.test.ts`;`docs/references` 里是第三方源码和研究期探针,依赖不同。

触发面是随包发的 skill,不是 system prompt 里的 snippet。因此「模型是否真的会用」属于模型行为问题,不是代码问题——用测量代替假设:

```bash
scripts/trigger-eval.sh          # 三个固定 prompt,检查会话记录
scripts/trigger-eval.sh --case 2 # 只跑一个用例
```

两个正例必须调用 `visual_prepare`,负例必须不调用。需要 `pi` 在 PATH 上、模型已配置,正例还需要一个可访问的本地 dev server。

完整闭环的可执行验收脚本在 `docs/references/native-cdp-probes/verify.mjs`:

```bash
node --experimental-transform-types docs/references/native-cdp-probes/verify.mjs
```

它自起专用 Chrome 与页面服务,依次验证准备、采集、沉默调用方被拒、一次可比复核、一次真实的 Glimpse 反馈往返,以及释放路径。`PROBE_SKIP_FEEDBACK=1` 可跳过人工面板。

```text
.
├── mise.toml / package.json / biome.jsonc / vitest.config.ts / tsconfig.json
├── AGENTS.md / CONTEXT.md / DESIGN.md
├── docs/                    # 工作流、参考说明和验证记录
├── openspec/                # change proposal、spec、design、tasks
├── skills/xpi-visualoop/    # SKILL.md:模型据以判断「什么时候该看」的那段描述
├── scripts/                 # trigger-eval.sh:should-call 冒烟评测
├── src/index.ts             # Pi 扩展注册入口
├── src/visual-loop/         # 配置、Chrome 启动器、CDP 客户端与动作、证据、反馈、上下文
└── tests/                   # 聚焦单元/集成测试
```

## 致谢

- [Pi Coding Agent](https://github.com/earendil-works/pi) — 由 [earendil-works](https://github.com/earendil-works) 开发。本扩展寄宿其中:扩展 API、`ctx.ui` 契约、`ctx.hasUI` 降级语义和包清单规范都来自该项目。
- [Glimpse](https://github.com/hazat/glimpse) — 由 [hazat](https://github.com/hazat) 开发,提供原生评审面板。可选依赖:未安装时反馈降级为整图文字反馈。
- [browser-harness](https://github.com/browser-use/browser-harness) — 由 [browser-use](https://github.com/browser-use) 开发,是本扩展替换掉的外部后端。它的只读行为清单(就绪三重检查、`degraded` 原因集合、诊断条数上限、目标归属校验)定义了本次 CDP 重写必须达到的等价标准;它的 daemon + IPC 架构也让「替换的代价」变得可见。MIT 许可。现已不再安装或调用,开发期参考 clone 已删除。

## 许可

MIT
