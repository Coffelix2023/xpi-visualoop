# 实测记录：任务 2.8（clip 局部截图）

> 执行时间 2026-09-11 06:10 CST。实现位于 `src/visual-loop/cdp-actions.ts` 的 `captureImage` 与 `captureOwnedPage`。
> 证据来源：真实 Chrome 152 逐像素校验（`/tmp/xpi-visualoop-probe-25/clip-roundtrip.mjs`、`clip-boundary.mjs`）、受控假端点（`tests/visual-loop-cdp-actions.test.ts`，9 个用例）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56） |
| Node | `v24.20.0` |
| Chrome | `152.0.7977.84` |
| 端点 | `http://127.0.0.1:9556/`，专用 profile `/tmp/xpi-visualoop-probe-25/profile`，`--headless=new` |
| 测试页面 | `docs/references/native-cdp-probes/page3.mjs` → `http://127.0.0.1:8767/`（100×100 网格，每格颜色唯一编码自身页面坐标） |
| 像素解码 | `docs/references/native-cdp-probes/png.mjs`（自写非交错 PNG 解码器，仅用 Node 内置 `zlib`） |

## 2. 实现

### 2.1 坐标口径：clip 用**文档坐标**

`Page.captureScreenshot` 的 `clip` 实测按文档坐标（DIP）解释（上一轮 `probe4.mjs` 已证）。而元素矩形来自 `getBoundingClientRect()`，是**视口坐标**。两者差一个滚动偏移。

因此在页面脚本的**同一次求值**内同时取矩形与滚动量，直接算出文档坐标：

```js
const rect = element.getBoundingClientRect();
return {documentBounds: {x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height}};
```

**为什么必须在同一次求值内**：若先取 `rect` 再单独读 `scrollY`，两步之间发生滚动就会得到一个混合了两个时刻的坐标，clip 静默偏移。放进一次求值后，这个竞态不存在。

`CdpTargetInfo` 因此同时带 `bounds`（视口坐标，对外语义不变）与 `documentBounds`（文档坐标，clip 用）。

### 2.2 两次采样

| 采样 | clip | 用途 |
| --- | --- | --- |
| 视口图 | 不传 `clip` | 保留现有语义，产出 `image.path` |
| 局部图 | `target.documentBounds` + `captureBeyondViewport: true` + `scale: 1` | 产出 `image.crop` |

两者是**独立采样**，不是「先截全图再裁剪」。这一点是刻意的：没有图像库时无法事后裁剪，而 `clip` 本就支持直接取区域。

### 2.3 `captureBeyondViewport` 不可省

不传该参数时，`clip` 落在视口外的部分返回**纯白**，同时尺寸、字节数、稳定性检查全部正常。这是静默错误——图能落盘、看起来是有效证据，内容是空白。已实测固定（上一轮 `probe3.mjs`/`probe5.mjs`），并在代码注释与测试断言中各留一处。

### 2.4 稳定性校验

在既有三项（导航、滚动、目标边界变化）之上，把边界比较的基准从 `bounds` 换成 `documentBounds`，与 clip 使用的口径一致。两次采样之间任一变化都进 `reasons` 并置 `degraded`。

## 3. 真机逐像素验证

### 3.1 往返校验（`clip-roundtrip.mjs`）

选择器 `body > div:nth-child(43)` → 网格 row 5 / column 2 → 页面坐标 (200, 500)，该格颜色 `rgb(100,60,70)`。

```
A dpr1 scrollY0 out=100x100 want=100  OK
  sourceRegion={"height":100,"width":100,"x":200,"y":500}
  origin  out(0,0)=(100,60,70)  want_page(200,500)=(100,60,70)  OK
  corner  out(99,99)=(100,60,70)  want=(100,60,70)  OK
B dpr1 scrollY250 out=100x100 want=100  OK
  sourceRegion={"height":100,"width":100,"x":200,"y":500}
  origin  out(0,0)=(100,60,70)  want_page(200,500)=(100,60,70)  OK
  corner  out(99,99)=(100,60,70)  want=(100,60,70)  OK
C dpr2 scrollY0 out=200x200 want=200  OK
  sourceRegion={"height":100,"width":100,"x":200,"y":500}
  origin  out(0,0)=(100,60,70)  want_page(200,500)=(100,60,70)  OK
  corner  out(199,199)=(100,60,70)  want=(100,60,70)  OK

ALL OK
```

要点：

1. **A 与 B 的 `sourceRegion` 完全相同**（`x:200, y:500`），尽管 B 的滚动位置是 250。这就是「clip 用文档坐标」的直接证据：滚动不改变页面坐标到像素的映射，也不改变我们请求的区域。
2. **输出像素 = clip 尺寸 × DPR**（`scale` 固定为 1）：100 → 100（DPR 1）、100 → 200（DPR 2）。
3. 单元测试里的期望值 `x:270, y:280` 来自「视口坐标 20,30 + 滚动 250,250」，此处真机用页面坐标直接对齐，两条路径互相印证。

### 3.2 边界校验（`clip-boundary.mjs`）

纯色块无法判别边界位置，故改为**跨格边界逐像素比对**：网格在文档 x=300 处换列，导出坐标即 `300 × DPR`。取边界两侧相邻两像素与页面颜色对照。

```
dpr1 out=800x600 boundary@x=300
  x=299 (100,60,70) want (100,60,70) OK
  x=300 (100,90,80) want (100,90,80) OK
dpr2 out=1600x1200 boundary@x=600
  x=599 (100,60,70) want (100,60,70) OK
  x=600 (100,90,80) want (100,90,80) OK
BOUNDARY OK (0 px error)
```

**往返误差 0 像素**，优于任务要求的「不超过一个导出像素」。DPR 1 与 2 各一次，满足验收判据。

## 4. 验收判据对照

任务原文：**「在设备像素比 1 与 2 下验证裁切覆盖范围与请求的页面坐标一致，往返误差不超过一个导出像素」**。

| 判据 | 结果 |
| --- | --- |
| DPR 1 覆盖范围一致 | 通过，误差 0 像素 |
| DPR 2 覆盖范围一致 | 通过，误差 0 像素 |
| 请求的页面坐标 ↔ 输出像素 | 通过（`clip-roundtrip.mjs`，含滚动场景） |

## 5. 与任务原文的偏差（需说明）

任务 2.8 原文包含**「删除现有的显示像素换算与外部裁剪调用」**。本轮**未执行这一步**，原因：

- `context.ts` 的 `VisualLoopManager` 仍走旧 harness 路径（`runPrepare` / `runCapture` / `runCrop`），管理器接线到 CDP 动作层属任务 2.10 / 2.11。
- 现在删除 `createComparisonArtifact`、`cropParentOffset`、`evidence.ts` 的显示像素换算会立即打断 `verify()`，`tests/visual-loop-verify-manager.test.ts` 4 个用例转红。

因此本轮把 2.8 的交付面收敛为**动作层**：CDP 路径内实现 clip、局部截图、采样间稳定性校验，产出与旧实现同构的 `image.crop`（含 `sourceRegion`），使 2.10 的接线成为无缝替换。旧路径的删除随旧后端在 **3.2** 一起完成。

这一偏差在动手前向用户确认过，选择的是「保持 `pnpm test` 全程绿」的方案。

## 6. 测试

| 文件 | 用例数 | 新增内容 |
| --- | --- | --- |
| `tests/visual-loop-cdp-actions.test.ts` | 9 | 主采集用例改为断言两次 `Page.captureScreenshot` 的完整参数（含 `captureBeyondViewport: true` 与 clip 文档坐标）、`image.crop.sourceRegion`、局部图落盘 |

主用例把 clip 请求**完整**断言下来，而非只查尺寸，这样「忘了 `captureBeyondViewport`」或「忘了加滚动偏移」都会立刻变红。

## 7. 闸门

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 0 错 |
| `pnpm -w run lint` | 0 错，2 条 `noAwaitInLoops` info（轮询循环固有） |
| `pnpm test` | `Test Files 13 passed \| 2 skipped (15)`，`Tests 77 passed \| 6 skipped (83)` |

## 8. 顺手修掉的两处既有类型错误

`tsconfig.json` 的 `include` 只有 `src/**/*`，**`tests/` 不在 `pnpm typecheck` 的检查范围内**。本轮改动了测试文件，改用「临时扩展 include」的方式单独校验 `tests/`，发现两处既有类型错误（均在本 change 新增的文件里，非本轮引入）：

1. `tests/helpers/fake-cdp.ts`：`let leftover = Buffer.alloc(0)` 推断为 `Buffer<ArrayBuffer>`，与 `decodeFrames` 返回的 `Buffer<ArrayBufferLike>` 不兼容 → 显式标注 `let leftover: Buffer`。
2. `tests/visual-loop-cdp-actions.test.ts`：`pageAfter?: Record<string, number> & { url?: string }` 的索引签名排除了 `url`，`{url: "..."}` 无法赋值 → 引入 `PageInfoOverrides` 具名类型。

**建议**（不在本任务范围）：把 `tests/**/*` 纳入 `pnpm typecheck` 的检查范围，否则测试文件的类型错误会持续逃过闸门。见下方遗留项。
