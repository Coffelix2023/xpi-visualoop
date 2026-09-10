# 基线记录：harden-visual-loop-with-native-cdp 任务 1.3

> 执行时间 2026-09-10 20:55（本地时区）。记录改动前的真实基线与失败归属判定。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56） |
| Node | `v24.20.0`（`mise.toml` 锁定） |
| pnpm | `12.3.4` |
| Chrome | `152.0.7977.84` |
| Pi | 0.85.1 |
| 扩展版本 | `src/index.ts` 的 `VERSION = "0.1.0"`（未发布） |
| 临时目录 | `$TMPDIR=/var/folders/n4/_3zy89090xv253635pz_ssw40000gn/T/` |

## 2. 三条命令结果

```
pnpm typecheck        -> tsc --noEmit，无输出（通过）
pnpm -w run lint      -> biome check .，Checked 20 files，No fixes applied（通过）
pnpm test             -> Test Files 8 passed | 2 skipped (10)
                         Tests      50 passed | 6 skipped (56)
                         Duration   11.63s
```

跳过的 6 个用例来自 `tests/.task2-real.test.ts`（2 个）与 `tests/.task3-real.test.ts`（4 个）；两者以 `describe.skipIf` 依赖环境变量（如 `TASK2_REAL_HARNESS`），未设置即跳过，属设计内行为。

## 3. 首次运行与失败归因

**同一 worktree、同一命令，首次运行结果是 5 失败 / 45 通过**，全部集中在 `tests/visual-loop-verify-manager.test.ts`：

```
Error: configured CDP endpoint is already owned by another xpi-visualoop process
 ❯ VisualLoopManager.connect src/visual-loop/context.ts:701:15
 ❯ VisualLoopManager.prepare src/visual-loop/context.ts:280:23
 ❯ setup tests/visual-loop-verify-manager.test.ts:94:3
```

归因结论：**与端点锁竞争直接相关，且是残留锁而非测试并发。**

证据链：

1. 锁文件 `$TMPDIR/xpi-visualoop-locks/edea07fdc3fbf04fb009fde45a3ab7ce.lock` 内容为 `{"pid":19632,"startedAt":"2026-09-10T06:34:37.457Z"}`；`ps -p 19632` 返回空，持锁进程早已退出。
2. 该锁的 mtime 为 `Sep 10 14:34:37`，早于本次运行（20:47），因此不是本次运行内部竞争产生。
3. 全部测试共用 `cdpUrl=http://127.0.0.1:9333/`，锁路径由 URL 的 SHA-256 前 32 位派生，因此所有用例命中同一个锁文件。
4. `context.ts:698` 用 `open(lockPath, "wx", 0o600)`，撞 `EEXIST` 直接抛错，不检查持有者存活。
5. 删除该残留锁后立即重跑，`tests/visual-loop-verify-manager.test.ts` 5/5 通过，全量 `pnpm test` 全绿。
6. 该次全绿运行结束后 `$TMPDIR/xpi-visualoop-locks/` 为空，说明 `disconnect()` 的清理路径本身有效；泄漏来自更早期的中断运行，不是当前实现缺陷。

排除的替代解释：不是因为新增依赖、不是因为测试并行（Vitest 默认文件级串行于 `pool: forks` 下仍共享同一锁路径）、不是因为 `fetch` 桩失效。

## 4. 失败范围划分

| 现象 | 属本变更范围 | 理由 |
| --- | --- | --- |
| 残留锁导致 `connect` 抛 EEXIST | **是**，任务 1.4 | 锁需要 PID 抢占语义才能自愈；本变更把连接移入进程内，端点所有权语义必须继续成立 |
| 6 个 real 用例跳过 | 否 | 环境变量门控的设计内跳过 |
| typecheck / lint | 否 | 基线已通过，无待修项 |

## 5. 对后续任务的影响

- 任务 1.4 的验收判据因此可精确落到「残留锁场景下新进程能抢占」，且可用 `$TMPDIR/xpi-visualoop-locks/` 直接构造，无需额外夹具。
- 原残留锁内容已复制到 `/tmp/xpi-visualoop-stale-lock-fixture.json` 作为夹具样本。
- 任务 1.4 完成后必须重跑全量 `pnpm test`，确认 5 个失败不再出现。
