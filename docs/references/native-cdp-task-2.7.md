# 实测记录：任务 2.7（诊断收集）

> 执行时间 2026-09-11 05:50 CST。实现为 `src/visual-loop/cdp-diagnostics.ts`，已接线到 `cdp-actions.ts` 的 `prepareOwnedPage` / `captureOwnedPage`。
> 三个证据来源：受控假端点（`tests/visual-loop-cdp-diagnostics.test.ts`，7 个用例；`tests/visual-loop-cdp-actions.test.ts` 新增 2 个接线用例）、真实 Chrome 152 直连、以及上一轮的协议探针 `docs/references/native-cdp-probes/diag2.mjs`。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56） |
| Node | `v24.20.0` |
| Chrome | `152.0.7977.84` |
| 端点 | `http://127.0.0.1:9556/`，专用 profile `/tmp/xpi-visualoop-probe-25/profile`，`--headless=new` |
| 测试页面 | `docs/references/native-cdp-probes/page2.mjs` → `http://127.0.0.1:8766/` |
| 真机脚本 | `/tmp/xpi-visualoop-probe-25/real-diag.mjs`（直接 import `src/` 的 TS 源码，无构建、无第三方依赖） |

## 2. 验收判据与结论

任务原文：**「未采集到时标记 `unknown`；用受控错误、请求失败、无法取得历史三种情况验证 `unknown` 与「零错误」可区分」**。

| # | 场景 | 期望 | 实测 |
| --- | --- | --- | --- |
| 1 | 受控错误 | 控制台错误与未捕获异常入 `entries`，脱敏生效 | 通过（假端点 + 真机，见第 3 节） |
| 2 | 请求失败 | 4xx 与加载失败入网络条目；`canceled: true` 被丢弃 | 通过（假端点；真机见第 3 节） |
| 3 | 无法取得历史 | `status: "unknown"`、`entries: []`、无 `observedFrom` | 通过（`Network.enable` 被端点拒绝的用例） |
| 4 | `unknown` 与「零错误」可区分 | 两者 `status` 不同 | 通过（`unknown` vs `observed` + 空 `entries`，同一测试内并列断言） |

第 3 项的实现要点：`attach` 中任一 `*.enable` 失败即整体回退，`summarize` 在未 attach 时返回 `unknownSummary()` 而非空 `observed`。这条正是旧后端的缺陷所在——旧实现启用失败时会静默退化成「零错误」。

## 3. 真机原始输出

`node real-diag.mjs`（准备页面 → 等 2.5 s 让页面触发全部错误 → 采集）：

```
prepared 006F974155D46A3E02E12485A42B559A
console: {
  "entries": [
    { "kind": "console", "message": "boom Object" },
    { "kind": "console", "message": "Uncaught Error: uncaught tok=supersecretvalue\n    at http://127.0.0.1:8766/:6:28" }
  ],
  "observedFrom": "2026-09-10T21:50:21.559Z",
  "observedTo": "2026-09-10T21:50:24.103Z",
  "status": "observed",
  "truncated": false
}
network: {
  "entries": [
    { "kind": "network", "message": "HTTP 404", "status": 404, "url": "http://127.0.0.1" },
    { "kind": "network", "message": "net::ERR_UNSAFE_PORT" }
  ],
  "observedFrom": "2026-09-10T21:50:21.559Z",
  "observedTo": "2026-09-10T21:50:24.103Z",
  "status": "observed",
  "truncated": false
}
readiness: ready []
```

对照页面脚本（`page2.mjs`）：`console.error("boom", {a:1,b:[2,3]})` → 第 1 条；`throw new Error("uncaught tok=supersecretvalue")` → 第 2 条；`fetch("/missing.json")` → 404；`fetch("http://127.0.0.1:9/dead")` → `ERR_UNSAFE_PORT`。

四个事件全部捕获，`console.log("just a log")` **未**进入条目（只收 `error`/`assert`）。

## 4. 与旧实现的刻意差异（行为变更）

写进这里是因为两者都会影响调用方对「有没有错误」的判断。

1. **`unknown` 的语义**：表示「观察器没挂上」，不是「浏览器没有可报告项」。旧实现启用失败时静默退化成「零错误」。这是本任务的核心修复。
2. **不原样透出附加数据**：`consoleAPICalled.args` 里的对象只降级为 `Object`/`Array` 字符串，栈追踪只取 `exceptionDetails.exception.description`。目的是控制剥敏面积——见第 5 节的已知缺口。
3. **`Log.entryAdded` 中 `source === "network"` 的条目被丢弃**：否则每次网络失败会被 `Log.*` 与 `Network.*` 各计一次。

## 5. 已知缺口（如实记录，不在本任务修）

**`tok=supersecretvalue` 没有被脱敏。** `sanitizeDiagnosticMessage` 的正则只匹配完整键名：

```
\b(authorization|cookie|token|password|secret|api[-_]?key)\b\s*[:=]\s*(...)
```

`tok` 不是 `token` 的完整匹配，`\b` 边界不成立，故原样保留。验证：

```js
sanitizeDiagnosticMessage("Error: uncaught tok=supersecretvalue")
// → "Error: uncaught tok=supersecretvalue"   （未脱敏）
sanitizeDiagnosticMessage("Error: token=supersecretvalue")
// → "Error: token=[redacted]"                （已脱敏）
```

这是**旧实现的同样行为**（`harness.ts` 内的同名正则逐字相同，本轮抽出到 `redact.ts` 未改语义），所以不是回归。真实风险是：未捕获异常的 `description` 会带上源码行，若该行恰好把密钥赋给非上述全名的变量，就会随诊断进入证据。

收窄该缺口需要扩大正则的键名集合，属独立改动，且会同时影响旧路径。不在 2.7 范围内。已记录于此，留给后续任务或单独 change。

## 6. 实现细节备忘

- **`Runtime.enable` 不可省**。只开 `Log.enable` + `Network.enable` 时 `Runtime.consoleAPICalled` 与 `Runtime.exceptionThrown` 一条都收不到，得到的是语法合法、永远为空的诊断摘要。上一轮 `diag2.mjs` 已实测固定这一点。
- **观察窗口起点在 `attach` 返回之后**，不是 `prepare` 开始时。协议不会补发 enable 之前的事件，所以窗口只能从 enable 返回那一刻算起。`observedFrom` / `observedTo` 因此是诚实的上下界。
- **窗口终点取在 `pageAfter` 读取之后、稳定性检查之前**，不覆盖采集自身的稳定性读数。
- **复用同一 target 时不重复 attach**。重复 `Runtime.enable` 会重复注册监听，且会把观察窗口从中途重启。
- **条数上限 20**（`MAX_DIAGNOSTIC_ENTRIES`，与旧实现一致）。内部最多记 4 倍后停止，以便 `truncated` 判断真实。

## 7. 闸门

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 0 错 |
| `pnpm -w run lint` | 0 错，2 条 `noAwaitInLoops` info（轮询循环固有，与上一轮相同） |
| `pnpm test` | `Test Files 13 passed \| 2 skipped (15)`，`Tests 77 passed \| 6 skipped (83)` |

新增用例：`tests/visual-loop-cdp-diagnostics.test.ts`（7 个），`tests/visual-loop-cdp-actions.test.ts` 由 8 增至 9 个（+1 接线用例，另在既有用例内补 2 条断言）。
