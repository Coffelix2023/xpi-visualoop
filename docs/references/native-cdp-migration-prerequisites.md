# 迁移前提记录：外部 browser-harness 到内建 CDP 客户端

> 对应 `openspec/changes/harden-visual-loop-with-native-cdp` 任务 1.1。
> 本文件只记录执行本变更前必须成立的前提、受影响配置位置与回滚方式。

## 1. 参考实现状态（开发期依赖）

| 项 | 值 |
| --- | --- |
| 路径 | `docs/references/browser-harness/`（仓库内，`.gitignore` 排除，不入库） |
| 远端 | `https://github.com/browser-use/browser-harness.git` |
| HEAD | `afbcc381b963040c19627d788e40c7e7663171ee` |
| describe | `v0.1.13-24-gafbcc38` |
| 工作区 | clean（`git status --short` 无输出） |
| 大小 | 8.3 MB |

恢复方式：

```bash
git clone https://github.com/browser-use/browser-harness.git \
  docs/references/browser-harness
git -C docs/references/browser-harness checkout afbcc381b963040c19627d788e40c7e7663171ee
```

该 clone 是**开发期实现参考**，本变更任务 4.4 完成后删除；删除后从上述 commit 重取。

## 2. 真机配置现状

扩展按 `loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted())` 读取两处配置：

1. 用户级：`<agentDir>/xpi-visualoop.json`，本机为 `/Users/felix/.pi/agent/xpi-visualoop.json`
2. 项目级：`<cwd>/.pi/xpi-visualoop.json`（仅在项目受信任时生效）

实测结果：

- 用户级配置文件在本机**不存在**。`harnessPath` 无用户级指向。
- 项目级配置在本仓库**不存在**。上一次真机闭环（`add-local-visual-feedback-loop` 6.1）是在独立验收目录 `/tmp/xpi-visualoop-e2e/` 下进行的，配置位于 `/tmp/xpi-visualoop-e2e/.pi/xpi-visualoop.json`：

```json
{"cdpUrl":"http://127.0.0.1:9333/","harnessPath":"/Users/felix/c6x_local/app-prd/xpi-visualoop/docs/references/browser-harness/browser-harness","glimpseModulePath":"/tmp/xpi-visualoop-e2e-glimpse-wrapper.mjs"}
```

因此**当前唯一的 `harnessPath` 指向即上面这一条**，指向本仓库内的 clone 可执行文件。

### 备份

改动前已备份，未改动原文件：

- `/tmp/xpi-visualoop-e2e/.pi/xpi-visualoop.json.backup-20260910-205422`

回滚：`cp /tmp/xpi-visualoop-e2e/.pi/xpi-visualoop.json.backup-20260910-205422 /tmp/xpi-visualoop-e2e/.pi/xpi-visualoop.json`

## 3. 受影响的配置位置清单

| 位置 | 现状 | 本变更影响 |
| --- | --- | --- |
| `/Users/felix/.pi/agent/xpi-visualoop.json` | 不存在 | 无 |
| `<cwd>/.pi/xpi-visualoop.json` | 本仓库不存在 | 无 |
| `/tmp/xpi-visualoop-e2e/.pi/xpi-visualoop.json` | 含 `harnessPath` | 该字段在本变更任务 3.1 后会被 fail-closed 拒绝，验收前需删除该键 |
| `src/visual-loop/config.ts` | 三键：`cdpUrl`、`harnessPath`、`glimpseModulePath` | 移除 `harnessPath`，保留未知字段拒绝语义 |
| `README.md` / `README.zh-CN.md` | 第 75、80 行含 `harnessPath` 示例与说明 | 任务 4.2 更新 |
| `tests/visual-loop-config.test.ts` | 含 `harnessPath` 用例 | 任务 3.1 / 3.3 更新 |
| `tests/visual-loop-capture.test.ts`、`tests/visual-loop-verify-manager.test.ts`、`tests/visual-loop-harness.test.ts` | 用 `harnessPath` 指向假 Harness | 任务 3.2 / 3.3 随实现替换 |

配置无密钥、无 Token、无凭据；`harnessPath` 只是可执行路径。

## 4. 端点所有权残留

`context.ts` 的端点锁位于 `join(tmpdir(), "xpi-visualoop-locks")`。本机存在一条残留锁：

- 文件：`$TMPDIR/xpi-visualoop-locks/edea07fdc3fbf04fb009fde45a3ab7ce.lock`（对应 `cdpUrl=http://127.0.0.1:9333/`）
- 内容：`{"pid":19632,"startedAt":"2026-09-10T06:34:37.457Z"}`
- `ps -p 19632` 无该进程，即**持有者已退出但锁未被清理**

这正是任务 1.4 要修的场景：`open(path, "wx")` 撞到 `EEXIST` 即抛「已被另一进程占用」，不检查持有者是否存活。构造该场景无需额外造文件，本机已存在。

清理：`rm "$TMPDIR/xpi-visualoop-locks/"edea07fdc3fbf04fb009fde45a3ab7ce.lock`

## 5. 阻塞项

任务 1.5 的 Chrome 连通性 spike 需要真实 Chrome，当前环境状态：

- 本机 Chrome `152.0.7977.84`（`/Applications/Google Chrome.app`），满足设计文档记录的 Chrome 152。
- 当前**没有**监听 CDP 的 Chrome 进程（9222 / 9333 / 9223 均无 `/json/version` 响应）。
- `/tmp/xpi-visualoop-e2e/chrome.pid` 与 `http.pid` 存在但进程已退出；`chrome-profile` 目录保留在 `/Users/felix/.cache/xpi-visualoop/chrome-profile` 与 `/tmp/xpi-visualoop-e2e/chrome-profile`。

因此 1.5 必须由本 Agent 启动一个专用 Chrome（独立 `--user-data-dir`、独立端口、不触碰用户日常 profile），并接受可能出现的授权弹窗。spike 只做只读探测，不结束用户浏览器进程、不删除用户配置目录。

## 6. 前置结论

- 1.1 前提成立：clone 已恢复到已核对的 commit 且工作区干净；`harnessPath` 的真实指向只有一处且已备份。
- 无配置级阻塞；唯一外部依赖（真实 Chrome）可由本 Agent 在专用 profile 下自行启动。
- 若 spike 结论推翻「一次连接」假设，回退点是设计文档「决策一」记录的 `ws` 方案，不影响 1.2–1.4 的完成。
