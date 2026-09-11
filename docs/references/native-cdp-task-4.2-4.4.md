# 实测记录：任务 4.2 / 4.3 / 4.4（文档、终检、清理）

> 执行时间 2026-09-12 CST。目标 change `openspec/changes/harden-visual-loop-with-native-cdp`。
> 证据来源：按新文档从零配置的真机运行（Node 直接 import `src/` TS 源码）、四道闸门的完整输出、删除操作前后的文件系统状态。

## 1. 环境

| 项 | 值 |
| --- | --- |
| OS | macOS 26.2（25C56）arm64 |
| Node | `v24.20.0` |
| pnpm | `12.3.4` |
| Chrome | `152.0.7977.84` |
| Pi | `0.85.1` |
| 端点 | `http://127.0.0.1:9333/`（文档给出的示例端口） |

## 2. 任务 4.2：文档更新

任务原文：**「更新 `README.md`、`README.zh-CN.md`、`docs/references/research.md` 的环境要求与配置示例,移除 Python 与外部命令要求,标注配置破坏性变更与迁移步骤;验证方式:按文档从零配置一次并成功运行」**。

### 2.1 改动清单

| 文件 | 改动 |
| --- | --- |
| `README.md` / `README.zh-CN.md` | 整体重写为参考格式（英文版 / 中文版互为镜像）。简介中英双语；安装章节改为 `pi install git:github.com/Coffelix2023/xpi-visualoop`（含全局 / `-l` 项目局部 / 本地 checkout 三种来源，以及 `pi list` / `pi update --extensions` / `pi remove`），删掉原来的 `pi -e` 与软链开发法；配置示例只留 `cdpUrl`（+ 可选 `glimpseModulePath`）；`### Migrating from harnessPath` 小节保留 fail-closed 行为与三步迁移；`stateLabel` 必填语义保留；预算、隐私边界、回滚三节保留；新增 `## Credits` 致谢与已知限制清单 |
| `docs/references/research.md` | 附录 A 新增 `### 当前运行方式（2026-09-12 补充）`：可直接复制的专用 Chrome 启动命令、只含 `cdpUrl` 的配置示例、`harnessPath` 破坏性变更与一步迁移动作、可复现验收脚本的路径 |

`harnessPath` 的迁移语义与 `src/visual-loop/config.ts` 的 `HARNESS_MIGRATION_HINT` 逐字一致：残留该键时 `loadConfig` 不返回 `config`，只返回诊断。

### 2.2 验证：按文档从零配置并运行

验证脚本按最终 README 的「Setup」章节逐字启动 Chrome（`--remote-debugging-port=9333`、独立 `--user-data-dir`，仅额外加 `--headless=new` 以免弹出可见窗口），在空的 agent 目录与全新项目目录下写入文档给出的配置块，然后跑 `prepare` + `capture`。脚本为一次性验证件，不入库。

```
chrome debugging endpoint reachable: true
minimal config loads: true diagnostics: []
legacy harnessPath refused: true
hint matches README wording: true
documented git source resolves: true
loop runs: true crop=100x40 readiness=ready
```

判据对照：

| 判据 | 结果 |
| --- | --- |
| 只写 `cdpUrl` 即为完整配置 | 通过，`diagnostics` 为空数组 |
| README 里描述的拒绝行为属实 | 通过，带 `harnessPath` 的配置不返回 `config` |
| 诊断文案给出可照做的下一步 | 通过，命中 `delete the harnessPath key` |
| 按文档从零配置能跑通闭环 | 通过，视口 800×600、元素区域 100×40、`readiness=ready` |
| 文档给出的 `pi install` git 源可解析 | 通过，`git ls-remote` 能取到 `refs/heads/main`。**但该远端当前落后工作树 7 个提交**，即 `pi install git:...` 目前拿到的是 CDP 重写之前的版本；文档生效的前提是先把本变更推送上去 |

> 说明：本文档初版在 README 重写之前写成，第 2.2 节的输出已按重写后的 README 重跑一遍（多出一行 `documented git source resolves`，用于核对 `pi install` 里写的 git 源真实可解析）。`pi install` 的三种来源与 `pi list` / `pi update --extensions` / `pi remove` 的语义取自 Pi 官方 `docs/packages.md`；`pi install` 对本地相对路径会重写为相对 settings 文件的路径，已在隔离的 `PI_CODING_AGENT_DIR` 下实测确认。

## 3. 任务 4.3：终检

任务原文：**「运行 `pnpm typecheck`、`pnpm -w run lint`、`pnpm test` 与 `openspec validate`,交付全部通过的输出;若有失败,逐条说明其是否属本变更范围」**。

四条命令的实际输出：

```
pnpm typecheck        0 错
pnpm -w run lint      Checked 28 files, Found 3 infos, exit 0
pnpm test             Test Files 12 passed | 2 skipped (14); Tests 84 passed | 6 skipped (90)
openspec validate     Change 'harden-visual-loop-with-native-cdp' is valid
```

lint 的 3 条 info 位置：

| 位置 | 内容 |
| --- | --- |
| `src/visual-loop/cdp-actions.ts:302` | `waitForReadiness` 的就绪轮询等待 |
| `src/visual-loop/cdp-actions.ts:460` | `prepareOwnedPage` 的导航等待轮询 |
| `src/visual-loop/context.ts:696` | `disconnect` 逐个关闭自有标签页 |

**是否属本变更范围：是。** 1.3 记录的基线 lint 为 `Checked 20 files / No fixes applied / exit 0`，即基线零发现；这 3 条是本变更新代码引入的。均为 `info` 级、退出码 0，不是错误：三处都是**刻意的串行等待/串行释放**，改成 `Promise.all` 会破坏语义（轮询要按节奏观察同一页面；关闭标签页要逐个校验归属）。旧实现把轮询交给外部命令，所以基线看不到该规则触发。

2 个被跳过的测试文件是 `tests/.task*-real.test.ts`：真机验证件，默认跳过，与本次改动无关。

## 4. 任务 4.4：清理

任务原文：**「清理开发期参考实现:`docs/references/browser-harness` 不再需要后删除,更新 `.gitignore` 排除该路径」**。

| 操作 | 结果 |
| --- | --- |
| `rm -rf docs/references/browser-harness` | 已删，回收 8.3 MB |
| `.gitignore` 删除该路径的注释行与排除行 | 已删；路径不存在后该规则即为死配置 |
| 全仓引用检查 | `src/`、`tests/`、`package.json`、`mise.toml` 无残留调用；`tests/visual-loop-config.test.ts` 里的 `harnessPath` 是**故意保留的拒绝用例** |

`.gitignore` 的 `**/*backup*` 规则**保留**：`docs/references/_backup/` 里仍有 OmniParser、browser-use、html-anything、openbrowser、screenshot-to-code 五个研究期 clone（168 MB，被该规则覆盖），不属于本任务的清理范围。

重取方式见 `docs/references/research.md` 附录 A「参考点」：`git clone https://github.com/browser-use/browser-harness.git`，已核对 commit `afbcc381b963040c19627d788e40c7e7663171ee`。

### 4.1 探针目录保留决定

`docs/references/native-cdp-probes/` 全量保留，包括一次性的 `diag2.mjs` / `page2-4.mjs` / `probe3-6.mjs`。理由：这些脚本各自是已交付证据文档的引用对象——`diag2.mjs` 被 `native-cdp-task-2.7.md` 引用，`page3.mjs` / `png.mjs` 被 `native-cdp-task-2.8.md` 引用，`page3.mjs` / `page4.mjs` / `budget.mjs` 被 `native-cdp-task-2.9.md` 引用。删掉它们会让这些实测记录里的结论失去可复核的出处，共约 40 KB，收益为负。

## 5. 闸门真实性声明

第 3 节的四个数字来自本节实际执行的命令输出，未做推断。第 2.2 节的五行输出来自本节实际运行的一次性脚本。第 4 节的删除结果由 `du -sh` 与全仓 grep 核对。4.1（Glimpse 人工反馈）不包含在本文档中，其状态见 `docs/references/native-cdp-task-4.1.md`。
