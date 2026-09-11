# 触发面评测记录:为什么模型不主动调用 visual_* 工具

日期: 2026-09(研究轮次)
状态: 根因已定位;第一轮修复(SKILL.md + 自动拉起 Chrome)已落地;**should-call 冒烟尚未实跑**

## 被测现象

`xpi-visualoop` 注册了四个工具,Agent 在 web UI / 面板开发场景里不主动调用。

## 根因(按证据强度)

### R1 工具不进 system prompt 的 `Available tools` 区块(硬证据)

`@earendil-works/pi-coding-agent@0.85.1` 的 `dist/core/system-prompt.js`:

```js
// A tool appears in Available tools only when the caller provides a one-line snippet.
const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
```

`toolSnippets` 由 `ToolDefinition.promptSnippet` 填充(`dist/core/agent-session.js` 的 `_rebuildSystemPrompt`),
`promptGuidelines` 同理进 `Guidelines` 区块。`src/index.ts` 的四个 `registerTool` 两者都没给,
因此在 system prompt 里零出现,只能靠 provider 侧的 tool schema 被扫到。

### R2 没有 skill,连"什么时候用"的常驻句子都没有

pi 用 `<available_skills>` 区块做渐进披露(`docs/skills.md`)。修复前 `package.json` 的 `pi` 只声明 `extensions`,
`skills/` 目录不存在,`resources_discover` 也未注册。

### R3 描述只写机制,不写时机

修复前四条描述全是名词化陈述(例:`"Prepare a configured loopback page in the dedicated local browser context."`),
无触发条件、无前置条件。Anthropic《Writing effective tools for agents》把 description 称为
tool performance 的 "by far the most important factor",要求写全 what / when / when not,建议 3-4 句。

### R4 零状态感知

修复前只有 `session_start` / `session_before_switch` / `session_shutdown` 三个清理钩子。
`before_agent_start`、`input`、`tool_result` 一律未用,扩展从不告诉模型"现在能不能用"。

### R5 摩擦不对称

修复前 `loadConfig` 缺 `cdpUrl` 即 fail-closed,且端点必须由人类先起 Chrome。
一次失败即可固化"这工具不可用"的先验。

### R6 没有度量"该不该调用"

`tests/` 全是功能与边界测试,没有 tool-selection 评测,行为退化不可见。

## 同类项目证据

`@juicesharp/rpiv-*`(`rpiv-todo`、`rpiv-ask-user-question`、`rpiv-advisor`、`rpiv-config`)是同一宿主下的对照组:

| 机制 | rpiv 的做法 |
| :--- | :--- |
| skill | **完全没有**。`SKILL.md` 数量为 0,`package.json` 无 `skills` 键 |
| `promptSnippet` | 每个工具都设,且自带触发条件(例:"…when requirements are ambiguous") |
| `promptGuidelines` | todo 9 条、advisor 7 条、ask 5 条。含正面触发、可自检的作业规则、显式负面排除 |
| `description` | 长文本,内含 "Use when you need to: 1..4" 枚举(ask 约 2000 字符) |
| 门控 | `before_agent_start` + `setActiveTools`,不可用时**摘掉工具及其 prompt 块** |

rpiv-advisor 的 `advisor/restore.ts` 注释给出了门控动机:

> The tool is registered active-by-default at load, so its promptSnippet/promptGuidelines otherwise linger in
> the base system prompt even though every advisor() call would fail with ERR_NO_MODEL. See issue #72.

外部文献:

- Anthropic《Define tools》:description 要 prescriptive about *when* to call;新模型对工具更保守,
  trigger condition 对 should-call 率有可测提升。
- EMNLP 2025《Tool Preferences in Agentic LLMs are Unreliable》:仅改 description 文本即可把工具被调用率提高 7 倍(叠加多项 11 倍)。
- `microsoft/playwright-mcp`:把引导写进 description,并建议编码型 agent 优先用 CLI + SKILLS 而非 MCP。

## 与 rpiv 的结构差异

rpiv 的工具是纯对话工具,加载即可用。`xpi-visualoop` 需要三重前置条件(配置、浏览器、可达页面)。
因此它比 rpiv 更需要"可用性门控",而触发句写得再好也造不出可用性。

## 本轮决策(用户拍板)

| 决策点 | 选定 | 影响 |
| :--- | :--- | :--- |
| 触发面 | 仅 SKILL.md | 放弃 `promptSnippet` / `promptGuidelines`,R1 保持不修 |
| prompt 卫生 | 禁止改 system prompt | 事件注入(L3)本轮不做,留作第一顺位追加项 |
| 前置条件 | 扩展自动拉起 Chrome | `loadConfig` 缺 `cdpUrl` 回退到默认端点,其余仍 fail-closed |
| 验收 | 脚本化 should-call 冒烟 | 用测量代替假设 |

实现落点:

- `skills/xpi-visualoop/SKILL.md` + `package.json` 的 `pi.skills`
- `src/visual-loop/chrome.ts`,接在单一缝隙 `validateEndpointReachability`(`src/visual-loop/config.ts`)
- `scripts/trigger-eval.sh`

## 未决

1. `resources_discover` 是否能按可用性动态门控 skill(推断:粒度是 session 级,非每轮),未实测。
2. Chrome 每连接授权弹窗对自动拉起路径的影响(macOS 未实测)。
3. SKILL.md 单独是否足以稳定触发 —— 这正是冒烟要回答的问题,当前无证据。
4. `package.json` 的 `pi.skills` 能否通过 `~/.pi/agent/extensions/` 下的软链开发回路被发现,未实测。冒烟脚本因此显式传 `--skill ./skills`,不依赖该路径。

## 复现

```bash
pnpm typecheck && pnpm -w run lint && pnpm test
scripts/trigger-eval.sh
```
