import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Capture, Comparison, Region } from "./evidence.ts";

export interface FeedbackImage {
  height: number;
  path?: string;
  width: number;
}

export interface FeedbackComparisonInput {
  beforeCaptureId: string;
  beforeImage: FeedbackImage;
  beforeImageData?: string;
  comparisonId: string;
  reasons: string[];
  status: Comparison["status"];
}
export interface FeedbackPanelInput {
  capturedAt: string;
  captureId: string;
  comparison?: FeedbackComparisonInput;
  image: FeedbackImage;
  imageData?: string;
  imagePath?: string;
  pageTitle: string;
  pageUrl: string;
  readiness: "degraded" | "ready";
  readinessReasons: string[];
}

export function feedbackPanelInput(capture: Capture): FeedbackPanelInput {
  return {
    capturedAt: capture.startedAt,
    captureId: capture.captureId,
    image: capture.image,
    imagePath: capture.image.path,
    pageTitle: capture.page.title,
    pageUrl: capture.page.url,
    readiness: capture.readiness.status,
    readinessReasons: capture.readiness.reasons,
  };
}

export function comparisonPanelInput(
  comparison: Comparison,
  before: Capture,
  after: Capture,
): FeedbackPanelInput {
  if (comparison.beforeCaptureId !== before.captureId)
    throw new Error("comparison baseline capture does not match");
  if (comparison.afterCaptureId !== after.captureId)
    throw new Error("comparison after capture does not match");
  return {
    ...feedbackPanelInput(after),
    comparison: {
      beforeCaptureId: before.captureId,
      beforeImage: before.image,
      comparisonId: comparison.comparisonId,
      reasons: comparison.reasons,
      status: comparison.status,
    },
  };
}

export async function embedFeedbackImage(
  input: FeedbackPanelInput,
): Promise<FeedbackPanelInput> {
  const imagePath = input.imagePath ?? input.image.path;
  const imageData = imagePath
    ? `data:image/png;base64,${(await readFile(imagePath)).toString("base64")}`
    : input.imageData;
  const beforePath = input.comparison?.beforeImage.path;
  const beforeImageData = beforePath
    ? `data:image/png;base64,${(await readFile(beforePath)).toString("base64")}`
    : input.comparison?.beforeImageData;
  return {
    ...input,
    ...(imageData
      ? {
          imageData,
        }
      : {}),
    ...(input.comparison
      ? {
          comparison: {
            ...input.comparison,
            ...(beforeImageData
              ? {
                  beforeImageData,
                }
              : {}),
          },
        }
      : {}),
  };
}

export interface DisplayRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface DisplayRegion extends Region {}

export interface FeedbackDraft {
  comment: string;
  image: Pick<FeedbackImage, "height" | "width">;
  region: Region;
}

export interface GlimpsePromptOptions {
  floating?: boolean;
  height?: number;
  timeout?: number;
  title?: string;
  width?: number;
}

export interface GlimpseWindow {
  close(): void;
  on(event: "closed" | "message", listener: (value?: unknown) => void): void;
}

export interface GlimpseModule {
  open(html: string, options?: GlimpsePromptOptions): GlimpseWindow;
  prompt?(html: string, options?: GlimpsePromptOptions): Promise<unknown>;
}

const MAX_COMMENT_LENGTH = 2000;
const DEFAULT_GLIMPSE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "npm",
  "node_modules",
  "glimpseui",
  "src",
  "glimpse.mjs",
);

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "'": "&#39;",
        '"': "&quot;",
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
      })[character] ?? character,
  );
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function normalizeRegion(region: DisplayRegion): DisplayRegion {
  finite(region.x, "region.x");
  finite(region.y, "region.y");
  finite(region.width, "region.width");
  finite(region.height, "region.height");
  return {
    height: Math.abs(region.height),
    width: Math.abs(region.width),
    x: Math.min(region.x, region.x + region.width),
    y: Math.min(region.y, region.y + region.height),
  };
}

export function displayRegionToImageRegion(
  region: DisplayRegion,
  imageRect: DisplayRect,
  displayScale: number,
): Region {
  finite(displayScale, "displayScale");
  if (displayScale <= 0) throw new Error("displayScale must be positive");
  const normalized = normalizeRegion(region);
  finite(imageRect.x, "imageRect.x");
  finite(imageRect.y, "imageRect.y");
  const result = {
    height: Math.round(normalized.height / displayScale),
    width: Math.round(normalized.width / displayScale),
    x: Math.round((normalized.x - imageRect.x) / displayScale),
    y: Math.round((normalized.y - imageRect.y) / displayScale),
  };
  return result;
}

export function validateFeedbackDraft(draft: FeedbackDraft): FeedbackDraft {
  if (typeof draft.comment !== "string" || draft.comment.trim().length === 0)
    throw new Error("comment must not be blank");
  if (draft.comment.length > MAX_COMMENT_LENGTH)
    throw new Error("comment exceeds the 2000 character limit");
  const { height, width } = draft.image;
  finite(height, "image.height");
  finite(width, "image.width");
  if (height <= 0 || width <= 0) throw new Error("image dimensions must be positive");
  const region = normalizeRegion(draft.region);
  if (region.width <= 0 || region.height <= 0)
    throw new Error("region must have positive area");
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > width ||
    region.y + region.height > height
  )
    throw new Error("region is outside image bounds");
  return {
    comment: draft.comment,
    image: {
      height,
      width,
    },
    region,
  };
}

export type FeedbackBridgeResult =
  | {
      status: "accepted";
    }
  | {
      status: "cancelled";
    }
  | {
      draft: FeedbackDraft;
      status: "submitted";
    };

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function validateFeedbackBridgeMessage(
  value: unknown,
  image: Pick<FeedbackImage, "height" | "width">,
  allowAcceptance = false,
): FeedbackBridgeResult {
  if (value === null)
    return {
      status: "cancelled",
    };
  const message = objectRecord(value, "feedback message");
  if (message.type === "cancel")
    return {
      status: "cancelled",
    };
  if (message.type === "accept") {
    if (!allowAcceptance) throw new Error("accept is only valid for a comparison");
    return {
      status: "accepted",
    };
  }
  if (message.type !== "submit")
    throw new Error(
      "feedback message type must be submit, cancel, or comparison accept",
    );
  const region = objectRecord(message.region, "feedback region");
  return {
    draft: validateFeedbackDraft({
      comment: message.comment as string,
      image,
      region: {
        height: region.height as number,
        width: region.width as number,
        x: region.x as number,
        y: region.y as number,
      },
    }),
    status: "submitted",
  };
}

function imageSource(
  image: FeedbackImage,
  imageData?: string,
  imagePath?: string,
): string {
  if (imageData) return imageData;
  if (!imagePath && !image.path)
    return "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  return pathToFileURL(imagePath ?? image.path ?? "").href;
}

export function renderFeedbackPanel(input: FeedbackPanelInput): string {
  const image = input.image;
  finite(image.width, "image.width");
  finite(image.height, "image.height");
  if (image.width <= 0 || image.height <= 0)
    throw new Error("image dimensions must be positive");
  const comparison = input.comparison;
  if (comparison) {
    finite(comparison.beforeImage.width, "beforeImage.width");
    finite(comparison.beforeImage.height, "beforeImage.height");
    if (comparison.beforeImage.width <= 0 || comparison.beforeImage.height <= 0)
      throw new Error("before image dimensions must be positive");
  }
  const reasons = [
    ...input.readinessReasons,
    ...(comparison?.reasons ?? []),
  ]
    .map((reason) => `<li>${escapeHtml(reason)}</li>`)
    .join("");
  const status = input.readiness === "ready" ? "Ready" : "Degraded";
  const src = escapeHtml(imageSource(image, input.imageData, input.imagePath));
  const beforeSrc = comparison
    ? escapeHtml(imageSource(comparison.beforeImage, comparison.beforeImageData))
    : undefined;
  const imageContent = comparison
    ? `<section class="comparison-images" aria-label="Before and after screenshots">
<figure><figcaption>Before · ${escapeHtml(comparison.beforeCaptureId)}</figcaption><div class="shot"><img id="before-image" alt="Before page screenshot" src="${beforeSrc}" width="${comparison.beforeImage.width}" height="${comparison.beforeImage.height}"></div></figure>
<figure><figcaption>After · ${escapeHtml(input.captureId)} · feedback target</figcaption><div id="image-scroll" class="shot" aria-label="After screenshot region selector"><div id="image-stage"><img id="evidence-image" alt="After page screenshot" src="${src}" width="${image.width}" height="${image.height}"><div id="selection"></div></div></div></figure>
</section>`
    : `<section id="image-scroll" class="shot single" aria-label="Screenshot region selector"><div id="image-stage"><img id="evidence-image" alt="Captured page screenshot" src="${src}" width="${image.width}" height="${image.height}"><div id="selection"></div></div></section>`;
  const title = comparison ? "Visual comparison" : "Visual feedback";
  const identity = comparison
    ? `${comparison.comparisonId} · ${comparison.status} · Not reviewed`
    : `${input.captureId} · ${status} · ${input.capturedAt}`;
  const acceptButton = comparison
    ? '<button id="accept" class="primary" type="button">Accept result</button>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: dark light; --canvas: #1e1e1e; --ink: #d4d4d4; --muted: #808080; --rule: #3c3c3c; --primary: #3b82f6; --error: #f44747; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--ink); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
main { display: flex; flex-direction: column; gap: 12px; height: 100vh; padding: 16px; }
header, footer { display: flex; align-items: center; gap: 10px; }
header { justify-content: space-between; border-bottom: 1px solid var(--rule); padding-bottom: 10px; }
h1 { font-size: 14px; margin: 0; }
.meta, .hint { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
button, input, textarea { color: inherit; background: #2a2a2a; border: 1px solid var(--rule); border-radius: 4px; font: inherit; }
button { cursor: pointer; padding: 6px 10px; }
button.primary { background: var(--primary); border-color: var(--primary); color: white; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.comparison-images { display: grid; flex: 1; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; min-height: 120px; }
figure { display: flex; flex-direction: column; gap: 6px; margin: 0; min-width: 0; min-height: 0; }
figcaption { color: var(--muted); font-size: 11px; }
.shot { min-height: 120px; overflow: auto; border: 1px solid var(--rule); padding: 12px; }
.shot.single { flex: 1; }
#image-stage { position: relative; width: max-content; min-width: 1px; }
#before-image, #evidence-image { display: block; max-width: none; user-select: none; }
#selection { position: absolute; display: none; border: 2px solid var(--primary); background: color-mix(in srgb, var(--primary) 20%, transparent); pointer-events: none; }
.fields { display: grid; grid-template-columns: repeat(4, minmax(60px, 1fr)); gap: 8px; }
label { display: grid; gap: 4px; color: var(--muted); font-size: 11px; }
input { min-width: 0; padding: 6px; }
textarea { width: 100%; min-height: 64px; resize: vertical; padding: 8px; }
footer { justify-content: space-between; border-top: 1px solid var(--rule); padding-top: 10px; }
.actions { display: flex; gap: 8px; }
@media (max-width: 760px) { .comparison-images { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
</style>
</head>
<body>
<main>
<header>
  <div><h1>${title}</h1><div class="meta">${escapeHtml(identity)}</div></div>
  <div class="actions" aria-label="Zoom controls"><button id="zoom-out" type="button" title="Zoom out">A−</button><button id="zoom-reset" type="button" title="Reset zoom">⟲</button><button id="zoom-in" type="button" title="Zoom in">A+</button></div>
</header>
<section class="meta"><div>${escapeHtml(input.pageTitle)}</div><div>${escapeHtml(input.pageUrl)}</div>${reasons ? `<ul>${reasons}</ul>` : ""}</section>
${imageContent}
<section>
<div class="fields">
<label>X<input id="region-x" type="number" min="0" step="1" value="0"></label>
<label>Y<input id="region-y" type="number" min="0" step="1" value="0"></label>
<label>Width<input id="region-width" type="number" min="1" step="1" value="1"></label>
<label>Height<input id="region-height" type="number" min="1" step="1" value="1"></label>
</div>
<label>Comment<textarea id="feedback-comment" maxlength="2000" autofocus placeholder="Describe the visual change"></textarea></label>
<div id="error" class="hint" role="alert" aria-live="polite"></div>
</section>
<footer><span class="hint">Drag on after image · Enter submit · Esc cancel</span><div class="actions"><button id="cancel" type="button">Cancel</button><button id="submit" type="button">Submit feedback</button>${acceptButton}</div></footer>
</main>
<script>
(() => {
  const image = document.getElementById("evidence-image");
  const selection = document.getElementById("selection");
  const comment = document.getElementById("feedback-comment");
  const fields = ["x", "y", "width", "height"].reduce((all, key) => { all[key] = document.getElementById("region-" + key); return all; }, {});
  const source = ${json({
    height: image.height,
    width: image.width,
  })};
  let zoom = 1;
  let start = null;
  let sent = false;
  const number = (key) => Number(fields[key].value);
  const region = () => ({ x: number("x"), y: number("y"), width: number("width"), height: number("height") });
  const updateSelection = () => {
    const value = region();
    selection.style.display = "block";
    selection.style.left = Math.min(value.x, value.x + value.width) * image.clientWidth / source.width + "px";
    selection.style.top = Math.min(value.y, value.y + value.height) * image.clientHeight / source.height + "px";
    selection.style.width = Math.abs(value.width) * image.clientWidth / source.width + "px";
    selection.style.height = Math.abs(value.height) * image.clientHeight / source.height + "px";
  };
  const sourcePoint = (event) => { const rect = image.getBoundingClientRect(); return { x: (event.clientX - rect.left) * source.width / rect.width, y: (event.clientY - rect.top) * source.height / rect.height }; };
  const send = (message) => { if (!sent) { sent = true; window.glimpse.send(message); } };
  image.addEventListener("pointerdown", (event) => { start = sourcePoint(event); image.setPointerCapture(event.pointerId); });
  image.addEventListener("pointermove", (event) => { if (!start) return; const end = sourcePoint(event); fields.x.value = String(Math.round(Math.min(start.x, end.x))); fields.y.value = String(Math.round(Math.min(start.y, end.y))); fields.width.value = String(Math.round(Math.abs(end.x - start.x))); fields.height.value = String(Math.round(Math.abs(end.y - start.y))); updateSelection(); });
  image.addEventListener("pointerup", () => { start = null; });
  Object.values(fields).forEach((field) => field.addEventListener("input", updateSelection));
  document.getElementById("zoom-out").addEventListener("click", () => { zoom = Math.max(0.8, zoom - 0.1); document.body.style.zoom = zoom; });
  document.getElementById("zoom-reset").addEventListener("click", () => { zoom = 1; document.body.style.zoom = zoom; });
  document.getElementById("zoom-in").addEventListener("click", () => { zoom = Math.min(1.5, zoom + 0.1); document.body.style.zoom = zoom; });
  const error = document.getElementById("error");
  const fail = (message) => { error.textContent = message; comment.focus(); };
  const submit = () => {
    try {
      const value = region();
      if (!comment.value.trim()) throw new Error("Comment must not be blank.");
      if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) throw new Error("Coordinates must be finite.");
      if (value.width <= 0 || value.height <= 0) throw new Error("Region must have positive area.");
      if (value.x < 0 || value.y < 0 || value.x + value.width > source.width || value.y + value.height > source.height) throw new Error("Region must stay inside the screenshot.");
      send({ type: "submit", comment: comment.value, region: value });
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : "Please correct the feedback.");
    }
  };
  document.getElementById("cancel").addEventListener("click", () => send({ type: "cancel" }));
  document.getElementById("submit").addEventListener("click", submit);
  ${comparison ? 'document.getElementById("accept").addEventListener("click", () => send({ type: "accept" }));' : ""}
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") send({ type: "cancel" }); else if (event.key === "Enter" && event.target !== comment) { event.preventDefault(); submit(); } });
  updateSelection();
})();
</script>
</body>
</html>`;
}

export function waitForFeedbackPanel(
  glimpse: GlimpseModule,
  html: string,
  options: GlimpsePromptOptions,
  signal: AbortSignal,
  onWindow: (close: () => void) => void,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const window = glimpse.open(html, options);
    const finish = (value: unknown, close: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (close) window.close();
      resolve(value);
    };
    const abort = (): void => finish(null, true);
    const timer = setTimeout(
      () => finish(null, true),
      options.timeout ?? 10 * 60 * 1000,
    );
    onWindow(() => finish(null, true));
    window.on("message", (value) => finish(value, true));
    window.on("closed", () => finish(null, false));
    signal.addEventListener("abort", abort, {
      once: true,
    });
    if (signal.aborted) abort();
  });
}

export async function loadGlimpse(modulePath?: string): Promise<GlimpseModule | null> {
  const candidates = modulePath
    ? [
        modulePath,
      ]
    : [
        "glimpseui/src/glimpse.mjs",
        DEFAULT_GLIMPSE_PATH,
      ];
  for (const candidate of candidates) {
    try {
      if (candidate.startsWith("/") && !existsSync(candidate)) continue;
      // biome-ignore lint/performance/noAwaitInLoops: fallback candidates must be tried in order.
      const imported = await import(
        candidate.startsWith("/") ? pathToFileURL(candidate).href : candidate
      );
      if (typeof imported.open === "function") return imported as GlimpseModule;
    } catch {
      // Optional UI dependency: callers provide a text fallback when unavailable.
    }
  }
  return null;
}
