# Handoff：任务 2.10–2.11（释放路径 / 端到端路径）

> 中断时间：上下文将满。目标 change `openspec/changes/harden-visual-loop-with-native-cdp`，`tasks.md` 中 2.10 / 2.11 仍为 `[ ]`。
> **当前工作树不是绿的**：`pnpm typecheck` 0 错、`pnpm -w run lint` 0 错 + 3 info，但 `pnpm test` **9 个用例失败**，全部是测试侧未跟上的机械问题（见第 4 节）。代码侧已完成。

## 0. TL;DR

- **2.10 / 2.11 的实现主体已完成**：`VisualLoopManager` 的 `prepare` / `capture` / 区域截图 / `disconnect` 四条路径全部改走内建 CDP 动作层，不再 spawn 任何外部命令。
- 用户在本轮开始时对两个歧义点做了显式决策（第 2 节），实现按该决策走。
- **剩余工作只有测试收尾**：`tests/visual-loop-capture.test.ts` 与 `tests/visual-loop-verify-manager.test.ts` 两个文件还在断言已删除的旧形状。改完即绿。
- 未勾选 2.10 / 2.11；未提交。

## 1. 用户的显式决策（本轮开始前问过，答案如下）

| 问题 | 选择 |
| --- | --- |
| `verify()` 的「共同区域前后图」目前靠外部 `crop` 命令裁剪，去掉外部命令后怎么办？ | **本轮只接线四动作，`verify` 暂留旧 crop**。即 prepare/capture/区域截图/close 全走 CDP；`verify` 的 `commonRegion` 仍调 `runCrop`，需要配置里的 `harnessPath`。spec 未改。3.2 / 3.3 必须回收这个残留。 |
| 旧后端代码（`harness.ts` 的 spawn 路径、`config.harnessPath`、`runCrop`）本轮如何处理？ | **保留文件、只停止调用**。删除动作留给 3.1–3.3。 |

这条决策的后果已写进代码注释（`config.ts` 的 `harnessPath` 字段注释、`harness.ts` 的 `harnessCommand` 注释），两处都指向任务 3.1 / 3.2。

## 2. 已完成的实现

### 2.1 `src/visual-loop/cdp-actions.ts`

1. **`CdpCaptureResult.image` 新增 `sourceRegion`**（`CdpRegion`，文档坐标）。视口截图的实际覆盖矩形由新的私有函数 `pageRect(page: CdpPageInfo)` 给出：
   ```ts
   { height: min(page.h, page.ph - page.sy), width: min(page.w, page.pw - page.sx), x: page.sx, y: page.sy }
   ```
   **为什么需要它**：旧路径靠 `harness.mjs` 返回的 `sourceRegion` 才知道视口图覆盖了哪个文档矩形；新路径必须自己算。取 `min` 是因为 Chrome 会把 `clip` 钳到文档内，靠近右/下边缘时覆盖范围小于视口。区域截图的 `sourceRegion` 仍是元素的 `documentBounds`（2.8 已有）。
2. **抽出 `dropOwnedTarget(client, owned, targetId, sessionId)`**：无 URL 守卫的关闭原语，`closeOwnedTarget` 现在复用它（保留 URL 守卫语义）。新增 `currentOwnedUrl(...)`（读 `location.href`，目标消失时返回 `undefined`）。
   - `dropOwnedTarget` 只在「这张表里确实有它」的前提下关闭。他人标签页永远不会进 `OwnedTargets`，所以「不关闭用户标签页」的保证落在归属表上，这条注释写在函数文档里。
3. **删除了 `Target.closeTarget` 的 `success !== true` 断言**（原 `closeOwnedTarget` 内）。释放路径必须容忍「目标已经不存在」，抛错会让页面泄漏。`closeOwnedTarget` 的对外语义因此从「拒绝关闭」变成「尽力关闭」——这是一个有意的行为变更，需要写进 2.10 的实测记录。

### 2.2 `src/visual-loop/context.ts`

- `ActiveInspection` 字段变化：`owned: OwnedTargets`、`createdTargets: string[]`、`page?: CdpPageInfo`；`page?: HarnessPrepareResult["page"]` 删除。`dirs` 保留（只有 crop 用）。
- `prepare`：改为 `prepareOwnedPage(active.cdp, active.owned, {dpr,url,viewport}, signal)`；首次创建时把 `result.targetId` 推入 `createdTargets`（`hadTarget = active.targetId !== ""`）。
- `capture`：改为 `captureOwnedPage(active.cdp, active.owned, active.targetId, {...}, signal)`；`image.crop` 不再包 `parentOffset`；视口图的 `sourceRegion` 直接取 `result.image.sourceRegion`；`image.raw.byteLength` 现在填 **0**（CDP 路径没有中间父图，`rawHeight/rawWidth` 仍保留）。
- `disconnect`：`this.active = undefined` → `epoch += 1` → abort 全部 controller → `await active.queue` → 遍历 `createdTargets` 逐个 `dropOwnedTarget` → 关闭连接 → 释放锁 → 删除私有目录。**不结束浏览器进程、不删用户配置目录。**
- 删除 `cropParentOffset`、`cleanupHarness`；`formatPrepareResult` 去掉 `protocolVersion` 字段。
- 仍保留 `createComparisonArtifact` / `runCrop` / `comparisonSourceRegion` / `imageRegionForViewport`（用户决策：verify 暂留旧 crop）。

### 2.3 `src/visual-loop/evidence.ts`

- `ImageArtifact` 新增 `sourceRegion` 语义注释；`Capture["image"]["crop"]` 去掉 `parentOffset`。
- `imageRegionForViewport` 语义**改写了**：视口图恰好覆盖整个视口，所以返回整图 `{0,0,width,height}`（`_viewportRegion` 参数保留但不再用，因旧 crop 仍按图像像素取值）。原实现依赖 `coordinateScale + scrollX` 换算，那是旧后端的显示像素换算，按 2.8 handoff 的要求应当删除。
- `compareCaptureConditions` 的「image coordinate mapping changed」检查保留，但现在 `sourceRegion` 两条路径都是文档坐标，比较是真实的。

### 2.4 `src/visual-loop/config.ts`

- `VisualLoopConfig.harnessPath` 改为**可选**；`loadConfig` 只要求 `cdpUrl`，缺失时的诊断文案从 `set cdpUrl and harnessPath` 收紧为 **`visual loop is not configured: set cdpUrl`**。
- 旧字段仍被解析（`harnessPath` 存在时照样校验并合并），**未做迁移期拒绝**——那是 3.1 的交付面。

### 2.5 `src/visual-loop/harness.ts`

- 新增私有 `harnessCommand(config)`：`harnessPath` 缺失时抛 `legacy browser backend path is not configured`，避免 spawn `undefined`。`runHarness` 与 `reloadHarness` 都改用它。

### 2.6 测试侧已完成的部分

- **`tests/helpers/fake-cdp.ts` 新增 `fakePage(options)`**：一个假 Chrome 端点，回答四个动作真正发出的 CDP 调用（`Target.createTarget/attachToTarget/getTargetInfo/closeTarget`、`Page.captureScreenshot`、`Emulation.setDeviceMetricsOverride`、`Runtime.evaluate` 的 8 个表达式分支）。它跟踪 `dpr` 与视口尺寸（`setDeviceMetricsOverride` 生效后 `pageInfo` 上报新值），导出 `FAKE_PNG`。
- **`tests/visual-loop-cdp-lifecycle.test.ts` 重写**：7 个用例，全部通过。覆盖重复 prepare 复用连接与目标、端点不可达、close 后拒绝采集、DPR 2 视口上限、释放只关自有目标（显式断言 `closed === ["owned-1"]` 且不含 `stranger-tab`）、abort 在途 prepare、reload 式 reset 后重连。

## 3. 剩余工作（按顺序，都是机械修复）

### 3.1 `tests/visual-loop-verify-manager.test.ts`（5 个用例全红）

错误：`browser did not return a created target`。原因：该文件仍写 `harnessPath` 指向一个假 Node harness 脚本，但 manager 已经不再 spawn 它，改为直连端点；它的 `fakeCdp()` 是无参调用（默认 handler 返回 `{}`），所以 `Target.createTarget` 拿不到 `targetId`。

**做法**：照 `tests/visual-loop-cdp-lifecycle.test.ts` 的模式重写。

- `import { fakePage }` 替代 `fakeCdp`；`project()` 里删掉 `harnessPath`。
- 该文件用 `mode: "stable" | "changed" | "target-lost" | "failed"` 驱动场景，`fakePage` 已支持前两者的等价参数：
  - `"stable"` → `fakePage()`。
  - `"changed"` → `fakePage({ urlAfter: "http://127.0.0.1:8765/changed" })`（第 2 次 `pageInfo` 读开始返回 `urlAfter`，而 `captureOwnedPage` 正好读两次 → 触发 `page URL changed during capture`）。
  - `"target-lost"` → 需要给 `fakePage` 加一个选项（例如 `targetLostAfter?: number`），让第 N 次 `getComputedStyle` 求值返回 `{ error: "no-match" }` / `querySelectorAll` 返回 `null`。**这是唯一需要扩 `fakePage` 的地方。**
  - `"failed"` → 给 `fakePage` 加 `failAfter?: number`，让第 N 次 `Page.captureScreenshot` 返回 CDP error。
- 断言要跟着改：
  - `result.comparison.commonRegion` 现在仍由旧 crop 路径产出，但那需要 `harnessPath`。**用户决策允许保留**，所以这个用例要么继续给 `harnessPath` 指向一个最小假 harness（只为 `crop` 动作写文件），要么把 `commonRegion` 断言放宽为 `toBeDefined()`。**倾向前者**：假 harness 只需处理 `action: "crop"`，写 1 字节文件并输出 `{ok:true,protocolVersion:1,path,width:1,height:1}`。
  - `"keeps the failure reason and does not create a blank crop"` 用例依赖 `"failed"` 模式在第 3 次调用失败。

### 3.2 `tests/visual-loop-capture.test.ts`（4 个用例红）

错误：`(0 , cropParentOffset) is not a function`。`cropParentOffset` 已从 `context.ts` 删除。

**做法**：
1. 删掉 import 里的 `cropParentOffset`。
2. 删掉整个 `describe("crop coordinate mapping", ...)` 块（文件尾部，约 290–346 行）。它测的是「原始父图 → 导出图」的两次缩放往返，该中间产物在 CDP 路径不存在。**替代覆盖已由 `tests/visual-loop-cdp-actions.test.ts` 的 clip 断言承担**（DPR 1/2 往返 0 像素，2.8 真机实测）。
3. 约 242 行的 `expect(captured.image.crop?.parentOffset).toEqual({...})` 删除；保留同用例里的 `sourceRegion` 断言（那是仍然存在的契约）。

### 3.3 `tests/.task3-real.test.ts`（4 个用例 skipped，但会被收集）

引用 `capture.image.crop?.parentOffset`（约 124/127 行）。文件被 `describe.skip` 或命名约定跳过，但 `pnpm typecheck` 不覆盖 `tests/`，所以它现在不会报错——**不过它已经是死代码**。要么删掉两处断言，要么整体删文件。建议在 3.3 一并处理（它测的是旧后端的 4 MiB / 2000px 预算与 parentOffset，全部失效）。

## 4. 当前闸门真实值

```
pnpm typecheck     0 错
pnpm -w run lint   0 错 + 3 info（cdp-actions 302/476、context 735，均为轮询/顺序释放循环固有）
pnpm test          Test Files 6 failed | 7 passed | 2 skipped (15)
                   Tests      9 failed | 46 passed | 6 skipped (61)
```

失败清单（全部属第 3 节）：

- `tests/visual-loop-capture.test.ts`：4 个（`cropParentOffset`）
- `tests/visual-loop-verify-manager.test.ts`：5 个（假端点未接）

已绿：`cdp-actions`(10)、`cdp-client`(3)、`cdp-diagnostics`(7)、`cdp-lifecycle`(7)、`harness`(3)、`feedback`(14)、`endpoint-lock`(5)、`tool`(7)、`evidence`(4)、`config`(3)、`verification`(5)。

## 5. 2.10 / 2.11 的验收判据对照

任务原文：

- **2.10**：「实现连接与资源的释放路径:取消在途操作、关闭自有标签页与连接,不结束浏览器进程、不删除用户配置目录;用断开与重载两种情况验证,并确认其他标签页仍打开。」
- **2.11**：「实现无外部运行时要求的端到端路径:覆盖准备、采集、裁剪、关闭四个动作;验证方式:在未安装 Python 与浏览器自动化命令行工具的前提下完成全部动作,且 `node_modules` 运行时依赖增量为零。」

已具备：

| 判据 | 状态 |
| --- | --- |
| 取消在途操作 | 已实现（abort controllers → `await active.queue`）；`cdp-lifecycle` 有用例 |
| 关闭自有标签页与连接 | 已实现（`dropOwnedTarget` + `client.close()`） |
| 不结束浏览器进程 / 不删配置目录 | 已实现（代码里不存在这类调用）；需在实测记录中显式写明 |
| 断开与重载两种情况 | `cdp-lifecycle` 有 `disconnect` 与 `resetSession` 用例；**真机证据待补** |
| 其他标签页仍打开 | 假端点用例已断言；**真机证据待补** |
| 四动作端到端 | prepare / capture / 区域截图 / close 全走 CDP；crop 仍留旧路径（用户决策） |
| 无外部运行时要求 | 需真机验证：临时把 `harnessPath` 指向不存在的路径（或删掉该键），仍能跑完全部动作 |
| 依赖增量为零 | 需核对 `pnpm-lock.yaml` 与 `package.json` 未新增运行时依赖；`node_modules` 无新增（`@earendil-works/*`、`typebox` 仍是 peer） |

## 6. 真机验证脚本（下一步要写）

参考 `docs/references/native-cdp-probes/budget.mjs` 的结构（相对导入 `../../src/visual-loop/*.ts`，用 `node --experimental-strip-types`）。需覆盖：

1. 启动专用 Chrome（独立 `--user-data-dir`，别碰用户日常实例）+ 一个本地页面服务。
2. **打开一个额外标签页作为「他人标签页」bystander**，记下它的 targetId。
3. 装一个临时项目配置：`~/.pi` 或 `<cwd>/.pi/xpi-visualoop.json` 只含 `cdpUrl`（**故意不给 `harnessPath`**）→ 这是 2.11「无外部运行时要求」的直接证据。
4. 走 `VisualLoopManager` 的 `prepare` → `capture`（无 selector）→ `capture`（带 selector，验区域图）→ `disconnect`。
5. 采集后断言：bystander target 仍存在（`Target.getTargetInfo` 成功）；自有 target 已消失；Chrome 进程 pid 仍存活；独立 profile 目录仍存在。
6. 在 `disconnect` 前先 `disconnect` 一次再调 `capture`，确认抛 `not prepared`（重载式语义）。

建议脚本名 `docs/references/native-cdp-probes/release.mjs`，记录文档 `docs/references/native-cdp-task-2.10-2.11.md`。

## 7. 需要写进实测记录的行为变更（重要）

1. **`closeOwnedTarget` 不再断言 `success === true`**，改为「尽力关闭并总是从归属表移除」。理由是释放路径不能因目标已消失而抛错（会泄漏页面）。`closeOwnedTarget` 的对外错误语义因此变软。
2. **`image.raw.byteLength` 在 CDP 路径恒为 0**。旧后端有中间父图，新路径没有。字段保留是为了不破坏 `EvidenceStore` 的磁盘预算计算。
3. **`prepare` 的返回不再带 `protocolVersion`**（旧固定协议版本号对内建客户端没有意义）。`formatPrepareResult` 的 JSON 少一个键。
4. **`loadConfig` 不再要求 `harnessPath`**，诊断文案改为 `set cdpUrl`。`harnessPath` 仍被接受与校验，直到 3.1 做迁移拒绝。
5. **`imageRegionForViewport` 语义改写**：视口图 = 整图。旧的显示像素换算（`coordinateScale + scrollX`）已删。`coordinateScale` 字段保留仅为旧 crop 路径服务。

## 8. 已知缺口（不属 2.10 / 2.11）

- **`verify()` 的 `commonRegion` 仍依赖外部 `crop`**（用户决策）。3.2 删 `harness.ts` 时必须同时给出替代（手写零依赖 PNG 裁剪，或改 spec 语义）。
- **`config.ts` 未做 `harnessPath` 的迁移拒绝** → 3.1。
- **`tests/.task3-real.test.ts` 与 `tests/.task2-real.test.ts`** 是旧后端时代的跳过用例，需在 3.3 清理。
- **`tsconfig.json` 的 `include` 不含 `tests/**`**，所以测试文件的类型错误不会进 `pnpm typecheck`（2.8 记录里已提过一次，仍未处理）。
- `src/visual-loop/redact.ts` 已抽出但与 `harness.ts` 的私有副本并存 → 3.2 收敛。
