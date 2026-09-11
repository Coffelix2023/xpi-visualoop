# 实测记录：任务 2.9（输出像素上限）

> 执行时间 2026-09-11 06:30 CST。实现位于 `src/visual-loop/context.ts`（视口上限收紧）、`src/visual-loop/cdp-actions.ts`（`regionScale` clamp）、`src/index.ts`（typebox schema）。
> 证据来源：真实 Chrome 152（`docs/references/native-cdp-probes/budget.mjs`）、受控假端点（`tests/visual-loop-cdp-actions.test.ts`、`tests/visual-loop-cdp-lifecycle.test.ts`）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56） |
| Node | `v24.20.0` |
| Chrome | `152.0.7977.84`（headless=new） |
| 端点 | `http://127.0.0.1:9556/`，专用 profile `/tmp/xpi-visualoop-probe-25/profile` |
| 测试页面 | `page3.mjs`（8767，100×100 网格）、`page4.mjs`（8768，800×3000 渐变列 + 底部标记块） |
| 字节数 | 来自 `captureOwnedPage` 结果的 `image.byteLength`（PNG 落盘尺寸） |

## 2. 决策

### 2.1 视口上限收紧为「导出边 ≤ 2000 设备像素」

design.md 的次序是：先收紧准备阶段视口上限，仍超限才做扩展侧等比缩小。上限与 DPR 耦合：

- `MAX_EXPORT_EDGE = 2000`（`context.ts` 导出，与旧 Python 后端的 `MAX_EXPORT_EDGE`/`MAX_IMAGE_BYTES` 预算同源）。
- prepare 时 `maxViewportEdge = MAX_EXPORT_EDGE / dpr`：DPR 1 → 2000×2000，DPR 2 → 1000×1000。
- `src/index.ts` 的 typebox schema `maximum` 同步为 2000（CSS 像素静态上限），并在 description 写明 DPR 2 下有效上限是 1000——**这是对外可见的行为收紧**。

真机确认收紧后最大输出为 2000×2000，实测仅 16.6 KB（PNG 对这类 UI 画面压缩极好），远低于旧后端 4 MiB 字节预算 → **扩展侧等比缩小不引入**，零图像依赖维持。

### 2.2 局部图（元素区域）用 `clip.scale` 兜底

元素可以大于视口（`captureBeyondViewport: true` 路径），输出 = documentBounds × DPR × scale，**视口上限管不住它**。因此动作层对区域截图按 `regionScale(documentBounds, dpr)` 计算缩放：

```ts
const edge = Math.max(region.width, region.height) * dpr;
if (edge <= MAX_EXPORT_EDGE) return 1;
return Math.min(1, (MAX_EXPORT_EDGE / edge) * SCALE_EPSILON);
```

语义边界（handoff 3.2 已实测固定）：`scale < 1` 只做尺寸收窄，**不参与坐标往返校验**（缩小时的像素采样映射非线性）。`scale: 1` 路径的往返误差判据已在 2.8 验证（0 像素），本轮真机复跑仍全绿。

### 2.3 顺手收敛

DPR 的读取从结果组装处提前到截图前（`captureOwnedPage` 开头一次 `Runtime.evaluate`），region scale 计算与结果字段共用同一读数——净增 0 次往返。`cdp-actions.ts` 里 `ponytail: budget scaling lands in task 2.9` 注释按 handoff 清单删除。

## 3. 真机实测数据（budget.mjs）

| 用例 | 采集 | 输出 | 字节 | 判定 |
| --- | --- | --- | --- | --- |
| A | DPR 1，视口 2000×2000（上限） | 2000×2000 | 16 627 | OK |
| B2 | DPR 2，视口 1000×1000（上限） | 2000×2000 | 16 642 | OK |
| C | DPR 1，元素 800×3000（超限 1.5×） | 533×1998（scale 兜底） | 15 912 | OK，白像素 0 |
| D | DPR 2，元素 1000×3000（设备边 6000） | 533×1998（scale 兜底） | 15 912 | OK |
| D2 | DPR 2，元素 800×50（预算内，滚动到底后） | 1600×100 | 792 | OK，末像素 (200,40,60) 精确命中标记色 |

```
A dpr1 viewport 2000x2000  OK  out=2000x2000 bytes=16627
B2 dpr2 viewport 1000x1000  OK  out=2000x2000 bytes=16642
C dpr1 element 800x3000 clamped  OK  out=533x1998 bytes=15912 whitePx=0
D dpr2 element 1000x3000 clamped  OK  out=533x1998 bytes=15912
D2 bottom marker readable  OK  out=1600x100 lastPx=(200,40,60) bytes=792
ALL OK
```

要点：

1. **所有路径的输出边都 ≤ 2000 设备像素**，字节都在 20 KB 以内，距 4 MiB 字节预算有三个数量级余量。
2. C 的 `whitePx=0`：clamp 后的截图内容非空白（`captureBeyondViewport: true` 依然生效，渐变取到真实灰度）。
3. D2 先 `scrollTo` 到底再采集，`#bottom` 的 sourceRegion 仍是文档坐标（y=2950），输出末像素与页面标记色一致——scroll 无关性在 tall 页复验。

## 4. 探针层修正说明

- 初版探针把「DPR 2 拒绝 2000 宽视口」放在动作层实测——输入校验属 manager 层（`normalizePrepareInput`），动作层不做该校验。该断言移入 `tests/visual-loop-cdp-lifecycle.test.ts`（fake harness 路径），真机探针只测动作行为。
- 初版 D2 未滚动导致 `#bottom` 触发既有 `outside-viewport` 语义（非回归，按设计拒绝）；改为先滚动到元素可见。
- page4 的标记块用了绝对定位，不撑开 `body.scrollHeight`，滚动用 `documentElement.scrollHeight`。

## 5. 测试与闸门

| 文件 | 变更 |
| --- | --- |
| `tests/visual-loop-cdp-lifecycle.test.ts` | 新增：DPR 2 拒绝 1500 宽视口（错误文案钉死 `320 and 1000`），1000×1000 通过 |
| `tests/visual-loop-cdp-actions.test.ts` | 新增：oversized 元素（1000×3000）走 clamp，断言 clip 参数、scale 值 = (2000/3000)×0.999、sourceRegion 保持页面真值 |
| `docs/references/native-cdp-probes/budget.mjs` / `page4.mjs` | 真机探针归档（相对导入） |

```
pnpm typecheck   0 错
pnpm -w run lint 0 错 + 2 info（轮询循环固有，与 2.8 相同）
pnpm test        Test Files 13 passed | 2 skipped (15)；Tests 79 passed | 6 skipped (85)
openspec validate  Change 'harden-visual-loop-with-native-cdp' is valid
```

## 6. 验收判据对照

任务原文：**「分别以设备像素比 1 和 2 采集,确认输出尺寸与字节数落在预算内;超限时先收紧准备阶段的视口上限,仍超限则在扩展侧做等比缩小;交付实测数据与所选方案」**。

| 判据 | 结果 |
| --- | --- |
| DPR 1 / DPR 2 各实测 | 通过（A/B2/D2 + 2.8 roundtrip 复跑） |
| 输出尺寸落在预算内 | 通过，所有路径 ≤ 2000 设备像素/边 |
| 字节数落在预算内 | 通过，最大 16 642 B ≪ 4 MiB |
| 超限时先收紧视口上限 | 已实施（DPR 耦合上限，schema 同步） |
| 仍超限则扩展侧缩小 | 不需要——区域截图用 `clip.scale` 收窄即可，不引入图像库；真机数据支持 |
| 交付实测数据与所选方案 | 本文档 |
