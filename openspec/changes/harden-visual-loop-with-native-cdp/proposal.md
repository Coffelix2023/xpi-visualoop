## Why

Pi 包机制只运行 `npm install`,没有 pip 或 uv 钩子,当前唯一的浏览器后端(外部 Python 命令)无法随包分发。用户必须自行安装 Python 3.12 与三个 PyPI 包。现有后端是三层套壳(spawn → Python 脚本 → PIL → WebSocket),而浏览器提供的 CDP 协议可被 Node 内置 `WebSocket` 直接承载。

## What Changes

- 浏览器后端改为扩展进程内直连 CDP 的只读客户端,新增运行时依赖为零。**BREAKING**:配置字段 `harnessPath` 移除。
- 前端采集与复核的裁剪由浏览器截图接口按区域坐标直接完成,不再依赖外部裁剪命令与图像库。
- 连接生命周期改为等于检查上下文生命周期(`prepare` 建立,`close` 释放),使诊断收集获得真实观察窗口。
- 删除对外部命令的 `spawn`、私有 Harness 目录与固定 Python 脚本适配。
- 开发期保留 `docs/references/browser-harness` 作为实现参考,全部任务执行完毕后删除。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `visual-evidence`: 页面准备不再依赖外部可执行文件,改为直连已配置的回环 CDP 端点;配置面移除后端路径并新增迁移期拒绝行为;按区域裁剪的坐标口径与局部图采样方式补充规格。
- `visual-verification`: 输出上界补充具名预算数字。

## Impact

- 主要影响 `src/visual-loop/harness.ts`(整体替换)、`config.ts`(配置字段变更)、`context.ts`(复核输出)、`evidence.ts`(裁剪与预算)、`index.ts`(工具结果组装)。
- **BREAKING**:`~/.pi/agent/xpi-visualoop.json` 与 `.pi/xpi-visualoop.json` 中已有的 `harnessPath` 将被拒绝或忽略并给出迁移提示;`cdpUrl` 语义不变。
- 移除运行时外部依赖:不再需要 Python 3.12、`uv`、`cdp-use`、`websockets`、`pillow`。Node 内置 `WebSocket` 承担传输。
- 真机配置 `harnessPath` 当前指向已删除的仓库内路径,迁移前必须先恢复 `docs/references/browser-harness` 作为实现参考。
- 不改变只读边界:仍不向 Agent 开放点击、输入、任意页面脚本执行或自动修复;不新增第三方运行时依赖;不修改 Pi 系统提示词。
- 需同步更新 `README.md`、`README.zh-CN.md`、`docs/references/research.md` 的环境要求与配置说明。
