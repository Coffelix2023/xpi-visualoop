# Handoff：任务 4.1–4.4（终检与文档）

> **收尾状态（2026-09-12 补记）：本 handoff 描述的 4.1–4.4 已全部完成，`tasks.md` 全部勾选。**
> 4.1 的真机证据见 `docs/references/native-cdp-task-4.1.md`（11/11 OK，含真人 Glimpse 提交）；
> 4.2–4.4 见 `docs/references/native-cdp-task-4.2-4.4.md`。第 3 节「下一步」与第 4 节「提交切分」已被实际执行，保留作过程记录。

> 中断时间：上下文将满。目标 change `openspec/changes/harden-visual-loop-with-native-cdp`。
> **当前工作树是绿的**：typecheck 0 错 / lint 0 错 3 info / test 84 通过 6 跳过 / openspec valid。
> 未提交（全部改动仍在工作树，`main` 分支，符合本项目 git 纪律）。

## 0. TL;DR

- 1.x / 2.x / 3.1–3.4 上轮已完成。**本轮完成 3.5、3.6**（plan 缺口，见第 1 节）与 **4.1 探针主干**。
- 4.1 的自动部分真机跑通 **10/11 项 OK**，唯一未完成的第 6 项是 Glimpse 人工反馈面板——需要真人点一下，见第 3 节。
- 4.2（文档）、4.3（终检记录）、4.4（删参考实现）**未开始**，本轮只跑了闸门取数。
- `tasks.md` 已勾选至 3.6；4.1–4.4 仍为 `[ ]`。

---

## 1. 本轮的 plan 缺口修复（重要，与上轮 handoff 假设不同）

上轮 handoff 说「下一步只剩 4.1–4.4」。实际核对 `design.md` 与 delta spec 后发现两条**已成条文的决策**在 `tasks.md` 里没有任何承接任务：

| 决策 | spec 条文位置 | 上轮状态 |
| --- | --- | --- |
| 决策五：`stateLabel` 必须由调用方显式声明，缺失即拒绝 | `specs/visual-verification/spec.md` 的 "Explicit comparability checks" + Scenario "Baseline declared a state and the caller did not" | spec 有条文，tasks 无任务，代码是 `input.stateLabel ?? before.stateLabel`（静默沿用） |
| 决策六：复核默认只回共同区域前后图 + 16 KiB 文本预算 + 4 MiB 图像预算 | 同文件 "Side-by-side evidence and bounded summaries" | spec 有条文，tasks 无任务，代码返回 4 张图（约 21 MiB base64） |

**已按用户决策补 `tasks.md` 3.5 / 3.6 并实现**。这是一次行为收紧，调用方多一个必填语义（见 `design.md` 决策五的「代价」一节）。

### 1.1 实现改动

**`src/visual-loop/context.ts`（3.5）**

```ts
// verify() 内，在 getCapture 之后、capture 之前
if (before.stateLabel !== undefined && input.stateLabel === undefined)
  throw new Error(
    `baseline capture declared stateLabel "${before.stateLabel}"; pass the same stateLabel to confirm the interaction state is unchanged, or the new one if it changed`,
  );
```

同时删掉传给 `this.capture()` 的 `stateLabel: input.stateLabel ?? before.stateLabel`，改为 `stateLabel: input.stateLabel`。

- 拒绝发生在**任何新证据产生之前**（测试断言 `getCapture(before.captureId).status === "available"`）。
- 错误文案给出可直接照做的下一步（`design.md` 风险一节的缓解要求）。

**`src/index.ts`（3.6）**

| 改动 | 说明 |
| --- | --- |
| 新增 `MAX_VERIFY_IMAGE_BYTES = 4 * 1024 * 1024`（导出） | 复用已有 `MAX_CAPTURE_TEXT = 16 * 1024` 作文本预算 |
| `imageContent()` 返回值从 `content[]` 改为 `{ byteLength, content }` | 只有它能拿到文件大小，`readFile` + `stat` 并行 |
| 新增导出 `verifyContent(result, { includeViewportImages? })` | 文本超 16 KiB 抛 "text budget"；默认只推共同区域前后图；`includeViewportImages` 才加视口图；累计字节超 4 MiB 抛 "byte budget"，**不静默丢弃** |
| `visual_verify` 的 execute 改为 `content: await verifyContent(result, { includeViewportImages: params.includeViewportImages })` | 删掉原来内联的 4 段 `imageContent(...)` 拼接 |
| `VerifyParameters` 新增可选 `includeViewportImages: Type.Optional(Type.Boolean(...))` | 工具描述里写明默认只回共同区域 |

### 1.2 新增测试

**`tests/visual-loop-verify-manager.test.ts`** — 新 `describe("VisualLoopManager.verify state declaration")`，4 例：基准未声明（放行）/ 静默调用方被拒（正则锚在模块级常量 `DECLARED_STATE_ERROR`，避开 `useTopLevelRegex`）/ 重复同一标签（comparable）/ 换成新标签（not-comparable + `declared interaction state changed`）。

**`tests/visual-loop-tool.test.ts`** — 新 `describe("visual verify tool output")`，4 例：默认只回共同区域（`toHaveLength(5)`，断言**不含**视口图的 base64）/ 显式请求（`toHaveLength(9)`，含 `before viewport:`、`after viewport:` 标签）/ 无共同区域时只回文本 / 超字节预算抛 "byte budget"。

fixture 里四个 PNG 文件写**互异填充字节**（`index + 1`），否则视口图与区域图 base64 相同，第 1 例的「不含视口图」断言形同虚设——这是本轮修掉的一个测试缺陷。

---

## 2. 4.1 探针：`docs/references/native-cdp-probes/verify.mjs`

照 `release.mjs` 结构：自起专用 Chrome（headless=new，独立 profile `/tmp/xpi-visualoop-probe-verify/profile`，端口 9558）+ 内联页面服务（8770）。

**设计要点**

- **一个 URL、两个版本**：页面服务第一次 `GET /` 返回红色 `#target`，之后返回蓝色。若改成导航到 `/edited`，`compareCaptureConditions` 会报 `page URL changed`，永远拿不到 comparable。这是第一次实现时踩的坑。
- 配置只写 `{ cdpUrl }`，`PI_CODING_AGENT_DIR` 指向空目录 —— 2.11「无外部运行时要求」的直接证据。
- `PROBE_SKIP_FEEDBACK=1` 可跳过人工面板，用于验证其余环节。

**运行方式**

```bash
# 全自动（跳过 Glimpse 面板）
PROBE_SKIP_FEEDBACK=1 node --experimental-transform-types docs/references/native-cdp-probes/verify.mjs

# 完整（会弹出 Glimpse 面板，需要真人提交或取消）
node --experimental-transform-types docs/references/native-cdp-probes/verify.mjs
```

`--experimental-transform-types` 而非 strip-types：`EvidenceStore` 用了 TS 构造参数属性，strip-only 模式拒绝该语法。

### 2.1 实测结果（`PROBE_SKIP_FEEDBACK=1`，2026-09-12 真机）

```
versions  Pi=0.85.1  Chrome=Chrome/152.0.7977.84  Node=v24.20.0  OS=darwin

1  prepare  OK  targetId=BE37D9D5AD3D82A6D1B9BEA3FE945CEB viewport=800x600 stateLabel=dialog-open
2  baseline capture  OK  captureId=capture-mtw7far8-a28berln readiness=ready crop=120x50 bytes=4106
3  silent caller rejected  OK  error="baseline capture declared stateLabel "dialog-open"; pass the same stateLabel ..."
4  verify with the same declared state  OK  status=comparable after=capture-mtw7fatf-mvr9u3va commonRegion={"height":50,"width":120,"x":40,"y":60}
5  edit reported as an observed change  OK  targetChanges=changed fields=["styles.backgroundColor"]
6  glimpse feedback round  SKIPPED  (PROBE_SKIP_FEEDBACK=1)
7  refuses work after disconnect  OK  status=disconnected
8  own tab closed  OK  owned=BE37D9D5AD3D82A6D1B9BEA3FE945CEB openTabs=5
9  browser process untouched  OK  pid=45862
10 profile directory kept  OK  /tmp/xpi-visualoop-probe-verify
11 evidence read back while the session is live  OK  bytes=4106/4133
```

### 2.2 判据对照（4.1 任务原文：「准备、采集、复核、以同一状态标签复核得到可比结果、用户反馈」）

| 要求 | 状态 |
| --- | --- |
| 准备 | ✅ 第 1 项 |
| 采集 | ✅ 第 2 项（区域图 120×50，与 `#target` 的 CSS 尺寸一致） |
| 复核 | ✅ 第 4 项，`comparable` |
| **以同一状态标签复核得到可比结果** | ✅ 第 4 项用的是 `stateLabel: "dialog-open"`（与基准一致），且第 3 项证明沉默时会被拒 |
| 用户反馈 | ⏳ 第 6 项，**需真人点 Glimpse 面板** |
| 记录 Pi / Chrome / Node 版本 | ✅ 已打印（Pi 0.85.1 / Chrome 152.0.7977.84 / Node v24.20.0） |
| 交付真机证据 | ⏳ 待写 `docs/references/native-cdp-task-4.1.md` |

### 2.3 修掉的两个探针自身缺陷（勿重复踩）

1. **`11 evidence read back`** 原本放在 `await manager.disconnect()` 之后 —— 释放路径会删除会话证据目录，必然读到 0 字节。已移到 disconnect 之前。
2. **`6` 在 `PROBE_SKIP_FEEDBACK=1` 时被计为 MISS**，导致退出码非 0。已改为打印 SKIPPED 且不计失败。

---

## 3. 下一步（按顺序）

### 3.1 完成 4.1 的最后一格（人工）

跑 `node --experimental-transform-types docs/references/native-cdp-probes/verify.mjs`，在弹出的 Glimpse 面板里输入一条评论并点 Submit（点 Cancel 也算有效结果，会走 `status: "cancelled"` 分支）。把完整输出连同面板行为一起写进 `docs/references/native-cdp-task-4.1.md`。

**已知风险**：`loadGlimpse()` 默认查 `glimpseui/src/glimpse.mjs` 与 `~/.pi/agent/npm/node_modules/glimpseui/src/glimpse.mjs`。后者在本机存在（macOS 原生二进制 `src/glimpse` 也在），所以第 6 项应当能起来。若 `/json/version` 或面板交互失败，先确认 Chrome 152 的连接级授权弹窗（`design.md` 风险一节的头号未知项）。

**若面板不可用**：退路是记录失败现象 + 走 `ctx.hasUI === false` 的文本回退分支证据，并如实标注 4.1 未完全达成 —— 不要静默降级判据。

### 3.2 4.2 更新文档

要改的文件（`docs/references/native-cdp-migration-prerequisites.md` 第 62 行列了旧行号）：

- `README.md` 第 75、80 行附近：`harnessPath` 示例与说明
- `README.zh-CN.md` 同上
- `docs/references/research.md`：环境要求章节

必须包含：删掉 Python 3.12 / `uv` / `cdp-use` / `websockets` / `pillow` 要求；给 `{ cdpUrl }` 的唯一配置示例；标注 `harnessPath` 是**破坏性变更**并给出迁移步骤（删该键）；`research.md` 里补一条可直接复制的 Chrome 启动命令（`--remote-debugging-port` + 独立 `--user-data-dir`，`purpose.md` 第三节「交付性目标只完成了一半」明确要求）。

验证方式（任务原文）：按文档从零配置一次并成功运行。

另需同步：`README.md:88-93` / `README.zh-CN.md:88-93` 的 `stateLabel` 说明要改成**必填语义**（基准声明过就必须重传），这是本轮 3.5 的行为变更。

### 3.3 4.3 终检

本轮已取的数（可直接引用，若再改动需重跑）：

```
pnpm typecheck        0 错
pnpm -w run lint      Checked 28 files, Found 3 infos (pre-existing noAwaitInLoops: cdp-actions.ts:302/460, context.ts:696)
pnpm test             Test Files 12 passed | 2 skipped (14); Tests 84 passed | 6 skipped (90)
openspec validate     Change 'harden-visual-loop-with-native-cdp' is valid
```

### 3.4 4.4 清理

- `rm -rf docs/references/browser-harness`（8.3M，已在 `.gitignore` 里，删的是工作树副本）
- `.gitignore` 里 `docs/references/browser-harness/` 那三行（含注释）一并删掉 —— 路径没了，排除规则就是死配置
- 同时评估 `docs/references/native-cdp-probes/` 是否入库：本轮新增 `verify.mjs`，它是**可复现的验收脚本**，建议保留（与 `release.mjs` / `budget.mjs` 同类）；若决定只留一份，删掉一次性的 `diag2.mjs` / `page2-4.mjs` / `probe3-6.mjs`

---

## 4. 尚未提交的改动清单

`main` 分支，工作树绿。建议的提交切分（项目纪律：小粒度、Conventional Commits、`git add <specific-file>`）：

| # | 提交 | 文件 |
| --- | --- | --- |
| 1 | `feat(visual-loop): require explicit stateLabel on verify` | `src/visual-loop/context.ts`、`tests/visual-loop-verify-manager.test.ts` |
| 2 | `feat(tools): default visual_verify to the common region pair` | `src/index.ts`、`tests/visual-loop-tool.test.ts` |
| 3 | `docs(references): add task 4.1 full-loop probe` | `docs/references/native-cdp-probes/verify.mjs`、待写的 `native-cdp-task-4.1.md` |
| 4 | `chore(openspec): tick 3.5 and 3.6` | `openspec/changes/.../tasks.md` |
| 5 | 上轮遗留的 1.x–3.4 主体（`src/visual-loop/cdp*.ts`、`redact.ts`、删 `harness.ts`、`tests/helpers/`、其余测试、`docs/references/native-cdp-*.md`、`.gitignore`） | 建议再拆 2–4 个提交 |

`.gitignore` 当前 diff 里有两条互不相关的改动：上轮加的 `.pi-lens.json` 排除，与本轮无新增 —— 提交时按归属拆开。

---

## 5. 闸门真实性声明

本节所有数字均来自本轮实际执行的命令输出，未做推断。探针的 10 项 OK 来自第 2.1 节引用的完整终端输出。**第 6 项（Glimpse 人工反馈）没有跑过，`4.1` 因此不能勾选。**
