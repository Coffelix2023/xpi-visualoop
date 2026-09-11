---
name: xpi-visualoop
description: Look at the real rendered pixels of one local page and let the user point at a region of that image. Use when the user asks how a local page, panel, or component currently looks, when they want to review or mark up a render, when they want to choose between two rendered versions of the same local page, or after you change frontend code that a local dev server renders — capture the page before you declare the change done. Skip it for pure logic or backend changes, for pages you cannot reach on loopback, and for producing diagrams or mockups.
license: MIT
---

# xpi-visualoop

Five read-only tools that hand the model real pixels of one local page, and hand
the user a panel to point at a region of that image.

## The loop

The sequence is explicit and serial. One inspection context, one page.

**1. `visual_prepare` — prepare one loopback URL.**

```json
{ "url": "http://localhost:3000/settings", "viewport": { "width": 1280, "height": 800 }, "dpr": 2 }
```

- `url` is required, and must be `http://` or `https://` on `localhost`, `127.0.0.1`, or `::1`.
- `viewport` and `dpr` (1-2) pin the render. Set them when layout or spacing is the question.
- Pass `stateLabel` whenever the visible state depends on an interaction (for example `"settings tab open"`).

Returns an `inspectionId` as text. No image yet.

**2. `visual_capture` — take the picture.**

```json
{}                              // the current viewport
{ "selector": "#save-button" }  // one unique visible element
```

Returns the PNG plus bounded JSON metadata (`captureId`, size, `readiness`).
`readiness: "degraded"` means the page had not settled; the pixels are still real,
so mention it when you use them.

**3. `visual_feedback` — optional, only when a human answer actually helps.**

`{ "captureId": "..." }` or `{ "comparisonId": "..." }`, exactly one.
Opens a panel over the image: the user drags a region and comments, or accepts, or
cancels. Returns one explicit result — `submitted`, `accepted`, `cancelled`, or
`unavailable`. Treat `cancelled` and `unavailable` as "no feedback", never as approval.

**4. `visual_verify` — prove the change did what you claim.**

`{ "baselineCaptureId": "...", "stateLabel": "same label, or the new one" }`

Captures the same target again and returns `comparable` or `not-comparable`, plus
independent diagnostics and target/style changes. Add `includeViewportImages: true`
only when the common-region pair is not enough; the extra images cost budget.

**5. `visual_compare` — choose between two rendered versions.**

`{ "leftCaptureId": "...", "rightCaptureId": "...", "labels": ["B1 compact", "B2 airy"] }`

Capture each version first, then compare the two captures you already have. Nothing
is re-rendered and the page is left exactly as it was. Both sides come back as
images captioned with your labels. A variant comparison is never refused for
living at two different URLs — every difference between the versions is reported
as information, because the two sides are meant to differ. `labels` is optional;
without it the sides are called left and right.

Use `visual_verify` when the question is "did my change do what I claimed". Use
`visual_compare` when the question is "which of these two should I ship".

## Rules

- **`stateLabel` is your declaration, not proof from the browser.** When the baseline
  declared one, `visual_verify` refuses a caller that stays silent: repeat the same
  label (state unchanged) or declare a new one (state changed). Skipping this makes a
  diff caused by opening a menu look like a diff caused by your code.
- **A variant comparison is not a regression check.** `visual_compare` files every
  difference between the two versions as information and never refuses the pair, so
  its `reasons` are not failures. `not-comparable` only ever comes from
  `visual_verify`.
- **These tools never click, type, scroll, resize, or run page scripts.** If the next
  step needs an interaction, ask the user to perform it, then capture again.
- **Budgets are fixed.** Longest edge at most 2000 device pixels, one tool result at
  most 64 KiB of JSON, capture text at most 16 KiB, verify images at most 4 MiB in
  total. Over-budget calls fail loudly rather than dropping evidence. Lower `dpr`, or
  capture a `selector` instead of the viewport.

## Setup and failure

The endpoint comes from `<agentDir>/xpi-visualoop.json` and defaults to
`http://127.0.0.1:9333/`. When nothing listens there, the extension starts its own
Chrome with a dedicated profile (`~/.cache/xpi-visualoop/chrome-profile`); set
`XPI_VISUALOOP_CHROME` when the binary lives elsewhere. `/xpi-visualoop disconnect`
cancels work and closes the browser the extension started.

When a call fails because no browser is available, tell the user that visual
verification was skipped and why. Never describe what a page looks like without a
capture, and never claim you looked when you did not.
