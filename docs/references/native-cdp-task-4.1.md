# 实测记录：任务 4.1（专用 Chrome 上的完整闭环）

> 执行时间 2026-09-12 CST（终端时间戳 `2026-09-11T00:34:54Z`，本地 UTC+8）。
> 证据来源：真机探针 `docs/references/native-cdp-probes/verify.mjs`，自起专用 Chrome + 内联页面服务，Node 直接 import `src/` TS 源码，无构建、无第三方依赖。
> 目标 change `openspec/changes/harden-visual-loop-with-native-cdp`。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56）arm64 |
| Pi | `0.85.1`（`pi --version`） |
| Chrome | `152.0.7977.84`（`headless=new`） |
| Node | `v24.20.0` |
| 端点 | `http://127.0.0.1:9558/` |
| 专用 profile | `/tmp/xpi-visualoop-probe-verify/profile`（每轮探针先 `rm -rf` 重建） |
| 测试页面 | 内联服务 `http://127.0.0.1:8770/`，第一次 `GET /` 返回红色 `#target`，之后返回蓝色 |

配置只写 `{"cdpUrl": "http://127.0.0.1:9558/"}`，且 `PI_CODING_AGENT_DIR` 指向空目录——这是 2.11「无外部运行时要求」在真实闭环里的直接证据：唯一配置来源就是那一个键。

## 2. 运行方式

```bash
# 全自动（跳过人工面板，用于验证其余环节）
PROBE_SKIP_FEEDBACK=1 node --experimental-transform-types docs/references/native-cdp-probes/verify.mjs

# 完整（弹出 Glimpse 面板，需真人提交或取消）
node --experimental-transform-types docs/references/native-cdp-probes/verify.mjs
```

`--experimental-transform-types` 而非 strip-types：`EvidenceStore` 用了 TS 构造参数属性，strip-only 模式拒绝该语法。

## 3. 实测结果（完整跑，含人工面板）

```
versions  Pi=0.85.1  Chrome=Chrome/152.0.7977.84  Node=v24.20.0  OS=darwin

1  prepare  OK  targetId=B5036E3A7A147B231C7497A3BA27BB3D viewport=800x600 stateLabel=dialog-open
2  baseline capture  OK  captureId=capture-mtw84nz4-hnvrox6x readiness=ready crop=120x50 bytes=4106
3  silent caller rejected  OK  error="baseline capture declared stateLabel "dialog-open"; pass the same stateLabel to confirm the interaction state is unchanged, or the new one if it changed"
4  verify with the same declared state  OK  status=comparable after=capture-mtw84o1c-ncbwzwql commonRegion={"height":50,"width":120,"x":40,"y":60}
5  edit reported as an observed change  OK  targetChanges=changed fields=["styles.backgroundColor"]
6  glimpse feedback round  OK  result={"comparisonId":"comparison-mtw84o35-1bsz1h5e","feedback":{...,"comment":"OK",...,"region":{"height":1,"width":1,"x":0,"y":0},"submittedAt":"2026-09-11T00:34:54.169Z"},"status":"submitted"}
7  refuses work after disconnect  OK  status=disconnected
8  own tab closed  OK  owned=B5036E3A7A147B231C7497A3BA27BB3D openTabs=4
9  browser process untouched  OK  pid=69534
10 profile directory kept  OK  /tmp/xpi-visualoop-probe-verify
11 evidence read back while the session is live  OK  bytes=4106/4133

ALL OK
```

第 6 项为真人操作：Glimpse 面板弹出后输入评论 `OK` 并点击 **Submit**，未拖拽区域，因此 `region` 为 `{x:0,y:0,width:1,height:1}` 的默认值（未做区域标注时的既有语义）。返回 `status: "submitted"`，`feedbackId` 与 `comparisonId` 都已落盘，`submittedAt` 与终端时间一致。

观察到的无害噪音：`glimpse[69573:583122] error messaging the mach port for IMKCFRunLoopWakeUpReliable`。这是 macOS 原生 Glimpse 二进制启动时的 IMKit（输入法）提示，面板随后正常显示并正常返回结果，不影响判据。

## 4. 判据对照

任务原文：**「在专用 Chrome 上跑通完整闭环:准备、采集、复核、以同一状态标签复核得到可比结果、用户反馈;交付真机证据,记录 Pi、Chrome、Node 版本与结果」**。

| 判据 | 结果 |
| --- | --- |
| 在专用 Chrome 上执行 | 通过。探针自起 `headless=new` Chrome，独立端口 9558 + 独立 profile，未触碰日常 profile |
| 准备 | 通过，第 1 项，`viewport=800x600` |
| 采集 | 通过，第 2 项，区域图 120×50，与 `#target` 的 CSS 尺寸一致 |
| 复核 | 通过，第 4 项，`status=comparable`，共同区域 `{x:40,y:60,w:120,h:50}` 与 `#target` 的页面坐标一致 |
| 以同一状态标签复核得到可比结果 | 通过。第 4 项显式传 `stateLabel: "dialog-open"`（与基准一致）；第 3 项反证沉默调用方会被拒绝，不会静默沿用基准的声明 |
| 用户反馈 | 通过，第 6 项，真人提交评论后返回 `submitted` |
| 记录 Pi / Chrome / Node 版本与结果 | 通过，见第 1、3 节 |

补充的可信度项（非任务原文要求，但属本项目既有语义）：第 7–11 项证明释放路径不结束浏览器进程、不删用户 profile、关闭自有标签页、且旧证据在会话内仍可读回。

## 5. 探针自身的两处修正（勿重复踩）

1. **`11 evidence read back`** 原本放在 `await manager.disconnect()` 之后——释放路径会删除会话证据目录，必然读到 0 字节。已移到 `disconnect()` 之前。
2. **`6` 在 `PROBE_SKIP_FEEDBACK=1` 时被计为 MISS**，导致退出码非 0。已改为打印 SKIPPED 且不计失败。

另有一处实现约束值得记下：探针必须**一个 URL 两个版本**（第一次 `GET /` 返回红色 `#target`，之后返回蓝色）。若改成导航到 `/edited`，`compareCaptureConditions` 会报 `page URL changed`，永远拿不到 `comparable`。

## 6. 闸门真实性声明

第 3 节的完整输出来自本节实际执行的命令，逐字粘贴，未做推断或润色。第 6 项的 `status`、`comment`、`submittedAt` 来自真人点击 Submit 后脚本打印的真实返回值。

本次运行之后源码与测试未再改动，因此 `docs/references/native-cdp-task-4.2-4.4.md` 第 3 节的四道闸门数字仍然有效。
