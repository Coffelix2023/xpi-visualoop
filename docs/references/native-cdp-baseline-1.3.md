# 基线记录：harden-visual-loop-with-native-cdp 任务 1.3

> 复核时间 2026-09-10 21:36（本地时区）。记录改动前的真实基线与失败归属判定。
> 测量时已把未完成的 1.4 WIP（`context.ts` 锁抢占 + `tests/visual-loop-endpoint-lock.test.ts`）stash 掉，基线对应 HEAD 的 `open(lockPath, "wx")` 语义。

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

## 2. 三条命令结果（无残留锁）

当时 `$TMPDIR/xpi-visualoop-locks/` 只有无关的 `probe.lock`，没有 `http://127.0.0.1:9333/` 对应的锁。

```
pnpm typecheck        -> tsc --noEmit，无输出，exit 0
pnpm -w run lint      -> biome check .，Checked 20 files，No fixes applied，exit 0
pnpm test             -> Test Files 8 passed | 2 skipped (10)
                         Tests      50 passed | 6 skipped (56)
                         Duration   15.06s
                         exit 0
```

跳过的 6 个用例来自 `tests/.task2-real.test.ts`（2 个）与 `tests/.task3-real.test.ts`（4 个）；两者以 `describe.skipIf` 依赖环境变量，未设置即跳过，属设计内行为。

## 3. 残留锁复现（`tests/visual-loop-verify-manager.test.ts`）

按任务要求单独复现。写入：

```
$TMPDIR/xpi-visualoop-locks/edea07fdc3fbf04fb009fde45a3ab7ce.lock
{"pid":19632,"startedAt":"2026-09-10T06:34:37.457Z"}
```

`edea07fdc3fbf04fb009fde45a3ab7ce` 是 `sha256("http://127.0.0.1:9333/").hex.slice(0, 32)`。`ps -p 19632` 无该进程。夹具样本仍在 `/tmp/xpi-visualoop-stale-lock-fixture.json`。

```
pnpm exec vitest run tests/visual-loop-verify-manager.test.ts
  Test Files  1 failed (1)
  Tests       5 failed (5)
  全部错误: configured CDP endpoint is already owned by another xpi-visualoop process
  ❯ VisualLoopManager.connect src/visual-loop/context.ts:701:15
  ❯ VisualLoopManager.prepare src/visual-loop/context.ts:280:23
  ❯ setup tests/visual-loop-verify-manager.test.ts:94:3
```

`context.ts:698` 用 `open(lockPath, "wx", 0o600)`，撞 `EEXIST` 直接抛错，不检查持有者存活。

无残留锁时同一文件 5/5 通过，因此失败来自残留锁，不是测试本身或并发。

## 4. 失败范围划分

| 现象 | 属本变更范围 | 理由 |
| --- | --- | --- |
| 残留锁导致 `connect` 抛 EEXIST | **是**，任务 1.4 | 锁需要 PID 抢占语义才能自愈；本变更把连接移入进程内，端点所有权语义必须继续成立 |
| 6 个 real 用例跳过 | 否 | 环境变量门控的设计内跳过 |
| typecheck / lint | 否 | 基线已通过，无待修项 |

## 5. 对后续任务的影响

- 任务 1.4 的验收判据落到「残留锁场景下新进程能抢占」。本机已留下上述锁文件，也可用 `/tmp/xpi-visualoop-stale-lock-fixture.json` 再造。
- 1.4 完成后必须重跑全量 `pnpm test`，确认这 5 个失败不再出现。
