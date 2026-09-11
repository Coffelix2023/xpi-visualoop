# Handoff：任务 2.7–2.9（诊断收集 / clip 局部截图 / 像素上限）

> 中断时间：上下文将满，用户在 2.8 的真机测量中途要求交接。
> 目标 change：`openspec/changes/harden-visual-loop-with-native-cdp`，`tasks.md` 中 2.7–2.9 仍为 `[ ]`。

## 0. TL;DR

- **2.7 代码已写完**（新模块 `cdp-diagnostics.ts` + `redact.ts`），但**尚未接线、尚未写测试、尚未勾选任务**。
- **2.8 / 2.9 只有真机测量数据，没有实现**。`cdp-actions.ts` 里的 `capture` 仍只做整视口截图，`ponytail:` 注释标记的预算缩放仍是缺口。
- 真机测量已推翻设计文档里两个「未验证项」的推断，结论写在下面第 3 节，**实现必须按实测语义走**。

## 1. 环境与复现

| 项 | 值 |
| --- | --- |
| OS | macOS 26.6.2 |
| Node | `v24.20.0` |
| Chrome | `152.0.7977.84`（`/Applications/Google Chrome.app`） |
| 探针目录 | `/tmp/xpi-visualoop-probe-25/`（脚本已复制到本仓 `docs/references/native-cdp-probes/`） |
| Chrome 端点 | `http://127.0.0.1:9556/`，独立 profile `/tmp/xpi-visualoop-probe-25/profile`，`--headless=new` |
| 测试页面 | `page.mjs`→`127.0.0.1:8765`（色带+列块）；`page2.mjs`→`8766`（控制台/网络错误）；`page3.mjs`→`8767`（100×100 网格，颜色即页面坐标） |

```bash
# 页面服务（各占一个终端）
node docs/references/native-cdp-probes/page.mjs
node docs/references/native-cdp-probes/page2.mjs
node docs/references/native-cdp-probes/page3.mjs

# 专用 Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9556 \
  --user-data-dir=/tmp/xpi-visualoop-probe-25/profile \
  --no-first-run --no-default-browser-check --disable-default-apps --disable-sync \
  --headless=new about:blank

# 探针
node docs/references/native-cdp-probes/diag2.mjs    # 2.7 诊断事件语义（已跑通 → 3.5）
node docs/references/native-cdp-probes/probe3.mjs   # 输出尺寸/字节（已跑通 → 3.4）
node docs/references/native-cdp-probes/probe4.mjs   # clip 坐标往返（已跑通 → 3.1）
node docs/references/native-cdp-probes/probe5.mjs   # clip 与滚动、beyondViewport（已跑通 → 3.2b）
node docs/references/native-cdp-probes/probe6.mjs   # clip.scale 生效性（已跑通 → 3.2）
```

**遗留进程**（本轮结束时仍在跑，交接后需清理或继续复用）：
Chrome 主进程 pid 7861（profile 是 `/tmp/xpi-visualoop-probe-25/profile`）；页面服务 pid 7859 / 9957 / 11239。
清理命令：`kill 7861 7859 9957 11239`。

`png.mjs` 是自写的非交错 PNG 解码器（仅用 Node 内置 `zlib`），用于按坐标取像素验证裁切覆盖范围；不含任何第三方依赖。

## 2. 已完成：任务 2.7 的实现代码（未接线）

新增两个文件，均为本 change 的产物，**尚未被任何调用方 import**：

### `src/visual-loop/redact.ts`

从 `harness.ts` 抽出的 `sanitizeDiagnosticMessage` / `safeDiagnosticUrl`，供 CDP 路径与旧路径共用，避免两边脱敏规则漂移。`harness.ts` 里仍保留同名私有函数副本（未改成 import），任务 3.2 删除旧后端时一并收敛。

### `src/visual-loop/cdp-diagnostics.ts`

`class CdpDiagnostics`：

- `attach(client, sessionId)` 依次发 `Runtime.enable` / `Log.enable` / `Network.enable`，然后 `client.onEvent` 订阅并**按 sessionId 过滤**；任一步失败则整体回退成 `status: "unknown"`，不抛错。
- `summarize(startedAt, endedAt)` 返回与 `HarnessDiagnosticSummary` 同构的 `{ console, network }`；未 attach 时返回 `unknown` 且无 `observedFrom`/`observedTo`。
- 采集口径：`Runtime.consoleAPICalled`（仅 `error`/`assert`）、`Runtime.exceptionThrown`、`Log.entryAdded`（仅 `level: "error"` 且 **`source !== "network"`**，避免与 `Network.*` 重复计数）、`Network.responseReceived`（`status >= 400`）、`Network.loadingFailed`（`canceled !== true`）。
- 上限：`MAX_DIAGNOSTIC_ENTRIES = 20`（与旧实现一致），超出置 `truncated: true`；内部最多记 4 倍然后停止。
- **刻意与旧实现不同的两点**（必须写进实测记录，属于有意的行为变更）：
  1. `unknown` 表示「观察器没挂上」，不是「浏览器没有可报告项」。旧实现启用失败时会静默退化成「零错误」。
  2. 携带附加数据的字段（`consoleAPICalled.args` 里的对象只降级为 `Object`/`Array` 字符串，栈追踪只取 `exceptionDetails.exception.description`）不原样透出，控制剥敏面积。

## 3. 真机实测结论（2.8 / 2.9 的实现依据）

### 3.1 `clip` 的坐标口径 = **文档坐标（DIP）**，不是「视口坐标 + 滚动偏移」

`probe4.mjs`（`page3.mjs` 网格页面，每格 100×100，颜色唯一编码坐标）结果全绿：

```
A dpr1 scrollY0  clip(150,250,200x200) scale1        200x200  bytes=637
  OK   out(0,0)=40,30,30 want_page(150,250)=40,30,30
  OK   out(50,50)=60,60,50 want_page(200,300)=60,60,50
  OK   out(199,199)=80,90,70 want_page(349,449)=80,90,70
D dpr1 scrollY0  clip(150.5,250.5,200x200) scale1    200x200  bytes=637
  OK   out(0,0)=40,30,30 want_page(150,250)=40,30,30
C dpr1 scrollY0  clip(150,250,199.6x199.6) scale1    199x199  bytes=634
  OK   out(0,0)=40,30,30 want_page(150,250)=40,30,30
F dpr1 scrollY250 clip(150,250,200x200) scale1       200x200  bytes=637
  OK   out(0,0)=40,30,30 want_page(150,250)=40,30,30   # 滚动后同一页面坐标仍是同一像素
G dpr1 scrollY250 clip(150,400,200x200) scale1       200x200  bytes=629
  OK   out(0,0)=80,30,50 want_page(150,400)=80,30,50
H dpr2 scrollY0  clip(150,250,200x200) scale1        400x400  bytes=1434
  OK   out(0,0)=40,30,30 / out(100,100)=60,60,50 / out(399,399)=80,90,70
I dpr2 scrollY0  clip(150,250,200x200) scale0.5       200x200  bytes=637
  OK   out(0,0) / out(50,50) / out(199,199) 与 H 的同一页面坐标一致
```

结论：

1. `clip.x/y` 与 `clip.width/height` 都是**页面文档坐标（DIP = CSS 像素）**，与 `visibleBounds` 同系。现有 `context.ts` 里 `scale_x = raw_width / page_before["w"]` 的换算、以及 `imageRegionForViewport` 的 `scrollX + x` 预平移**都不再需要**。
2. **输出像素 = `clip` 尺寸 × DPR × `clip.scale`**。`clip.scale` 是页面缩放因子，与 DPR 相乘（H 与 I 在代码路径上得到同一尺寸**不是** `scale` 生效的证明，见下）。
3. `clip` 尺寸可以是小数，输出尺寸取整（199.6 → 199）；小数原点的位移小于 1 个页面像素，落在同一像素内。
4. 布局无关：页面的物理滚动位置不影响「页面坐标 → 像素」的映射，所以 `prepare` 不需要为了裁切先 `scrollTo(0,0)`。

### 3.2 `clip.scale` **确实生效**，是页面缩放因子（与 DPR 相乘）

`probe3.mjs` 里 `scale: 0.5` 的输出尺寸等于「不传 scale」的一半，但那只能说明「参数可能被忽略而 DPR 恰好减半」。`probe5.mjs` + `probe6.mjs` 消除了这个歧义。

`probe6.mjs` 在同一 DPR 下只改 `scale`（`clip(150,250,400x400)` + `captureBeyondViewport: true`，用 `page3.mjs` 网格按页面坐标取样）：

```
dpr1 clip(150,250,400x400) scale1    +beyondViewport   400x400  bytes=1473  OK out(0,0)=40,30,30 = page(150,250)
dpr1 clip(150,250,400x400) scale0.75 +beyondViewport   300x300  bytes= 986  OK out(0,0)=40,30,30 = page(150,250)
dpr1 clip(150,250,400x400) scale0.5  +beyondViewport   200x200  bytes= 639  OK out(0,0)=40,30,30 = page(150,250)
dpr2 clip(150,250,400x400) scale1    +beyondViewport   800x800  bytes=3770  OK out(0,0)=40,30,30 = page(150,250)
dpr2 clip(150,250,400x400) scale0.75 +beyondViewport   600x600  bytes=2422  OK out(0,0)=40,30,30 = page(150,250)
dpr2 clip(150,250,400x400) scale0.5  +beyondViewport   400x400  bytes=1473  OK out(0,0)=40,30,30 = page(150,250)
dpr1 scale0.5 corner check: 200x200 out(last)=120,150,110 want_page(349,449)=80,90,70
dpr2 scale0.5 corner check: 400x400 out(last)=120,150,110 want_page(349,449)=80,90,70
```

**结论：`scale` 是真参数，输出像素 = `clip` 尺寸 × DPR × `scale`**，同一 DPR 下改 `scale` 即等比改输出尺寸。上表的 6 行覆盖尺寸可精确预测。

**但 `scale < 1` 的像素内容不是「纯缩小」**：`scale0.5` 的最后一个输出像素采样到的颜色是 `120,150,110`（对应页面 `(300..399, 500..599)` 附近的格），而不是脚本推算的 `page(349,449)=80,90,70`。说明采样的页面坐标与「输出像素中心 × 1/scale + 原点」不是简单线性对应，**缩小时的取样映射没有被这组探针精确刻画**。

对实现的影响（重要）：

- 用 `scale` 压输出尺寸**可行**（尺寸可预测，内容不是空白），但**不能依赖「输出像素 ↔ 页面坐标」的精确线性关系**去做裁切覆盖范围的校验。
- 因此「往返误差 ≤ 1 导出像素」的验收判据只应该在 `scale: 1` 的路径上做（DPR 1 与 2 各一次，`probe4.mjs` 已全绿）；`scale < 1` 只用于兜底的尺寸收窄，并在实测记录里写明它不参与坐标往返校验。
- 首选方案仍是 3.4 的「收紧 prepare 视口上限」，`scale` 只作为放宽视口时的后置手段。

### 3.2b `clip` 与滚动的交互（`probe5.mjs` 结论）

```
no-clip @scrollY250 (truth: viewport = page 0,250..800,850)      800x600  bytes=3132
  OK top-left out(0,0)=40,0,20 = page(0,250)   OK bottom-right out(799,599)=160,210,150 = page(799,849)
clip(0,250,800x600) scale1 @scrollY250                          800x600  bytes=3132  两条取样均 OK
clip(0,250,800x600) scale1 +captureBeyondViewport=false @scrollY250  800x600  bytes=3132  两条取样均 OK
clip(150,700,200x200) +captureBeyondViewport=true @scrollY250   200x200  bytes= 628
  OK p(150,700)=140,30,80   OK p(349,899)=160,90,110   # 视口外的文档区域，beyond 打开后取到真实内容
clip(150,700,200x200) +beyondViewport=true 之后再取整视口        800x600  bytes=2922  取样仍 OK
  # 即 captureBeyondViewport 不会把页面滚动位置改掉
clip(0,0,800x600) scale1 while scrolled (document origin region)  800x600  bytes=2879
  MISS document origin out(0,0)=255,255,255 want_page(0,0)=0,0,0
```

两个待答问题已答完：

2. **`captureBeyondViewport: true` 能取到视口外内容**，且不会移动滚动位置（后续整视口截图取样仍正确）。不传该参数时 `clip` 超出视口的部分返回空白（3.3）。
3. **`clip` 是文档坐标（3.1 已证）**；最后一行 `MISS` 不是坐标口径反例，而是 `captureBeyondViewport` 未打开、`clip(0,0,...)` 落在当前视口之外（`scrollY=250` 时文档原点不可见）故返回白。这一行反而再次印证了 3.3 的必要性。

### 3.3 `captureBeyondViewport` 必须显式打开

`probe3.mjs` / `probe4.mjs` 各有一处反例：

```
E dpr1 scrollY0  clip(150,700,200x200) below viewport   200x200  bytes=578
  MISS out(0,0)=255,255,255 want_page(150,700)=140,30,80
```

即：`clip` 落在视口之外时，默认返回空白，不是页面内容。**「视口截图」和「文档任意区域截图」是两条路径**：

- 视口截图 = 不传 `clip`（或传当前可视矩形），走 surface。
- 文档区域截图（局部目标可能部分滚出视口）= 传 `clip` + `captureBeyondViewport: true`。

`clip` + `captureBeyondViewport` 的组合已实测能拿到视口外内容（`probe3.mjs` 的 `+captureBeyondViewport` 行：`p250=60,60,60 / p350=120,120,120 / p450=180,180,180` 与页面实际列块一致，而同一 `clip` 不加该参数时全是 body 灰 128）。实现时要按「目标是否完全在视口内」选择，或者统一用 `captureBeyondViewport: true` 并接受它对滚动位置的影响（`probe5.mjs` 会给出这一点）。

### 3.4 输出尺寸与字节数（2.9 的输入数据）

`probe3.mjs` 实测（`6500×4000` 附近的大图也一并记录）：

| 采集 | 输出尺寸 | 字节数 |
| --- | --- | --- |
| dpr1 整视口 800×600 | 800×600 | 2 808 |
| dpr2 整视口 800×600 | 1 600×1 200 | 8 534 |
| dpr1 clip(0,0,800×600) | 800×600 | 2 808 |
| dpr1 clip(0,0,6000×4000) | 6 000×4 000 | 80 062 |

要点：

- 输出尺寸完全由「请求的 DIP 矩形 × DPR × scale」决定，**不随页面内容缩放**。
- 当前 `context.ts` 的视口上限是 `MAX_WIDTH = 2560` / `MAX_HEIGHT = 1600`（`src/index.ts` 的 typebox schema 同值），DPR 上限 2。**最坏情况输出 = 5120×3200 = 16.4 M 像素**，远超旧实现的 2000px/边预算。
- 旧 Python 后端把导出图 `thumbnail` 到 2000px/边、4 MiB（`MAX_EXPORT_EDGE` / `MAX_IMAGE_BYTES` 在 `harness.ts` 的固定脚本里）。
- 因此 2.9 的最小充分方案（按 design.md 的次序）：**先把准备阶段的视口上限收紧**，使 `max(width × dpr) <= 2000` 且 `max(height × dpr) <= 2000`。DPR=2 时视口上限变成 1000×1000；DPR=1 时 2000×2000。收紧后 2 MiB 级别的小图（实测 1600×1200 只有 8.5 KB，PNG 对纯色区域压缩极好）**大概率不会再撞 4 MiB 字节上限**，也就不需要扩展侧等比缩小、不需要引入图像库。
- 若仍需要后置缩放，`clip.scale` 是唯一不用图像库的候选，但它是否生效见 3.2；`scale` 生效的话直接乘进 `clip`，否则才考虑「视口上限 + 明确失败」。

### 3.5 2.7 的事件语义实测

`diag2.mjs`（`page2.mjs` 页面：`console.error` + 未捕获异常 + 404 fetch + 不可用端口 fetch + `console.log`）：

- **`Runtime.enable` 是必需的**。只开 `Log.enable` + `Network.enable` 时 `Runtime.consoleAPICalled` 与 `Runtime.exceptionThrown` 一条都收不到：

```
A: Runtime.enable OFF { consoleApi: [], consoleApiException: [],
  log: [ 404 "Failed to load resource", net::ERR_UNSAFE_PORT ] }
B: Runtime.enable ON  { consoleApi: [ {args:["boom","Object"],type:"error"}, {args:["just a log"],type:"log"} ],
  consoleApiException: [ {text:"Uncaught", description:"Error: uncaught tok=supersecretvalue\n    at http://127.0.0.1:8766/:6:28"} ],
  log: [ net::ERR_UNSAFE_PORT, 404 ] }
```

- `console.error("boom", {a:1,b:[2,3]})` 的第二个参数在协议里是**对象描述**（`Object`），不是内容；实现里降级为字符串是正确且必要的。
- 未捕获异常的 `exception.description` 里会带上源码行（本例含 `tok=supersecretvalue`），**必须过 `sanitizeDiagnosticMessage`**，`cdp-diagnostics.ts` 已如此处理。
- `Log.enable` 在 enable 之前已经产生的事件**不会补发**（`bufferedLogAfterEnable: 1` 只是 enable 后新产生的那条）。因此 `observedFrom` 取 `prepare` 返回的时刻是诚实的上界，采集窗口不存在遗漏，但也**不能声称覆盖 prepare 之前**。
- `Network.loadingFailed` 会带 `canceled: true`（页面自己中止请求）的情况，必须排除，否则每次导航都会制造假失败。`cdp-diagnostics.ts` 已按 `canceled !== true` 过滤。
- `Network.responseReceived` 会为 `favicon.ico` 之类的隐式请求报 404 —— 这属于真实网络失败，保留，但实测记录里要写明来源。

## 4. 未完成清单（按依赖顺序）

### 4.1 收尾 2.7（先做，成本最低）

0. （已完成）`probe5.mjs` / `probe6.mjs` 已跑通，结论补进 3.2 与 3.2b。
1. 给 `CdpDiagnostics` 写受控假端点用例（`tests/helpers/fake-cdp.ts` 已有 `sendEvent`，可直接推事件）：
   - 受控错误：`Runtime.consoleAPICalled` + `Runtime.exceptionThrown` → 脱敏后入 `entries`，`truncated` 正确。
   - 请求失败：`Network.responseReceived` 404 + `Network.loadingFailed`（含 `canceled: true` 的一条必须被丢弃）。
   - 无法取得历史：`attach` 中任一 `*.enable` 被端点拒绝 → `status: "unknown"`，`entries: []`，**且与「观察过、零错误」可区分**（这是任务的验收判据原文）。
   - `sessionId` 不匹配的事件必须被丢弃（复用 2.3 的过滤语义）。
3. 把 `captureOwnedPage` 的 `CdpCaptureResult` 加上 `diagnostics` 字段并**从采集窗口真实产生**：在 `prepareOwnedPage` 里 `attach`，在 `captureOwnedPage` 里 `summarize(startedAt, endedAt)`；`prepare` 复用同一 target 时不要重复 `Runtime.enable`（会重复注册监听）。
4. 勾选 2.7，写 `docs/references/native-cdp-task-2.7.md` 实测记录（包含 3.5 的内容）。

### 4.2 2.8：`clip` 局部截图

1. `cdp-actions.ts` 的 `captureOwnedPage`：把当前写死 `format: "png"` 的单次截图改成按需两次采样：
   - 视口图：不传 `clip`（保留现有语义）。
   - 局部图：`clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 }` —— **用 `bounds` 而非 `visibleBounds`**，因为文档坐标下无需再裁剪到视口，`visibleBounds` 的语义（Clipping 到视口）由 `captureBeyondViewport` 承担。
   - 目标图与视口图必须在**同一稳定状态**下独立采样，两次之间做前后稳定性校验（导航 / 滚动 / `bounds` 变化），现有 `captureOwnedPage` 已经有这三项检查，扩展即可。
2. 删除 `context.ts` 的 `createComparisonArtifact` 对外部 `crop` 的调用与 `cropParentOffset`；删掉 `comparisonSourceRegion`；`imageArtifact` 的 `coordinateScale` 在 clip 路径下变成 `1/DPR × …`，要重新定义或直接删掉（`evidence.ts:304` 的「image coordinate mapping changed」检查依赖它）。
3. `evidence.ts` 的 `imageRegionForViewport` 语义要改：页面坐标 → 图像像素的换算从 `scrollX + x` 改成纯 `clip` 起点差；`Capture.image.sourceRegion` 应记录 clip 的文档坐标起点。
4. 真机验证：DPR 1 与 2 下，请求的页面坐标与 `probe4.mjs` 同法的像素取样一致，往返误差 ≤ 1 导出像素。
5. `image.width/height` 的 `ponytail:` 注释（`cdp-actions.ts` 约 470 行）在 2.9 完成后删除。

### 4.3 2.9：像素上限

1. 按 3.4 的结论，**首选**收紧 `context.ts` 的 `MAX_WIDTH`/`MAX_HEIGHT`（与 `src/index.ts` 的 typebox schema 同步），并把上限做成 DPR 相关的约束：`width × dpr <= 2000 && height × dpr <= 2000`。这一步会改变工具 schema 的 `maximum`（DPR=2 时 1000），属于对外可见的行为收紧，需要同步 README 与工具描述。
2. `clip.scale` 已证实生效（3.2）：若收紧视口上限仍不够（例如用户坚持要 2560 宽视口），可在采集侧乘 `scale` 把输出压到 2000px/边。注意 `scale < 1` 的坐标往返未被精确刻画，只能用于尺寸收窄，不能用于坐标校验。
3. 交付实测数据（1× 与 2× 各一组尺寸+字节数）与所选方案说明。

## 5. 闸门状态（本轮结束时的真实值）

- `pnpm typecheck`：**已重跑，0 错**（`cdp-diagnostics.ts` 的类型在 3 处修正后通过：删除了对 `CdpCaptureResult.diagnostics` 的依赖，改为本模块自带的 `CdpDiagnosticsResult`；`Log.entryAdded` 的 `text` 可空已补默认值）。
- `pnpm -w run lint`：**已重跑，0 错**，仅 2 条 `noAwaitInLoops` info（`cdp-actions.ts` 264/418，轮询循环固有，与上一轮相同）。
- `pnpm test`：**已重跑，全绿**：`Test Files 12 passed | 2 skipped (14)`，`Tests 69 passed | 6 skipped (75)`。
- 未勾选任何新任务；`tasks.md` 中 2.7–2.9 保持 `[ ]`。

## 6. 需要注意的坑

- **不要把 `clip` 当视口坐标用**。3.1 的实测明确是文档坐标；照着 `imageRegionForViewport` 现有的 `scrollX + x` 写法实现会双重偏移。
- **不要忘了 `captureBeyondViewport`**。3.3 的白色图是静默错误：图能落盘、尺寸正确、内容是空白，稳定性检查也全过。
- **`Runtime.enable` 不能省**。只开 `Log`/`Network` 会得到一个语法上合法、实际永远为空的诊断摘要 —— 这正是任务要区分的「`unknown` 与零错误」。
- **`canceled: true` 的 `Network.loadingFailed` 不是失败**。
- 真机 Chrome 用独立 `--user-data-dir`，不要碰到用户日常实例；本轮 Chrome 152 依旧没有出现授权弹窗（与任务 1.5 一致）。
