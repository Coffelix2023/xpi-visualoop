import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Capture,
  CaptureCandidate,
  Comparison,
  FeedbackTarget,
  Region,
} from "./evidence.ts";

export type PanelLanguage = "en" | "zh-CN";

/**
 * Every fixed string the panel shows. Caller-supplied question, options and labels are
 * never translated: they arrive in whatever language the caller wrote them in.
 */
export const PANEL_COPY: Record<PanelLanguage, Record<string, string>> = {
  en: {
    accept: "Accept result",
    acceptSide: "Accept {side}",
    cancel: "Cancel",
    cancelBody:
      "Cancel is not approval and not rejection. The tool returns cancelled with no feedback. What next?",
    cancelNever: "Don't ask again this round",
    cancelReopen: "Reopen the panel",
    cancelSkip: "Skip this step",
    cancelTitle: "This review was cancelled",
    candidateList: "Candidate elements",
    chooseOne: "Choose one",
    comment: "Comment",
    commentPlaceholder: "Describe the visual change",
    compareImages: "Compared versions",
    degraded: "Degraded",
    dragHint: "Drag on the target image · Enter submit · Esc cancel",
    errorComment: "Comment must not be blank.",
    errorCoordinates: "Coordinates must be finite.",
    errorFix: "Please correct the feedback.",
    errorInside: "Region must stay inside the screenshot.",
    errorPick: "Pick one option.",
    errorPositive: "Region must have positive area.",
    feedbackTarget: "feedback target",
    height: "Height",
    notReviewed: "Not reviewed",
    optionalNote: "Optional note",
    pickHint: "Pick one option · Enter submit · Esc cancel",
    ready: "Ready",
    regionSelector: "Screenshot region selector",
    resetZoom: "Reset zoom",
    submitChoice: "Submit choice",
    submitFeedback: "Submit feedback",
    titleChoice: "Visual choice",
    titleComparison: "Visual comparison",
    titleFeedback: "Visual feedback",
    width: "Width",
    zoomControls: "Zoom controls",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
  },
  "zh-CN": {
    accept: "接受结果",
    acceptSide: "接受 {side}",
    cancel: "取消",
    cancelBody:
      "取消不等于认可，也不等于拒绝。工具会返回 cancelled 且不带任何意见。接下来要怎么走？",
    cancelNever: "本轮不再询问",
    cancelReopen: "重新打开面板",
    cancelSkip: "跳过这一步",
    cancelTitle: "已取消本次评审",
    candidateList: "候选元素",
    chooseOne: "请选择一项",
    comment: "意见",
    commentPlaceholder: "描述要修改的地方",
    compareImages: "参与比较的版本",
    degraded: "降级",
    dragHint: "在目标图上拖动 · Enter 提交 · Esc 取消",
    errorComment: "意见不能为空。",
    errorCoordinates: "坐标必须是有限数值。",
    errorFix: "请修正后再提交。",
    errorInside: "区域必须留在截图范围内。",
    errorPick: "请选择一项。",
    errorPositive: "区域必须有正的面积。",
    feedbackTarget: "反馈目标",
    height: "高",
    notReviewed: "未验收",
    optionalNote: "可选备注",
    pickHint: "选择一项 · Enter 提交 · Esc 取消",
    ready: "就绪",
    regionSelector: "截图区域选择器",
    resetZoom: "重置缩放",
    submitChoice: "提交选择",
    submitFeedback: "提交意见",
    titleChoice: "版本选择",
    titleComparison: "版本对比",
    titleFeedback: "视觉反馈",
    width: "宽",
    zoomControls: "缩放控件",
    zoomIn: "放大",
    zoomOut: "缩小",
  },
};

/**
 * The caller's declaration wins when it is present. Otherwise the panel follows the
 * runtime locale, which is where a session's language actually shows up.
 */
export function resolvePanelLanguage(
  declared?: string,
  locale: string = Intl.DateTimeFormat().resolvedOptions().locale,
): PanelLanguage {
  if (declared !== undefined) {
    if (declared === "en" || declared === "zh-CN") return declared;
    throw new Error("panel language must be en or zh-CN");
  }
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export interface FeedbackImage {
  /** Output pixels per page coordinate unit. Absent means 1:1. */
  coordinateScale?: {
    x: number;
    y: number;
  };
  height: number;
  path?: string;
  width: number;
}

export interface FeedbackComparisonInput {
  beforeCaptureId: string;
  beforeImage: FeedbackImage;
  beforeImageData?: string;
  comparisonId: string;
  labels?: [
    string,
    string,
  ];
  mode: Comparison["mode"];
  reasons: string[];
  status: Comparison["status"];
}
export interface FeedbackPanelInput {
  candidates?: CaptureCandidate[];
  capturedAt: string;
  captureId: string;
  comparison?: FeedbackComparisonInput;
  image: FeedbackImage;
  imageData?: string;
  imagePath?: string;
  /** Resolved by the caller; the panel falls back to English when it is absent. */
  language?: PanelLanguage;
  options?: string[];
  pageTitle: string;
  pageUrl: string;
  question?: string;
  readiness: "degraded" | "ready";
  readinessReasons: string[];
}

export function feedbackPanelInput(capture: Capture): FeedbackPanelInput {
  return {
    candidates: capture.candidates,
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
      ...(comparison.labels
        ? {
            labels: comparison.labels,
          }
        : {}),
      mode: comparison.mode,
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
  source: "pick" | "drag";
  target?: FeedbackTarget;
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
  if (draft.source !== "pick" && draft.source !== "drag")
    throw new Error("source must be pick or drag");
  if (draft.source === "drag" && draft.target !== undefined)
    throw new Error("only a picked region may carry an element identity");
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
    source: draft.source,
    ...(draft.target === undefined
      ? {}
      : {
          target: draft.target,
        }),
  };
}

export type FeedbackBridgeResult =
  | {
      status: "accepted";
    }
  | {
      /** Present only when the panel asked what to do next after the cancel. */
      reopenRequested?: boolean;
      status: "cancelled";
      suppressForRound?: boolean;
    }
  | {
      draft: FeedbackDraft;
      status: "submitted";
    }
  | {
      choice: string;
      draft?: FeedbackDraft;
      status: "chosen";
    };

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * A choice answer may carry a region and a comment, but it does not need them: the
 * caller asked a question, not for markup. A draft is only built when the user
 * supplied both, because feedback without a region has nothing to point at.
 */
/**
 * A panel sends the element identity only when the region came from a pick, so a
 * pick without one is a broken message rather than a hand-made region.
 */
function messageIdentity(message: Record<string, unknown>): {
  source: "pick" | "drag";
  target?: FeedbackTarget;
} {
  if (message.source !== "pick") {
    if (message.target !== undefined)
      throw new Error("a hand-made region must not carry an element identity");
    return {
      source: "drag",
    };
  }
  const target = objectRecord(message.target, "feedback target");
  return {
    source: "pick",
    target: {
      role: typeof target.role === "string" ? target.role : "",
      selector: typeof target.selector === "string" ? target.selector : "",
      text: typeof target.text === "string" ? target.text : "",
    },
  };
}

function choiceDraft(
  message: Record<string, unknown>,
  image: Pick<FeedbackImage, "height" | "width">,
): FeedbackDraft | undefined {
  if (message.region === undefined) return undefined;
  if (typeof message.comment !== "string" || message.comment.trim().length === 0)
    return undefined;
  const region = objectRecord(message.region, "feedback region");
  return validateFeedbackDraft({
    comment: message.comment,
    image,
    region: {
      height: region.height as number,
      width: region.width as number,
      x: region.x as number,
      y: region.y as number,
    },
    ...messageIdentity(message),
  });
}

export type FeedbackPanelForm = "capture" | "choice" | "comparison";

/**
 * A cancel is settled before the panel asks what to do next, so the follow-up answer
 * can only refine the same `cancelled` result; it can never turn the cancel into
 * approval, rejection, or a submission. The two flags travel together because one
 * question produced them.
 */
function cancelAnswer(message: Record<string, unknown>): FeedbackBridgeResult {
  const reopen = message.reopenRequested;
  const suppress = message.suppressForRound;
  if (reopen === undefined && suppress === undefined)
    return {
      status: "cancelled",
    };
  if (typeof reopen !== "boolean" || typeof suppress !== "boolean")
    throw new Error(
      "a cancel answer carries reopenRequested and suppressForRound together",
    );
  if (reopen && suppress)
    throw new Error("a cancel answer cannot both reopen the panel and skip the round");
  return {
    reopenRequested: reopen,
    status: "cancelled",
    suppressForRound: suppress,
  };
}

export function validateFeedbackBridgeMessage(
  value: unknown,
  image: Pick<FeedbackImage, "height" | "width">,
  form: FeedbackPanelForm = "capture",
): FeedbackBridgeResult {
  if (value === null)
    return {
      status: "cancelled",
    };
  const message = objectRecord(value, "feedback message");
  if (message.type === "cancel") return cancelAnswer(message);
  if (message.type === "accept") {
    if (form !== "comparison")
      throw new Error("accept is only valid for a comparison panel");
    return {
      status: "accepted",
    };
  }
  if (message.type === "choice") {
    if (form !== "choice") throw new Error("choice is only valid for a choice panel");
    if (typeof message.choice !== "string" || message.choice.length === 0)
      throw new Error("choice answer must be a non-empty string");
    const draft = choiceDraft(message, image);
    return {
      choice: message.choice,
      ...(draft
        ? {
            draft,
          }
        : {}),
      status: "chosen",
    };
  }
  if (message.type !== "submit")
    throw new Error(
      "feedback message type must be submit, choice, cancel, or comparison accept",
    );
  if (form === "choice")
    throw new Error("a choice panel submits a choice, not a region");
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
      ...messageIdentity(message),
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
  const choices = input.options;
  const question = input.question;
  // The panel's own copy follows the resolved language; the caller's question, options
  // and labels are never translated.
  const language: PanelLanguage = input.language ?? "en";
  const copy = PANEL_COPY[language];
  // A variant comparison names its sides with the caller's labels; without labels
  // the fallback is positional, never a claim about which came first.
  const sideLabels: [
    string,
    string,
  ] = comparison
    ? (comparison.labels ??
      (comparison.mode === "variant"
        ? [
            "Left",
            "Right",
          ]
        : [
            "Before",
            "After",
          ]))
    : [
        "Before",
        "After",
      ];
  // Candidate boxes arrive in page coordinates while the panel shows image pixels, so
  // a scaled export has to be mapped here or the hotspot drifts off its element.
  const scale = image.coordinateScale ?? {
    x: 1,
    y: 1,
  };
  const hotspots = (input.candidates ?? []).map((candidate, index) => ({
    height: Math.round(candidate.visibleBounds.height * scale.y),
    index,
    role: candidate.role,
    selector: candidate.selector,
    text: candidate.text,
    width: Math.round(candidate.visibleBounds.width * scale.x),
    x: Math.round(candidate.visibleBounds.x * scale.x),
    y: Math.round(candidate.visibleBounds.y * scale.y),
  }));
  const hotspotMarkup = hotspots
    .map(
      (hotspot) =>
        `<button class="hotspot" data-hotspot="${hotspot.index}" type="button" aria-label="${escapeHtml(hotspot.selector)}" style="height:${hotspot.height}px;left:${hotspot.x}px;top:${hotspot.y}px;width:${hotspot.width}px"></button>`,
    )
    .join("");
  const candidateMarkup = hotspots
    .map(
      (hotspot) =>
        `<button class="candidate" data-candidate="${hotspot.index}" type="button"><span class="handle">${escapeHtml(hotspot.selector)}</span><span class="role">${escapeHtml(hotspot.role)}</span></button>`,
    )
    .join("");
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
  const status = input.readiness === "ready" ? copy.ready : copy.degraded;
  const src = escapeHtml(imageSource(image, input.imageData, input.imagePath));
  const beforeSrc = comparison
    ? escapeHtml(imageSource(comparison.beforeImage, comparison.beforeImageData))
    : undefined;
  const imageContent = comparison
    ? `<section class="comparison-images" aria-label="${escapeHtml(copy.compareImages)}">
<figure><figcaption>${escapeHtml(sideLabels[0])} · ${escapeHtml(comparison.beforeCaptureId)}</figcaption><div class="shot"><img id="before-image" draggable="false" alt="${escapeHtml(sideLabels[0])} page screenshot" src="${beforeSrc}" width="${comparison.beforeImage.width}" height="${comparison.beforeImage.height}"></div></figure>
<figure><figcaption>${escapeHtml(sideLabels[1])} · ${escapeHtml(input.captureId)} · ${escapeHtml(copy.feedbackTarget)}</figcaption><div id="image-scroll" class="shot" aria-label="${escapeHtml(copy.regionSelector)}"><div id="image-stage"><img id="evidence-image" draggable="false" alt="${escapeHtml(sideLabels[1])} page screenshot" src="${src}" width="${image.width}" height="${image.height}">${hotspotMarkup}<div id="selection"></div><div id="hotspot-label" class="hotspot-label"></div></div></div></figure>
</section>`
    : `<section id="image-scroll" class="shot single" aria-label="${escapeHtml(copy.regionSelector)}"><div id="image-stage"><img id="evidence-image" draggable="false" alt="Captured page screenshot" src="${src}" width="${image.width}" height="${image.height}">${hotspotMarkup}<div id="selection"></div><div id="hotspot-label" class="hotspot-label"></div></div></section>`;
  let title = choices ? copy.titleChoice : copy.titleFeedback;
  if (comparison) title = copy.titleComparison;
  const identity = comparison
    ? `${comparison.comparisonId} · ${comparison.status} · ${copy.notReviewed}`
    : `${input.captureId} · ${status} · ${input.capturedAt}`;
  const choiceMarkup =
    choices && choices.length > 0
      ? `<fieldset class="choices"><legend>${escapeHtml(question ?? "Choose one")}</legend>${choices
          .map(
            (option) =>
              `<label><input type="radio" name="choice" value="${escapeHtml(option)}">${escapeHtml(option)}</label>`,
          )
          .join("")}</fieldset>`
      : "";
  const hint = choices ? copy.pickHint : copy.dragHint;
  // An accept button and a choice list are two competing answers to the same panel,
  // and the bridge accepts only one of them per form. When the caller asked a
  // question, the options are the answer channel.
  const acceptLabel =
    comparison?.mode === "variant"
      ? copy.acceptSide.replace("{side}", sideLabels[1])
      : copy.accept;
  const acceptButton =
    comparison && !choices
      ? `<button id="accept" class="primary" type="button">${escapeHtml(acceptLabel)}</button>`
      : "";
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: dark light;
  --background: oklch(0.2679 0.0036 106.6427);
  --foreground: oklch(0.8074 0.0142 93.0137);
  --card: oklch(0.2679 0.0036 106.6427);
  --card-foreground: oklch(0.9818 0.0054 95.0986);
  --popover: oklch(0.3085 0.0035 106.6039);
  --popover-foreground: oklch(0.9211 0.0040 106.4781);
  --primary: oklch(0.6724 0.1308 38.7559);
  --primary-foreground: oklch(1.0000 0 0);
  --muted-foreground: oklch(0.7713 0.0169 99.0657);
  --accent: oklch(0.2130 0.0078 95.4245);
  --border: oklch(0.3618 0.0101 106.8928);
  --input: oklch(0.4336 0.0113 100.2195);
  --ring: oklch(0.6724 0.1308 38.7559);
  --destructive: oklch(0.6368 0.2078 25.3313);
  --radius: 0.5rem;
  --shadow: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10);
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (prefers-color-scheme: light) { :root {
  --background: oklch(0.9818 0.0054 95.0986);
  --foreground: oklch(0.3438 0.0269 95.7226);
  --card: oklch(0.9818 0.0054 95.0986);
  --card-foreground: oklch(0.1908 0.0020 106.5859);
  --popover: oklch(1.0000 0 0);
  --popover-foreground: oklch(0.2671 0.0196 98.9390);
  --primary: oklch(0.6171 0.1375 39.0427);
  --primary-foreground: oklch(1.0000 0 0);
  --muted-foreground: oklch(0.6059 0.0075 97.4233);
  --accent: oklch(0.9245 0.0138 92.9892);
  --border: oklch(0.8847 0.0069 97.3627);
  --input: oklch(0.7621 0.0156 98.3528);
  --ring: oklch(0.6171 0.1375 39.0427);
  --destructive: oklch(0.1908 0.0020 106.5859);
  --shadow: 0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10); } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--background); color: var(--foreground); font: 13px var(--font-mono); }
main { display: flex; flex-direction: column; gap: 12px; height: 100vh; padding: 16px; }
header, footer { display: flex; align-items: center; gap: 10px; }
header { justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
h1 { font-size: 14px; margin: 0; }
.meta, .hint { color: var(--muted-foreground); font-size: 11px; overflow-wrap: anywhere; }
/* Solid controls pair with the surface they sit on; a transparent control uses the
   foreground token, because a palette's secondary foreground can be invisible on a
   light surface. */
button, input, textarea { color: var(--card-foreground); background: var(--card); border: 1px solid var(--input); border-radius: calc(var(--radius) - 2px); font: inherit; }
button { cursor: pointer; padding: 6px 10px; }
button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.comparison-images { display: grid; flex: 1; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; min-height: 120px; }
figure { display: flex; flex-direction: column; gap: 6px; margin: 0; min-width: 0; min-height: 0; }
figcaption { color: var(--muted-foreground); font-size: 11px; }
.shot { min-height: 120px; overflow: auto; border: 1px solid var(--border); padding: 12px; }
.shot.single { flex: 1; }
#image-stage { position: relative; width: max-content; min-width: 1px; }
/* user-select only blocks text selection; -webkit-user-drag is what stops the native image drag. */
#before-image, #evidence-image { display: block; max-width: none; user-select: none; -webkit-user-drag: none; }
#selection { position: absolute; display: none; border: 2px solid var(--primary); background: color-mix(in srgb, var(--primary) 20%, transparent); pointer-events: none; }
.fields { display: grid; grid-template-columns: repeat(4, minmax(60px, 1fr)); gap: 8px; }
label { display: grid; gap: 4px; color: var(--muted-foreground); font-size: 11px; }
input { min-width: 0; padding: 6px; }
textarea { width: 100%; min-height: 64px; resize: vertical; padding: 8px; }
footer { justify-content: space-between; border-top: 1px solid var(--border); padding-top: 10px; }
.actions { display: flex; gap: 8px; }
.choices { border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); display: grid; gap: 6px; margin: 0; padding: 10px; }
.choices legend { color: var(--muted-foreground); font-size: 11px; padding: 0 4px; }
.choices label { align-items: center; color: var(--foreground); display: flex; font-size: 12px; gap: 8px; }
.hotspot { background: transparent; border: 1px dashed transparent; border-radius: 2px; cursor: crosshair; padding: 0; position: absolute; }
.hotspot:hover, .hotspot:focus-visible { background: color-mix(in srgb, var(--primary) 18%, transparent); border-color: var(--primary); }
.hotspot[aria-current="true"] { background: color-mix(in srgb, var(--primary) 26%, transparent); border-color: var(--primary); border-style: solid; }
.hotspot-label { background: var(--popover); border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); box-shadow: var(--shadow); color: var(--popover-foreground); display: none; font-size: 11px; padding: 2px 6px; pointer-events: none; position: absolute; white-space: nowrap; z-index: 2; }
.picker { border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); display: grid; gap: 4px; max-height: 150px; overflow: auto; padding: 8px; }
/* Transparent surface: the foreground token, never a palette's secondary foreground. */
.picker button { align-items: center; background: transparent; border: 0; color: var(--foreground); display: flex; font: inherit; gap: 8px; padding: 3px 4px; text-align: left; width: 100%; }
.picker button:hover, .picker button[aria-current="true"] { background: var(--accent); }
.picker .handle { font-family: var(--font-mono); overflow-wrap: anywhere; }
.picker .role { color: var(--muted-foreground); font-size: 11px; margin-left: auto; }
/* The cancel follow-up is a modal inside the panel's own window, so it can be
   dismissed without producing a second, contradictory answer. */
.scrim { align-items: center; background: color-mix(in srgb, var(--background) 70%, transparent); display: flex; inset: 0; justify-content: center; padding: 24px; position: fixed; z-index: 3; }
.scrim[hidden] { display: none; }
.dialog { background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); color: var(--popover-foreground); display: grid; gap: 10px; max-width: 460px; padding: 16px; }
.dialog h2 { font-size: 13px; margin: 0; }
.dialog p { color: var(--muted-foreground); font-size: 12px; margin: 0; }
@media (max-width: 760px) { .comparison-images { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
</style>
</head>
<body>
<main>
<header>
  <div><h1>${title}</h1><div class="meta">${escapeHtml(identity)}</div></div>
  <div class="actions" aria-label="${escapeHtml(copy.zoomControls)}"><button id="zoom-out" type="button" title="${escapeHtml(copy.zoomOut)}">A−</button><button id="zoom-reset" type="button" title="${escapeHtml(copy.resetZoom)}">⟲</button><button id="zoom-in" type="button" title="${escapeHtml(copy.zoomIn)}">A+</button></div>
</header>
<section class="meta"><div>${escapeHtml(input.pageTitle)}</div><div>${escapeHtml(input.pageUrl)}</div>${reasons ? `<ul>${reasons}</ul>` : ""}</section>
${imageContent}
${candidateMarkup ? `<section class="picker" aria-label="${escapeHtml(copy.candidateList)}">${candidateMarkup}</section>` : ""}
<section>
${choiceMarkup}
<div class="fields">
<label>X<input id="region-x" type="number" min="0" step="1" value="0"></label>
<label>Y<input id="region-y" type="number" min="0" step="1" value="0"></label>
<label>${escapeHtml(copy.width)}<input id="region-width" type="number" min="1" step="1" value="1"></label>
<label>${escapeHtml(copy.height)}<input id="region-height" type="number" min="1" step="1" value="1"></label>
</div>
<label>${escapeHtml(copy.comment)}<textarea id="feedback-comment" maxlength="2000"${choices ? "" : " autofocus"} placeholder="${escapeHtml(choices ? copy.optionalNote : copy.commentPlaceholder)}"></textarea></label>
<div id="error" class="hint" role="alert" aria-live="polite"></div>
</section>
<footer><span class="hint">${hint}</span><div class="actions"><button id="cancel" type="button">${escapeHtml(copy.cancel)}</button><button id="submit" type="button">${escapeHtml(choices ? copy.submitChoice : copy.submitFeedback)}</button>${acceptButton}</div></footer>
</main>
    <div id="cancel-dialog" class="scrim" hidden>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
        <h2 id="cancel-title">${escapeHtml(copy.cancelTitle)}</h2>
        <p>${escapeHtml(copy.cancelBody)}</p>
        <div class="actions"><button id="cancel-skip" type="button">${escapeHtml(copy.cancelSkip)}</button><button id="cancel-never" type="button">${escapeHtml(copy.cancelNever)}</button><button id="cancel-reopen" class="primary" type="button">${escapeHtml(copy.cancelReopen)}</button></div>
      </div>
    </div>
<script>
(() => {
  const image = document.getElementById("evidence-image");
  const selection = document.getElementById("selection");
  const comment = document.getElementById("feedback-comment");
  const fields = ["x", "y", "width", "height"].reduce((all, key) => { all[key] = document.getElementById("region-" + key); return all; }, {});
  const copy = ${json(copy)};
  const source = ${json({
    height: image.height,
    width: image.width,
  })};
  let zoom = 1;
  let start = null;
  let sent = false;
  const choiceMode = ${choices ? "true" : "false"};
  let regionTouched = false;
  const boxes = ${json(hotspots)};
  const label = document.getElementById("hotspot-label");
  // The image's parent is the stage that positions every overlay.
  const stage = document.getElementById("image-stage") ?? image.parentElement;
  let dragged = false;
  let pickedIndex = -1;
  const number = (key) => Number(fields[key].value);
  const region = () => ({ x: number("x"), y: number("y"), width: number("width"), height: number("height") });
  const updateSelection = () => {
    const value = region();
    selection.style.display = choiceMode && !regionTouched ? "none" : "block";
    selection.style.left = Math.min(value.x, value.x + value.width) * image.clientWidth / source.width + "px";
    selection.style.top = Math.min(value.y, value.y + value.height) * image.clientHeight / source.height + "px";
    selection.style.width = Math.abs(value.width) * image.clientWidth / source.width + "px";
    selection.style.height = Math.abs(value.height) * image.clientHeight / source.height + "px";
  };
  const sourcePoint = (event) => { const rect = image.getBoundingClientRect(); return { x: (event.clientX - rect.left) * source.width / rect.width, y: (event.clientY - rect.top) * source.height / rect.height }; };
  const send = (message) => { if (!sent) { sent = true; window.glimpse.send(message); } };
  const pickedTarget = () => (pickedIndex >= 0 && boxes[pickedIndex] ? { role: boxes[pickedIndex].role, selector: boxes[pickedIndex].selector, text: boxes[pickedIndex].text } : null);
  const markCurrent = () => {
    for (const node of document.querySelectorAll("[data-hotspot]")) node.setAttribute("aria-current", String(Number(node.dataset.hotspot) === pickedIndex));
    for (const node of document.querySelectorAll("[data-candidate]")) node.setAttribute("aria-current", String(Number(node.dataset.candidate) === pickedIndex));
  };
  const pick = (index) => {
    const box = boxes[index];
    if (!box) return;
    pickedIndex = index;
    regionTouched = true;
    fields.x.value = String(box.x);
    fields.y.value = String(box.y);
    fields.width.value = String(box.width);
    fields.height.value = String(box.height);
    markCurrent();
    updateSelection();
  };
  const clearPick = () => {
    if (pickedIndex < 0) return;
    pickedIndex = -1;
    markCurrent();
  };
  const showLabel = (index) => {
    const box = boxes[index];
    if (!box || !label) return;
    label.textContent = box.selector + " · " + box.role;
    label.style.display = "block";
    label.style.left = box.x + "px";
    label.style.top = Math.max(0, box.y - 20) + "px";
  };
  const hideLabel = () => { if (label) label.style.display = "none"; };
  // The stage owns the drag, not the image: the hotspot layer sits above the image, so a
  // press that starts on a hotspot must still be able to draw a region.
  stage.addEventListener("pointerdown", (event) => { event.preventDefault(); dragged = false; start = sourcePoint(event); stage.setPointerCapture(event.pointerId); });
  // Belt and braces: the attribute and the CSS rule are the other two guards, and the
  // dragstart handler still holds if the stylesheet is ever regenerated without them.
  image.addEventListener("dragstart", (event) => event.preventDefault());
  stage.addEventListener("pointermove", (event) => { if (!start) return; const end = sourcePoint(event); dragged = true; regionTouched = true; clearPick(); fields.x.value = String(Math.round(Math.min(start.x, end.x))); fields.y.value = String(Math.round(Math.min(start.y, end.y))); fields.width.value = String(Math.round(Math.abs(end.x - start.x))); fields.height.value = String(Math.round(Math.abs(end.y - start.y))); updateSelection(); });
  // A press that does not move is a pick, not a drag, and it has to be resolved here:
  // the stage captures the pointer on pointerdown, and a captured pointer retargets
  // the click event to the capturing element — so the hotspot's own click listener never fires.
  stage.addEventListener("pointerup", (event) => { const began = start; start = null; if (!began) return; const end = sourcePoint(event); if (Math.abs(end.x - began.x) > 4 || Math.abs(end.y - began.y) > 4) return; const node = document.elementFromPoint(event.clientX, event.clientY); const hotspot = node && node.closest ? node.closest("[data-hotspot]") : null; if (hotspot) pick(Number(hotspot.dataset.hotspot)); });
  for (const node of document.querySelectorAll("[data-hotspot]")) {
    node.addEventListener("pointerenter", () => showLabel(Number(node.dataset.hotspot)));
    node.addEventListener("pointerleave", hideLabel);
    node.addEventListener("focus", () => showLabel(Number(node.dataset.hotspot)));
    node.addEventListener("blur", hideLabel);
    node.addEventListener("click", () => { if (!dragged) pick(Number(node.dataset.hotspot)); });
  }
  const candidateNodes = Array.from(document.querySelectorAll("[data-candidate]"));
  for (const node of candidateNodes) {
    node.addEventListener("click", () => pick(Number(node.dataset.candidate)));
    node.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = candidateNodes[Math.max(0, Math.min(candidateNodes.length - 1, candidateNodes.indexOf(node) + step))];
      if (next) { pick(Number(next.dataset.candidate)); next.focus(); }
    });
  }
  Object.values(fields).forEach((field) => field.addEventListener("input", () => { regionTouched = true; updateSelection(); }));
  document.getElementById("zoom-out").addEventListener("click", () => { zoom = Math.max(0.8, zoom - 0.1); document.body.style.zoom = zoom; });
  document.getElementById("zoom-reset").addEventListener("click", () => { zoom = 1; document.body.style.zoom = zoom; });
  document.getElementById("zoom-in").addEventListener("click", () => { zoom = Math.min(1.5, zoom + 0.1); document.body.style.zoom = zoom; });
  const error = document.getElementById("error");
  const fail = (message) => { error.textContent = message; comment.focus(); };
  const submit = () => {
    try {
      if (choiceMode) {
        const picked = document.querySelector('input[name="choice"]:checked');
        if (!picked) throw new Error(copy.errorPick);
        const answer = { type: "choice", choice: picked.value };
        const identity = pickedTarget();
        if (identity) { answer.source = "pick"; answer.target = identity; }
        if (regionTouched) answer.region = region();
        if (comment.value.trim()) answer.comment = comment.value;
        send(answer);
        return;
      }
      const value = region();
      if (!comment.value.trim()) throw new Error(copy.errorComment);
      if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) throw new Error(copy.errorCoordinates);
      if (value.width <= 0 || value.height <= 0) throw new Error(copy.errorPositive);
      if (value.x < 0 || value.y < 0 || value.x + value.width > source.width || value.y + value.height > source.height) throw new Error(copy.errorInside);
      const pickedIdentity = pickedTarget();
      send({ type: "submit", comment: comment.value, region: value, source: pickedIdentity ? "pick" : "drag", ...(pickedIdentity ? { target: pickedIdentity } : {}) });
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : copy.errorFix);
    }
  };
  // Cancelling settles the status first; the follow-up only asks what to do next, and
  // answering it is still one cancel message carrying that answer.
  const dialog = document.getElementById("cancel-dialog");
  const openCancel = () => { dialog.hidden = false; document.getElementById("cancel-reopen").focus(); };
  const closeCancel = () => { dialog.hidden = true; };
  const answerCancel = (reopenRequested, suppressForRound) => send({ type: "cancel", reopenRequested, suppressForRound });
  document.getElementById("cancel").addEventListener("click", openCancel);
  document.getElementById("cancel-reopen").addEventListener("click", () => answerCancel(true, false));
  document.getElementById("cancel-skip").addEventListener("click", () => answerCancel(false, false));
  document.getElementById("cancel-never").addEventListener("click", () => answerCancel(false, true));
  document.getElementById("submit").addEventListener("click", submit);
  ${comparison ? 'document.getElementById("accept").addEventListener("click", () => send({ type: "accept" }));' : ""}
  // Esc on the follow-up closes only the follow-up: the panel stays open and unsubmitted,
  // and answering it later is still one cancel message.
  document.addEventListener("keydown", (event) => { if (!dialog.hidden) { if (event.key === "Escape") { event.preventDefault(); closeCancel(); } return; } if (event.key === "Escape") { event.preventDefault(); openCancel(); } else if (event.key === "Enter" && event.target !== comment) { event.preventDefault(); submit(); } });
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
