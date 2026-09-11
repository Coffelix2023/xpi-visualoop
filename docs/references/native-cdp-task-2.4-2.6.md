# 实测记录：任务 2.4–2.6（目标归属、prepare、capture）

> 执行时间 2026-09-10 23:22–23:25（本地时区）。实现对 `src/visual-loop/cdp-actions.ts` 的动作层，通过 Node 内置 `WebSocket` 直连真实 Chrome。
> 两个证据来源：受控假端点（`tests/visual-loop-cdp-actions.test.ts`，8 个用例）与真实 Chrome 152（下方原始输出）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56） |
| Node | `v24.20.0` |
| Chrome | `152.0.7977.84` |
| 端点 | `http://127.0.0.1:9556/`，专用 profile `/tmp/xpi-visualoop-probe-24/profile`，`--headless=new` |
| 测试页面 | Node 内置 `http`，`http://127.0.0.1:8765/`（含 `#target`、`.duplicate` ×2、`#outside`、`#partial`）与 `8767`（固定尺寸的损坏图片） |

被测对象仍是 **动作层**（`cdp-actions.ts`），尚未接到 `VisualLoopManager`；接线属任务 2.7–2.11 的范围。

## 2. 任务 2.4：目标归属

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 自有目标 | 允许操作 | `ownedTargetId=AFC4A0CD…`，`session=60F2F3A2…` 被记录 |
| 他人目标（不存在的 id） | 拒绝，不关闭 | `refusing to act on a target this session does not own` |
| 已关闭目标 | 拒绝，不关闭 | 关闭后再操作 → `refusing to act on a target this session does not own` |

关闭路径额外约束：关闭前校验 `location.href` 未变，且只在 `Target.closeTarget` 返回 `success: true` 后才从归属表移除。

实测中该护栏真的触发过一次：准备流程停在 `/broken.html` 而调用方传入 `/`，`closeOwnedTarget` 抛 `owned target URL changed; refusing to close it`，未关闭标签页。这条正是「防误关用户标签页」的现场证据。

`bystanderAlive=219A5541…`：同一次运行里另一个非自有标签页在关闭自有目标后仍存活，确认关闭不波及他人。

## 3. 任务 2.5：prepare

原始输出（`/tmp/task246-real.json` 节选）：

```json
{
  "prepare": {
    "dpr1": 2, "dpr2": 1,
    "page1": { "h": 400, "url": "http://127.0.0.1:8765/", "w": 640 },
    "page2": { "h": 300, "url": "http://127.0.0.1:8765/other.html", "w": 500 },
    "sameTarget": true
  },
  "outOfRange": "url must use a loopback host",
  "stillOnLocalPage": "http://127.0.0.1:8765/"
}
```

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 重复准备 | 复用同一标签页，重新应用视口与 DPR | `sameTarget=true`，DPR 2→1、640×400→500×300 均生效 |
| 页面离开允许范围 | 拒绝且不导航 | `url must use a loopback host`；随后合法准备仍成功 |
| 端点被占用 | 由 `context.ts` 的端点锁负责 | 不属本动作层，见任务 1.4 |

返回的页面尺寸是 `Emulation.setDeviceMetricsOverride` 生效后的 `innerWidth` / `innerHeight`，与请求的视口一致。

## 4. 任务 2.6：capture

### 4.1 页面元数据与目标

```json
{
  "viewport": { "height": 400, "width": 640, "byteLength": 2755, "dpr": 1,
                "readiness": { "reasons": [], "status": "ready" } },
  "target": { "height": 400, "width": 640,
              "bounds": { "height": 40, "width": 100, "x": 20, "y": 20 },
              "visibleBounds": { "height": 40, "width": 100, "x": 20, "y": 20 },
              "text": "Target",
              "readiness": { "reasons": [], "status": "ready" } }
}
```

视口图尺寸（640×400）与 `innerWidth`/`innerHeight` 相等：`Page.captureScreenshot` 的输出像素等于视口 CSS 像素 × DPR，DPR=1 时输出即页面坐标，无需换算。

### 4.2 目标解析拒绝路径

| 选择器 | 实测错误 |
| --- | --- |
| `.duplicate`（两个匹配） | `target resolution failed: multiple-matches` |
| `#gone`（无匹配） | `target resolution failed: no-match` |
| `#outside`（视口外） | `target resolution failed: outside-viewport` |
| `#gone` + `allowTargetFailure` | 不抛错；`readiness.status=degraded`，`reasons=["target resolution failed: no-match"]`，`target=null`，图仍落盘 |

`allowTargetFailure` 的语义与旧实现一致：调用方显式允许时保留视口图，并把原因并入 `readiness.reasons`。

### 4.3 就绪与稳定性

`degraded` 原因集合保持旧实现的三项命名：`document not complete`、`fonts not ready`、`visible images not ready`；新增三项针对采集窗口的变化：`page URL changed during capture`、`scroll changed during capture`、`target bounds changed during capture`。

固定尺寸损坏图片的真实 Chrome 实测（`/tmp/task246-readiness.json`）：

```json
{
  "elapsedMs": 5047,
  "image": { "byteLength": 3735, "height": 300, "width": 500 },
  "readiness": { "reasons": ["visible images not ready"], "status": "degraded" },
  "target": { "height": 90, "width": 120, "x": 0, "y": 0 }
}
```

5 秒 deadline 后降级并附原因，与旧实现等价。

> 首次 probe 用零尺寸损坏图片得到 `ready`，那是**正确**行为：`getBoundingClientRect()` 全零的图片不在可见集合内，旧 Python 实现的可见性过滤与之相同。改用显式宽高的损坏图片后复现 `visible images not ready`。

导航、滚动、目标位移三项无法在真实浏览器里可靠触发（改动页面状态就是测试本身），改由受控假端点用例固定：`tests/visual-loop-cdp-actions.test.ts` 的「reports navigation, scroll, and target-bound changes instead of throwing」。

### 4.4 目标消失

真机未单独复现「采集前目标仍在、采集后消失」，原因同上（时序不可控）。受控端点用例覆盖，且真机已覆盖「一开始就解析失败」的等价分支。

## 5. 已知缺口（留给后续任务，不属 2.4–2.6）

- **输出像素上限**：`image.width/height` 目前等于原始尺寸，未做等比缩小。`cdp-actions.ts` 内有 `ponytail:` 注释标注该边界，任务 2.9 处理。
- **诊断收集**：`cdp-actions.ts` 不返回 `diagnostics`，任务 2.7 实现。
- **局部截图**：目标图仍走旧的 `crop` 动作；`Page.captureScreenshot` 的 `clip` 路径属任务 2.8。
- **接线**：`VisualLoopManager` 仍调用 `harness.ts` 的外部命令路径，任务 2.7–2.11 完成替换。

## 6. 复现方式

```bash
# 启动专用 Chrome（独立 profile，不触碰用户日常实例）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9556 \
  --user-data-dir=/tmp/xpi-visualoop-probe-24/profile \
  --no-first-run --no-default-browser-check --headless=new about:blank

# 动作层真实运行
node --experimental-strip-types /tmp/xpi-visualoop-probe-24/real-actions.mjs
node --experimental-strip-types /tmp/xpi-visualoop-probe-24/readiness.mjs

# 受控端点用例
pnpm exec vitest run tests/visual-loop-cdp-actions.test.ts
```
