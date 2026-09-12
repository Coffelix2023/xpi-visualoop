# xpi-visualoop

**English** · [简体中文](./README.zh-CN.md)

**An extension that gives the model eyes and gives you a review panel.** xpi-visualoop observes one local page through a browser you prepared yourself, returns immutable screenshots to the model, collects regional comments in a native Glimpse panel, and reports a comparability verdict when you ask it to verify a change.

**给模型一双眼睛,给你一个评审面板。** xpi-visualoop 通过你准备的浏览器观察一个本地页面,把不可变截图交给模型,在原生 Glimpse 面板里收集局部意见,并在复核时给出「是否可比」的判定。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)

```text
> prepare http://localhost:3000/settings, say what you see
> capture the #save-button region
> now verify: is this still the same dialog, or did my edit change it?
```

## Why

Ask a coding agent what a page looks like and you get prose. Ask it whether your edit changed the intended element and you get a confident guess. Neither is evidence.

This extension closes that loop with three hard rules:

- **Pixels, not paragraphs.** `visual_capture` returns the actual PNG content block plus bounded JSON metadata, so the model reasons about the real render.
- **A human can point.** `visual_feedback` opens a Glimpse panel over one capture or one comparison, so review is a region on the image instead of a paragraph in the chat.
- **Comparability is decided, not assumed.** `visual_verify` refuses to compare when the caller will not declare the interaction state, and returns `comparable` or `not-comparable` instead of quietly reporting a difference that came from a navigation.

It is deliberately read-only. The agent can look; it cannot click, type, scroll, or run page scripts. Everything runs against a dedicated browser profile, over the Chrome DevTools Protocol (CDP), with no external browser backend and no Python runtime. The transport is the `WebSocket` built into Node.js and the launcher is `node:child_process`, so the package adds zero runtime dependencies.

## Install

Requires Pi and a Chromium-based browser (Chrome, Chromium, Brave, Edge, or Arc) that can expose a loopback remote debugging endpoint.

```bash
pi install git:github.com/Coffelix2023/xpi-visualoop
```

| Where | Command |
| --- | --- |
| Global (user settings) | `pi install git:github.com/Coffelix2023/xpi-visualoop` |
| This project only (`.pi/settings.json`) | `pi install -l git:github.com/Coffelix2023/xpi-visualoop` |
| Local checkout, referenced in place | `git clone https://github.com/Coffelix2023/xpi-visualoop.git && pi install ./xpi-visualoop` |

`pi install` writes to `~/.pi/agent/settings.json`; `-l` writes to the project settings, which is installed automatically after the project is trusted. A local path is referenced, not copied, so `git pull` in the checkout is your update path. Pinned git refs and versioned npm specs are not moved by `pi update`.

```bash
pi list                                        # installed packages
pi update --extensions                         # update packages
pi remove git:github.com/Coffelix2023/xpi-visualoop
```

The package ships TypeScript source and has no build step: `package.json` points Pi straight at `./src/index.ts`.

## Setup

The extension never touches your daily profile and never falls back to another browser. It only starts a Chromium-based browser of its own when a visual tool needs the endpoint and nothing is listening there. That browser is a child process: `/xpi-visualoop disconnect` closes it, and Pi's own exit reaps it. A browser you started yourself is never adopted and never closed.

Prepare one yourself when you want to control the window:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.cache/xpi-visualoop/chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

On Linux, use your distribution's Chromium-based browser (for example `google-chrome`, `chromium`, `microsoft-edge`, or `brave-browser`) with the same flags.

Configuration is optional. Without it the extension uses the default endpoint `http://127.0.0.1:9333/`, the port in the command above. To point it somewhere else, write a config file at `<agentDir>/xpi-visualoop.json`; a trusted project may override it at `<cwd>/.pi/xpi-visualoop.json`.

```json
{
  "cdpUrl": "http://127.0.0.1:9333/",
  "launch": "minimized"
}
```

`cdpUrl` must be an `http://` loopback endpoint. `launch` is optional and accepts `minimized` (default), `headless`, or `windowed`. `glimpseModulePath` is optional and must be absolute. Unknown fields, a mistyped `cdpUrl`, an unsupported `launch` value, and an unparsable file still fail closed rather than being ignored; only the absent key falls back to the default.

### Launch forms

`launch` decides how the extension starts **its own** browser. A browser you started yourself is never re-shaped by it.

| `launch` | What happens | Can the user see and operate the page? |
| --- | --- | --- |
| `minimized` (default) | Headed window, minimized as soon as the endpoint answers, plus anti-throttling flags so a covered window still renders. | Yes. Bring the window back from the **Dock** (macOS) or the taskbar, change the page state by hand, then capture again. |
| `headless` | `--headless=new`: no window exists. | No. The page is not visible and the user cannot change its interaction state, so a review that needs a user interaction cannot be completed in that context. |
| `windowed` | The previous behavior: a visible, focused window. | Yes, directly. |

The window state is applied over CDP and reported back in the `visual_prepare` result (`launch`, `userOperable`, `interaction`, `windowState`). `windowState: "unknown"` means the minimization was neither confirmed nor applied — the extension does not claim a window state it could not verify.

> **BREAKING (default behavior).** Before `launch` existed, the extension always started a visible window. The default is now `minimized`, so no window comes to the front and no keyboard focus is taken. Set `"launch": "windowed"` to get the old behavior back.

Set `XPI_VISUALOOP_CHROME` to an absolute browser path when the browser is not in the default locations (macOS `/Applications`, or `google-chrome` / `chromium` / `microsoft-edge` / `brave-browser` on `PATH`).

The review panel is a Glimpse window (`glimpseui`). It is optional: without it, review degrades to text over the whole screenshot. Its fixed copy follows the session language unless a tool call declares `language`; the question, options, and labels you pass are never translated.

### Migrating from `harnessPath`

Earlier versions invoked a separately installed `browser-harness` executable. That backend is gone; `harnessPath` is now a **breaking change**, not a deprecated key. A config that still contains it fails closed with a migration hint.

1. Delete the `harnessPath` key from `<agentDir>/xpi-visualoop.json` and from any trusted `<cwd>/.pi/xpi-visualoop.json`.
2. Confirm `cdpUrl` points at your dedicated endpoint.
3. Reload Pi and run `/xpi-visualoop status`; it should report a configurable context and no migration diagnostic.

There is no database or browser-profile migration.

## Tools and command

The sequence is explicit and serial. Five read-only tools, no others.

| Tool | What it does |
| --- | --- |
| `visual_prepare` | Prepare one loopback URL, viewport, DPR (device pixel ratio), and an optional declared `stateLabel`. May create or navigate the extension-owned tab. |
| `visual_capture` | Capture the current viewport or one unique visible selector. Never navigates, scrolls, resizes, clicks, or types. |
| `visual_compare` | Compose one comparison out of two captures that already exist. Never captures, navigates, or scrolls, and always records `mode: "variant"`. |
| `visual_feedback` | Review one `captureId` or `comparisonId` in Glimpse: a picked element or a dragged region plus a comment, or a structured choice when the caller supplied a question. |
| `visual_verify` | Reuse a baseline capture's context and target for a new after-capture. Returns `comparable` or `not-comparable`, independent diagnostics, target/style changes, and bounded before/after images. |

`stateLabel` is a caller declaration, never proof supplied by the browser. When the baseline declared one, `visual_verify` refuses a silent caller and asks for the same label (the state is unchanged) or a new one (it changed). A verification that skipped this check could report a diff caused by opening a menu as if it were caused by your code.

By default `visual_verify` returns only the common region before and after. Pass `includeViewportImages` to also get the full-viewport pair.

`visual_compare` composes one comparison out of two captures that already exist. It records `mode: "variant"` — two design versions, not a change and its result — so the usual comparability differences (page URL, device pixel ratio, scroll position) come back as information instead of refusing the comparison. Pass `labels` to name the two sides; without them the panel says left and right rather than before and after. A variant comparison returns both sides as images, so the model sees the same pair the panel shows.

In the panel you can pick an element (hovering shows its `selector · role`) or drag a region; only a picked region carries the element's identity. Pass `question` and `options` together and the panel asks a single question whose answer comes back as a structured `choice`. `Esc` settles the cancel first and then asks whether to reopen the panel, skip the step, or stop asking for this inspection; the answer returns as `reopenRequested` and `suppressForRound`, and a suppressed round returns `suppressed` on later calls instead of opening anything.

```text
/xpi-visualoop status        # current inspection context
/xpi-visualoop disconnect    # cancel work, release owned files, close the browser it started
```

`disconnect` cancels pending operations, invalidates old evidence, removes extension-owned temporary files and browser resources, and closes the browser process this extension started. A browser you started yourself is left running.

## Limits and fallback behavior

Budgets are fixed on purpose; they are not a configuration surface.

- Exported screenshot: longest edge at most 2,000 device pixels and at most 4 MiB.
- One tool JSON result: at most 64 KiB. Model-facing capture text: at most 16 KiB.
- `visual_verify` and `visual_compare`: text at most 16 KiB, images at most 4 MiB in total; exceeding either fails loudly instead of dropping evidence silently.
- Console and network failure summaries: at most 20 entries each, truncation marked.
- Feedback comment: at most 2,000 characters.
- Operation: 30 seconds. Readiness wait: 5 seconds. Feedback panel: 10 minutes.
- One inspection: at most 20 captures and 128 MiB of evidence and intermediates.

Readiness and diagnostics stay honest rather than convenient: `ready`, `degraded`, `failed`, `observed`, and `unknown` remain distinct. The extension does not infer interaction hydration from network idle, does not collect authentication headers, cookies, or request bodies, does not enable recording, and does not claim a complete atomic DOM snapshot.

When Glimpse is unavailable but Pi has a UI, feedback falls back to explicit text feedback over the **entire screenshot**, preserving the image path and reference. Without a conversation surface, feedback returns `unavailable`; capture still works without a graphical window.

Known limits:

- The package is marked `private`, so `npm:` installs are not available. Use the git or local-path install above.
- Fedora Linux is not validated. The verified environment is macOS Darwin `25.6.2` arm64 with Chrome `152.0.7977.84`, Node.js `24.20.0`, and Pi `0.85.1`.
- The screenshots are real pixels of your page. See the privacy boundary below before pointing this at anything with credentials on screen.
- **The default launch form is `minimized`, which is a breaking change** from the earlier always-visible window. What the user can do differs by form: with `minimized` the window exists but must be brought back from the Dock or taskbar before anyone can operate the page; with `headless` there is no window at all, so the page is invisible and a review that depends on the user changing the page by hand cannot be completed. `visual_prepare` reports which of the two applies (`userOperable`, `interaction`).

## Files, privacy boundary, and rollback

Screenshots and intermediate files live in a private temporary directory owned by the inspection. Cleanup removes only what this extension created. A hard crash can leave residue for a later ownership check. A browser the extension started is a child of the Pi process and is reaped on exit; the profile it writes is the dedicated `~/.cache/xpi-visualoop/chrome-profile` directory, never a daily profile.

A screenshot returned in a tool result may be persisted by the Pi session or sent to your configured model service. Cleaning the extension's temporary directory does not delete those copies. Local capture is not a claim that the image never leaves the machine.

To roll back:

1. Run `/xpi-visualoop disconnect` in the active Pi session.
2. `pi remove git:github.com/Coffelix2023/xpi-visualoop` or delete the local path entry.
3. Delete only the dedicated profile and temporary directories this extension used; never a daily browser profile.

## Development

```bash
mise install
pnpm install
pnpm typecheck       # tsc --noEmit
pnpm -w run lint     # Biome repository check
pnpm test            # Vitest, tests/ only
```

All three must pass before a commit. The Vitest config collects only `tests/**/*.test.ts`; `docs/references` holds third-party sources and research-era probes with unrelated dependencies.

The trigger surface is a shipped skill rather than a system-prompt snippet, so whether the model actually reaches for the tools is a model-behaviour question, not a code question. Measure it instead of assuming it:

```bash
scripts/trigger-eval.sh          # three fixed prompts, checks the session transcript
scripts/trigger-eval.sh --case 2 # one case
```

Two positive cases must call `visual_prepare`; the negative case must not. Needs `pi` on PATH, a configured model, and a local dev server for the positive cases.

A runnable acceptance probe for the full loop lives at `docs/references/native-cdp-probes/verify.mjs`:

```bash
node --experimental-transform-types docs/references/native-cdp-probes/verify.mjs
```

It starts its own dedicated Chromium-based browser and page server, then exercises prepare, capture, the silent-caller rejection, a comparable verification, a real Glimpse feedback round, and the release path. `PROBE_SKIP_FEEDBACK=1` skips the human panel.

The launch forms have their own probe, `docs/references/native-cdp-probes/launch-forms.mjs`:

```bash
node --experimental-transform-types docs/references/native-cdp-probes/launch-forms.mjs
```

It runs all three forms against a real Chromium and a real page: the extension self-starts a browser for each, the minimized case is read back as `minimized` through `Browser.getWindowForTarget` and still produces the same pixels as the visible case, the headless case is checked in the process command line, and a stand-in browser the user owns must survive every case. It opens a visible window for the `windowed` case.

```text
.
├── mise.toml / package.json / biome.jsonc / vitest.config.ts / tsconfig.json
├── AGENTS.md / CONTEXT.md / DESIGN.md
├── docs/                    # workflow, reference notes, and verification records
├── openspec/                # change proposals, specs, design, and tasks
├── skills/xpi-visualoop/    # SKILL.md: the description the model reads to decide when to look
├── scripts/                 # trigger-eval.sh: the should-call smoke eval
├── src/index.ts             # Pi extension registration
├── src/visual-loop/         # config, chrome launcher, CDP client and actions, evidence, feedback, context
└── tests/                   # focused unit and integration tests
```

## Credits

- [Pi Coding Agent](https://github.com/earendil-works/pi) by [earendil-works](https://github.com/earendil-works) — the host this extension plugs into. The extension API, the `ctx.ui` contract, the `ctx.hasUI` fallback semantics, and the package manifest are theirs.
- [Glimpse](https://github.com/hazat/glimpse) by [hazat](https://github.com/hazat) — the native review panel. Optional: without it, feedback degrades to text over the whole screenshot.
- [browser-harness](https://github.com/browser-use/browser-harness) by [browser-use](https://github.com/browser-use) — the external backend this extension replaced. Its read-only behavior list (readiness triple check, the `degraded` reason set, diagnostics caps, target ownership checks) defined the equivalence bar the CDP rewrite had to meet, and its daemon-plus-IPC architecture made the cost of the replacement visible. MIT licensed. It is no longer installed or invoked, and the development-period reference clone has been removed.

## License

MIT
