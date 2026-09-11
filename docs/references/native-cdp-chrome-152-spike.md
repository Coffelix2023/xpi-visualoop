# Chrome 152 连通性与授权弹窗 spike（任务 1.5）

> 执行时间 2026-09-10 21:49（本地时区）。直连 Node 内置 `WebSocket`，不经过 Python / `ws` / `chrome-remote-interface`。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56） |
| Chrome | `152.0.7977.84`（`/Applications/Google Chrome.app`） |
| Node | `v24.20.0`（`typeof WebSocket === "function"`） |
| 端点 | `http://127.0.0.1:9555/` |
| 配置目录 | `/tmp/xpi-visualoop-spike-15/profile`（全新，非用户日常 profile） |
| 启动 pid | 51645，结束后已 `kill`，用户日常 Chrome 与 9444 spike 实例未动 |

启动命令：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9555 \
  --user-data-dir=/tmp/xpi-visualoop-spike-15/profile \
  --no-first-run --no-default-browser-check \
  --disable-default-apps --disable-sync \
  about:blank
```

`curl http://127.0.0.1:9555/json/version` 在 1 秒内返回 `Protocol-Version: 1.3`，`webSocketDebuggerUrl` 为 `ws://127.0.0.1:9555/devtools/browser/aad37fc7-5c52-4b4c-b0bf-ba4212945665`。

## 2. 连接实验

脚本：`/tmp/xpi-visualoop-spike-15/spike.mjs`（Node 内置 `fetch` + `WebSocket`）。每次连接做两件事：

1. `GET /json/version`，再对 browser WebSocket 发 `Browser.getVersion`
2. `GET /json/list`，选 `type=page` 的 `about:blank`，再对 page WebSocket 发 `Runtime.evaluate`

窗口观察：`CGWindowListCopyWindowInfo` 列出 pid 51645 的窗口；截图用 `screencapture -l30478`。

| 步骤 | WebSocket | RPC | 新窗口 / 弹窗 | 耗时 |
| --- | --- | --- | --- | --- |
| 启动后、未连 WS | 无 | 无 | 仅 `about:blank` 500×375，无对话框 | — |
| 第 1 次 browser + page | 打开成功 | `Chrome/152.0.7977.84`；`location.href=about:blank` | 窗口列表不变 | 立刻返回，无 8s 超时 |
| 第 2–6 次短连（关了再开） | 每次都打开成功 | 同上 | 窗口列表不变 | 立刻返回 |

窗口列表在全部 6 次连接前后都是：

```
wid=30496 500x500 name=          # 黑底空层，不是对话框
wid=30480 336x87  name=
wid=30479 336x107 name=
wid=30478 500x375 name=about:blank
```

截图：

- `docs/references/native-cdp-chrome-152-spike-before.png`：连接前
- `docs/references/native-cdp-chrome-152-spike-after.png`：6 次短连后

两张都是空白 `about:blank`，没有 “Allow debugging” / “允许远程调试” 对话框。

`chrome.log` 只有启动时的 `DevTools listening on ws://127.0.0.1:9555/...`，没有授权相关行。GCM `Authentication Failed: wrong_secret` 是同步登录噪声，与 CDP 握手无关。

## 3. 结论

本项目约定的连接方式（显式 `--remote-debugging-port` + 独立 `--user-data-dir`）在 Chrome 152 上：

- `/json/version` 与 page target 均可直连
- **授权弹窗次数 = 0**，包括首次连接和随后 5 次短连
- 短连不会把可用性打成零；弹窗不是本方案的否决项

Chrome 144+ 的 “Allow remote debugging?” 弹窗出现在 `chrome://inspect/#remote-debugging` 接到**用户日常 profile** 的路径上，与本扩展的专用端点不是同一条路。上游 MCP 的每连接弹一次问题，在本配置下未复现。

## 4. 对设计决策的影响

- 决策二（连接生命周期 = 检查上下文）**仍然成立**，理由仍是诊断观察窗口（`Log.enable` / `Network.enable`），不是为了躲弹窗。
- 不需要为弹窗改成长连共享，也不需要引入 `ws` 或辅助程序绕弹窗。
- 文档与配置继续要求：独立 `--user-data-dir`、显式 `cdpUrl`、不附着用户日常 Chrome。若用户把 `cdpUrl` 指到日常 profile 的 inspect 开关，弹窗风险仍在，那是配置错误，fail-closed 即可。
