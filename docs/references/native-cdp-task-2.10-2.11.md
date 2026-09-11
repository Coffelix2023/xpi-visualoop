# 实测记录：任务 2.10–2.11（释放路径 / 无外部运行时的端到端路径）

> 执行时间 2026-09-12（本地时区）。实现位于 `src/visual-loop/context.ts`（释放路径）、`src/visual-loop/cdp-actions.ts`（四动作）、`src/visual-loop/config.ts`（`harnessPath` 转可选）。
> 证据来源：真实 Chrome 152（`docs/references/native-cdp-probes/release.mjs`）、受控假端点（`tests/visual-loop-cdp-lifecycle.test.ts`、`tests/visual-loop-verify-manager.test.ts`）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56） |
| Node | `v24.20.0` |
| Chrome | `152.0.7977.84`（`/Applications/Google Chrome.app`，headless=new） |
| 端点 | `http://127.0.0.1:9557/`，专用 profile `/tmp/xpi-visualoop-probe-release/profile` |
| 测试页面 | `release.mjs` 内联服务（8769）：3000px 高页面 + 绝对定位 `#target`（40,60,120×50），无第三方资源 |
| 配置 | `PI_CODING_AGENT_DIR` 指向空目录，项目配置 `<cwd>/.pi/xpi-visualoop.json` **只含 `cdpUrl`，无 `harnessPath`** |
| 运行方式 | `node --experimental-transform-types docs/references/native-cdp-probes/release.mjs` |

`--experimental-transform-types` 而非 `--experimental-strip-types`：`EvidenceStore` 用了 TypeScript 的构造参数属性（parameter property），strip-only 模式拒绝该语法。这是探针的运行方式，不影响扩展（Pi 自己加载 TS 源码）。

## 2. 2.10 释放路径

### 2.1 实现语义（`VisualLoopManager.disconnect`）

顺序固定，每一步都不允许影响浏览器进程：

1. `this.active = undefined` 后 `epoch += 1` —— 立刻让所有在途操作在下一个检查点失效。
2. abort 全部登记的 controller（`serial()` 每次入队登记一个）。
3. `await active.queue` —— 等在途操作真正退出，避免释放与运行时写盘竞争。
4. 遍历 **`createdTargets`**（本会话创建过的自有页），逐个 `dropOwnedTarget`。
5. `active.cdp.close()` 关连接。
6. 关闭并删除端点锁文件。
7. 删除私有临时目录（`removePrivateHarnessDirs`，已无 harness 内容，仅剩截图落盘目录）。

**不存在** `process.kill`、`Browser.close`、`--user-data-dir` 删除、`rm` 用户配置目录的调用。

### 2.2 行为变更（有意，需记录）

| 变更 | 旧行为 | 新行为 | 理由 |
| --- | --- | --- | --- |
| `closeOwnedTarget` 的错误语义 | 断言 `Target.closeTarget` 返回 `success === true`，不满足则抛错 | 「尽力关闭并总是从归属表移除」 | 释放路径不能因目标已消失抛错，否则页面泄漏 |
| 归属保证的落点 | URL 守卫（关之前读 `location.href` 比对） | **归属表**：他人标签页永不进 `OwnedTargets`，释放只遍历 `createdTargets` | URL 守卫在目标已消失时无法通过，释放路径必须绕过；归属表本身已是充分条件 |

`closeOwnedTarget`（带 URL 守卫）仍保留给交互式关闭路径；`disconnect` 用无守卫的 `dropOwnedTarget`。

### 2.3 真机实测数据（release.mjs）

```
1 prepare without harnessPath  OK  targetId=378D44C59F7D75FEDBC95ABE3E464A77 viewport=800x600 dpr=1
2 capture viewport  OK  out=800x600 region={"height":600,"width":800,"x":0,"y":0} bytes=2823
3 capture region (in-process crop)  OK  crop=120x50 sourceRegion={"height":50,"width":120,"x":40,"y":60}
4 rejects capture after disconnect  OK  error="visual loop is not prepared"
5 bystander tab still open  OK  bystander=AE084014337F70752096EA41FAC78B7C survived=true
6 own tab closed  OK  owned=378D44C59F7D75FEDBC95ABE3E464A77 gone=true openTabs=6
7 browser process untouched  OK  pid=87467 alive=true
8 profile directory kept  OK  profile=/tmp/xpi-visualoop-probe-release/profile exists=true
ALL OK
```

判据对照：

| 验收要求 | 证据 |
| --- | --- |
| 取消在途操作 | 用例 4 证 `epoch` 提升后同一 manager 拒绝新操作；在途取消由 `tests/visual-loop-cdp-lifecycle.test.ts` 的「cancels an in-flight prepare」用例覆盖（abort 后 prepare 掷错、连接仍被释放） |
| 关闭自有标签页与连接 | 用例 6：自有 target 已从 `/json/list` 消失 |
| 不结束浏览器进程 | 用例 7：`disconnect` 后 pid 87467 `kill(pid, 0)` 成功 |
| 不删除用户配置目录 | 用例 8：专用 profile 目录仍在（该目录由探针启动的 Chrome 拥有，扩展全程未触碰） |
| 其他标签页仍打开 | 用例 5：`Target.getTargetInfo` 对 bystander 成功返回；`/json/list` 在释放后仍有 6 个条目（bystander + headless 自带页） |
| 断开与重载两种情况 | 用例 4 是断开语义；重载语义由 `resetSession()`（= `disconnect`）承载，`tests/visual-loop-cdp-lifecycle.test.ts` 的「reconnects cleanly after a reload-style reset」断言 `connectHits === 2` |

`createdTargets` 只在 `prepare` 首次创建目标时推入（`hadTarget = active.targetId !== ""`），重复 `prepare` 复用同一页不会重复登记——`tests/visual-loop-cdp-lifecycle.test.ts`「reuses one connection and one owned page across repeated prepare」断言 `targetId === "target-1"` 且 `connectHits === 1`。

## 3. 2.11 无外部运行时要求的端到端路径

### 3.1 四动作全部走内建 CDP

| 动作 | 实现 | 旧路径 |
| --- | --- | --- |
| 准备 | `prepareOwnedPage`：`Target.createTarget` + `Target.attachToTarget` + `Emulation.setDeviceMetricsOverride` + `Page.navigate` + 轮询 `document.readyState` | spawn Python `browser_harness` |
| 采集（视口） | `Page.captureScreenshot`（无 clip）+ `pageInfo` 前后稳定性校验 | 同上，再经 PIL 缩放导出 |
| 裁剪（区域） | 同会话 `Page.captureScreenshot` + `clip: documentBounds` + `captureBeyondViewport: true` | 采集父图后再 `PIL.Image.crop` |
| 关闭 | `Target.closeTarget` + `Target.detachFromTarget` | spawn Python `close_tab` |

**裁剪不再是「采集后再切割」**：区域图由浏览器按元素坐标直接重采样，因此 `capture.image.crop.parentOffset`（原始父图内的偏移）没有意义，字段已删除；`crop.sourceRegion` 仍是元素的文档坐标。用例 3 实测 `sourceRegion = {x:40, y:60, w:120, h:50}` 与页面 CSS 完全一致。

### 3.2 无外部运行时的直接证据

- 探针配置文件只写 `cdpUrl`；`loadConfig` 对缺失 `harnessPath` 不再报错（诊断文案为 `visual loop is not configured: set cdpUrl`）。
- 全部 8 条用例（含四动作）在该配置下通过 → 无 Python、无浏览器自动化 CLI、无 PIL。
- `harness.ts` 的 spawn 路径**保留但已无调用方**：`capture` / `prepare` / `disconnect` 均不再引用 `runHarness`。`harnessPath` 缺失时 `harnessCommand` 抛 `legacy browser backend path is not configured`，避免 spawn `undefined`。

### 3.3 依赖增量为零

| 检查 | 结果 |
| --- | --- |
| `package.json` `dependencies` | 不存在（仍是 `peerDependencies` + `devDependencies` 两块） |
| `peerDependencies` | `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`，三项均为 `optional: true`，与迁移前一致 |
| `pnpm-lock.yaml` | 本轮无 diff（`git diff --stat pnpm-lock.yaml` 为空） |
| CDP 传输 | Node 内置 `WebSocket` / `fetch`（`src/visual-loop/cdp.ts`、`config.ts`），未引入 `ws` / `chrome-remote-interface` / `puppeteer` |
| 截图解码 | 只用内置 `Buffer`；PNG 尺寸解析为手写的 24 字节 IHDR 读取（`cdp-actions.ts` 的 `pngSize`） |

## 4. 遗留（不在 2.10 / 2.11 范围）

- **`verify()` 的 `commonRegion` 仍调外部 `crop`**（本轮用户显式决策：只接线四动作）。因此 `tests/visual-loop-verify-manager.test.ts` 保留一个最小假 harness，只实现 `action: "crop"`。**3.2 必须回收**：删 `harness.ts` 时同时给出替代（手写零依赖 PNG 裁剪，或改 spec 语义）。
- **`config.ts` 未做 `harnessPath` 的迁移拒绝**，旧字段仍被解析与校验 → 3.1。
- **`tests/.task2-real.test.ts` / `tests/.task3-real.test.ts`** 是旧后端时代的跳过用例，`tests/.task3-real.test.ts` 还引用已删除的 `crop.parentOffset` → 3.3 清理。
- **`tsconfig.json` 的 `include` 不含 `tests/**`**，测试文件的类型错误不进 `pnpm typecheck`（2.8 起记录，仍未处理）。
- `src/visual-loop/redact.ts` 与 `harness.ts` 的私有脱敏副本并存 → 3.2 收敛。

## 5. 测试与闸门

| 文件 | 变更 |
| --- | --- |
| `tests/helpers/fake-cdp.ts` | `fakePage` 新增 `failAfter`（第 N 次截图起返回 CDP error）、`targetMissingAfter`（第 N 次目标读取起返回 `no-match` / `null`）；`urlAfter` 换成 `urlAfterAt: {read, url}`，让「第几次读取」可钉死 |
| `tests/visual-loop-verify-manager.test.ts` | 重写：改用 `fakePage`，`harnessPath` 只为 crop 指向最小假 harness；四种模式映射到 `stable` / `changed`(read 5) / `target-lost`(第 2 次目标读) / `failed`(第 3 次截图) |
| `tests/visual-loop-capture.test.ts` | 删除 `cropParentOffset` 导入、`crop.parentOffset` 断言、整个 `describe("crop coordinate mapping")`（该中间产物在 CDP 路径不存在；clip 往返覆盖已由 `tests/visual-loop-cdp-actions.test.ts` 承担） |
| `docs/references/native-cdp-probes/release.mjs` | 真机探针归档（自启 Chrome + 自建页面服务 + 8 条判据） |

```
pnpm typecheck     0 错
pnpm -w run lint   0 错 + 3 info（cdp-actions 302/476、context 735；均为轮询 / 顺序释放循环固有）
pnpm test          Test Files 13 passed | 2 skipped (15)；Tests 78 passed | 6 skipped (84)
openspec validate  Change 'harden-visual-loop-with-native-cdp' is valid
```
