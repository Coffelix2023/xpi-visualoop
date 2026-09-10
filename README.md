# xpi-visualoop

**简体中文**: [README.zh-CN.md](./README.zh-CN.md)

A local visual feedback loop extension for the Pi Coding Agent. It observes a page through a user-prepared loopback browser, returns immutable screenshots to the model, collects optional regional feedback in Glimpse, and compares a baseline with a later capture.

> No build step: Pi loads `src/index.ts` directly. This package does not install, start, or close your browser.

## Requirements

- Node.js `24.20.0` and pnpm `12.3.4` for the verified development setup.
- A separately installed `browser-harness` executable. The extension invokes the configured executable with a fixed script and `shell: false`.
- A dedicated Chrome/Chromium profile with a loopback CDP (Chrome DevTools Protocol) endpoint. Do not use a daily logged-in profile.
- Optional Glimpse `0.8.1` for graphical feedback on the verified macOS path.

The verified environment is macOS Darwin `25.6.2` arm64, Node.js `24.20.0`, pnpm `12.3.4`, Python `3.12.10`, Pi `0.84.4`, browser-harness `0.1.13`, Glimpse `0.8.1`, and Chrome `152.0.7977.84`. Fedora Linux has not been validated in this change.

## Quickstart

```bash
mise install
pnpm install
pnpm typecheck
pnpm -w run lint
pnpm test
```

The extension can be loaded without compiling:

```bash
pi -e ./src/index.ts
```

For live development, link the repository into the Pi extension directory and use `/reload` inside Pi:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/xpi-visualoop
```

## Dedicated browser setup

The extension accepts only an explicitly configured `http://` loopback endpoint and local page URLs on `localhost`, `127.0.0.1`, or `::1`. It rejects credentials, query/fragment data on the endpoint, external top-level navigation, and endpoint redirects away from loopback.

macOS example:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.cache/xpi-visualoop/chrome-profile" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

Fedora example (not validated in this change; adjust the executable path for the installed browser):

```bash
google-chrome \\
  --remote-debugging-port=9333 \\
  --user-data-dir="$HOME/.cache/xpi-visualoop/chrome-profile" \\
  --no-first-run \\
  --no-default-browser-check \\
  about:blank
```

The profile and endpoint are user responsibilities. The extension never launches the browser, changes the daily profile, or falls back to another browser.

## Configuration

Use a JSON file at `<agentDir>/xpi-visualoop.json`. A trusted project may override it with `<cwd>/.pi/xpi-visualoop.json`; an untrusted project file is ignored. Unknown fields and unsafe paths fail closed.

```json
{
  "cdpUrl": "http://127.0.0.1:9333/",
  "harnessPath": "/absolute/path/to/browser-harness",
  "glimpseModulePath": "/absolute/path/to/glimpseui/src/glimpse.mjs"
}
```

`harnessPath` is an absolute executable path or a safe command name. `glimpseModulePath` is optional and must be absolute. The configuration does not accept arbitrary command arguments, page scripts, tokens, cookies, or credentials.

`browser-harness` is kept outside the extension package. In this repository, `docs/references/browser-harness/browser-harness` is a pinned reference executable for local verification, not an automatic installer or runtime dependency.

## Tools and command

The normal sequence is explicit and serial:

1. `visual_prepare`: prepare one local URL, viewport, DPR (device pixel ratio), and optional declared `stateLabel`. This may create or navigate the extension-owned tab.
2. `visual_capture`: capture the current viewport, optionally resolving one unique visible selector. It does not navigate, scroll, resize, click, or type. The model receives the actual PNG content block and bounded JSON metadata.
3. `visual_feedback`: review one `captureId` or one `comparisonId`. Glimpse supports a single image region, numeric coordinates, text feedback, submit, cancel, and comparison acceptance.
4. `visual_verify`: reuse a baseline capture's context and target to create a new after capture. It returns `comparable` or `not-comparable`, independent diagnostics, target/style changes, and bounded before/after images.

After a human interaction or code edit, call `visual_capture` or `visual_verify` with an accurate declared state. `stateLabel` is a caller declaration, not proof supplied by the browser.

The command remains available:

```text
/xpi-visualoop status
/xpi-visualoop disconnect
```

`status` reports the current inspection context. `disconnect` cancels pending work, invalidates old evidence, removes extension-owned temporary files and resources, and does not close the browser process or delete its profile.

## Limits and fallback behavior

Initial fixed budgets are deliberately not user-configurable:

- Exported screenshot: longest edge at most 2,000 pixels and at most 4 MiB.
- One tool JSON result: at most 64 KiB; model-facing capture text: at most 16 KiB.
- Console and network failure summaries: at most 20 entries each, with truncation marked.
- Feedback comment: at most 2,000 characters.
- Operation: 30 seconds; readiness wait: 5 seconds; feedback panel: 10 minutes.
- One inspection: at most 20 captures and 128 MiB of evidence/intermediate files.

Readiness and diagnostics are bounded and honest: `ready`, `degraded`, `failed`, `observed`, and `unknown` remain distinct. The extension does not infer interaction hydration from network idle, collect authentication headers/cookies/request bodies, enable recording, or claim a full atomic DOM snapshot.

If Glimpse is unavailable but Pi has a UI, feedback falls back to explicit text feedback over the **entire screenshot** and preserves the image path and reference. Without a conversation surface, feedback returns `unavailable`; capture remains usable without a graphical window.

## Files, privacy boundary, and rollback

Screenshots and intermediate files live in a private temporary directory owned by the inspection. Cleanup removes only files and browser resources created by this extension. A crash may leave residue for a later ownership check. The browser process and profile remain user-owned.

A screenshot returned in a tool result may be persisted by the Pi session or sent to the configured model service. Cleaning the extension temporary directory does not delete those copies. This extension makes no claim that local capture means the image never leaves the machine.

To roll back:

1. Run `/xpi-visualoop disconnect` in the active Pi session.
2. Remove the extension symlink or remove its entry from the Pi extension configuration, or revert this repository change.
3. Remove only the dedicated profile and temporary directories if you created them for this extension; do not remove a daily browser profile.

There is no database migration and no required browser configuration migration.

## Development gates

```bash
pnpm typecheck       # TypeScript strict check
pnpm -w run lint     # Biome repository check
pnpm test            # Vitest tests under tests/
```

The Vitest configuration intentionally collects only `tests/**/*.test.ts`; `docs/references` contains third-party source and tests with unrelated dependencies.

## Repository layout

```text
.
├── mise.toml / package.json / biome.jsonc / vitest.config.ts / tsconfig.json
├── AGENTS.md / CONTEXT.md / DESIGN.md
├── docs/                    # workflow, reference notes, and verification records
├── openspec/                # change proposal, specs, design, and tasks
├── src/index.ts             # Pi extension registration
├── src/visual-loop/         # config, Harness adapter, evidence, feedback, context
└── tests/                   # focused unit/integration tests
```
