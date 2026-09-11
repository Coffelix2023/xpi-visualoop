import { writeFile } from "node:fs/promises";
import type { CdpClient } from "./cdp.ts";
import { CdpDiagnostics, type CdpDiagnosticsResult } from "./cdp-diagnostics.ts";
import { validateLocalPageUrl } from "./config.ts";

const READINESS_TIMEOUT_MS = 5_000;
const READINESS_POLL_MS = 100;
const NAVIGATION_TIMEOUT_MS = 5_000;
/** Max exported edge in device pixels for any screenshot (legacy backend budget). */
const MAX_EXPORT_EDGE = 2000;
/** Keep a clamp scale strictly below the boundary so the output edge never rounds above it. */
const SCALE_EPSILON = 0.999;

export interface CdpPageInfo {
  h: number;
  ph: number;
  pw: number;
  sx: number;
  sy: number;
  title: string;
  url: string;
  w: number;
}

export interface CdpRegion {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface CdpTargetInfo {
  accessibility: Record<string, string>;
  bounds: CdpRegion;
  /** Same rectangle in page document coordinates; clip uses this one. */
  documentBounds: CdpRegion;
  selector: string;
  styles: Record<string, string>;
  text?: string;
  visibleBounds: CdpRegion;
}

export interface CdpPrepareResult {
  dpr: number;
  page: CdpPageInfo;
  targetId: string;
}

export interface CdpCaptureResult {
  diagnostics: CdpDiagnosticsResult;
  dpr: number;
  endedAt: string;
  image: {
    byteLength: number;
    crop?: {
      byteLength: number;
      height: number;
      path: string;
      sourceRegion: CdpRegion;
      width: number;
      x: number;
      y: number;
    };
    height: number;
    path: string;
    rawHeight: number;
    rawWidth: number;
    /** Document rectangle covered by the viewport shot. */
    sourceRegion: CdpRegion;
    width: number;
  };
  pageAfter: CdpPageInfo;
  pageBefore: CdpPageInfo;
  readiness: {
    reasons: string[];
    status: "degraded" | "ready";
  };
  startedAt: string;
  target?: CdpTargetInfo;
  targetId: string;
}

export interface CdpPrepareRequest {
  dpr: number;
  url: string;
  viewport: {
    height: number;
    width: number;
  };
}

export interface CdpCaptureRequest {
  allowTargetFailure?: boolean;
  imagePath: string;
  selector?: string;
  /** When set alongside a selector, the target region is captured here. */
  targetImagePath?: string;
}

export class OwnedTargets {
  /** Console and network observation for the page this session owns. */
  readonly diagnostics = new CdpDiagnostics();
  private readonly sessions = new Map<string, string>();

  add(targetId: string, sessionId: string): void {
    this.sessions.set(targetId, sessionId);
  }

  session(targetId: string): string | undefined {
    return this.sessions.get(targetId);
  }

  delete(targetId: string): void {
    this.sessions.delete(targetId);
  }
  first(): string | undefined {
    return [
      ...this.sessions.keys(),
    ][0];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} is invalid`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is invalid`);
  return value;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string"))
    throw new Error(`${name} is invalid`);
  return value as Record<string, string>;
}

function region(value: unknown, name: string): CdpRegion {
  if (!isRecord(value)) throw new Error(`${name} is invalid`);
  return {
    height: finite(value.height, `${name}.height`),
    width: finite(value.width, `${name}.width`),
    x: finite(value.x, `${name}.x`),
    y: finite(value.y, `${name}.y`),
  };
}

function pngSize(buffer: Buffer): {
  height: number;
  width: number;
} {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (buffer.length < 24 || signature !== "89504e470d0a1a0a")
    throw new Error("browser screenshot is not a PNG image");
  return {
    height: buffer.readUInt32BE(20),
    width: buffer.readUInt32BE(16),
  };
}

function cancelledError(): Error {
  return new Error("visual loop operation cancelled");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    signal?.addEventListener("abort", onAbort, {
      once: true,
    });
  });
}

async function evaluate(
  client: CdpClient,
  sessionId: string,
  expression: string,
): Promise<unknown> {
  const payload = await client.send(
    "Runtime.evaluate",
    {
      awaitPromise: true,
      expression,
      returnByValue: true,
    },
    sessionId,
  );
  if (!isRecord(payload)) throw new Error("page evaluation returned an invalid result");
  if (payload.exceptionDetails !== undefined)
    throw new Error(
      `page evaluation failed: ${
        isRecord(payload.exceptionDetails) &&
        typeof payload.exceptionDetails.text === "string"
          ? payload.exceptionDetails.text
          : "unknown error"
      }`,
    );
  if (!isRecord(payload.result)) throw new Error("page evaluation returned no value");
  return payload.result.value;
}

async function pageInfo(client: CdpClient, sessionId: string): Promise<CdpPageInfo> {
  const value = await evaluate(
    client,
    sessionId,
    `({h: innerHeight, ph: document.documentElement.scrollHeight, pw: document.documentElement.scrollWidth, sx: scrollX, sy: scrollY, title: document.title, url: location.href, w: innerWidth})`,
  );
  if (!isRecord(value)) throw new Error("page information is invalid");
  return {
    h: finite(value.h, "page.h"),
    ph: finite(value.ph, "page.ph"),
    pw: finite(value.pw, "page.pw"),
    sx: finite(value.sx, "page.sx"),
    sy: finite(value.sy, "page.sy"),
    title: typeof value.title === "string" ? value.title : "",
    url: text(value.url, "page.url"),
    w: finite(value.w, "page.w"),
  };
}

function targetScript(selector: string): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  const nodes = Array.from(document.querySelectorAll(selector));
  if (nodes.length !== 1) return {error: nodes.length === 0 ? "no-match" : "multiple-matches"};
  const element = nodes[0], rect = element.getBoundingClientRect();
  const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  if (right <= x || bottom <= y) return {error: "outside-viewport"};
  const computed = getComputedStyle(element), styles = {};
  for (const key of ["display", "position", "width", "height", "margin", "padding", "gap", "fontFamily", "fontSize", "fontWeight", "lineHeight", "color", "backgroundColor", "border", "borderRadius", "overflow"]) styles[key] = computed[key];
  return {accessibility: {role: element.getAttribute("role") || "", label: element.getAttribute("aria-label") || "", description: element.getAttribute("aria-description") || ""}, bounds: {x: rect.left, y: rect.top, width: rect.width, height: rect.height}, documentBounds: {x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height}, selector, text: (element.innerText || element.textContent || "").slice(0, 2000), styles, visibleBounds: {x, y, width: right - x, height: bottom - y}};
})()`;
}

function boundsScript(selector: string): string {
  return `(() => {
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  if (nodes.length !== 1) return null;
  const rect = nodes[0].getBoundingClientRect();
  return {documentBounds: {x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height}};
})()`;
}

async function resolveTarget(
  client: CdpClient,
  sessionId: string,
  selector: string,
): Promise<
  | {
      error: string;
    }
  | CdpTargetInfo
> {
  const value = await evaluate(client, sessionId, targetScript(selector));
  if (!isRecord(value)) throw new Error("target resolution is invalid");
  if (value.error !== undefined)
    return {
      error: text(value.error, "target.error"),
    };
  return {
    accessibility: stringRecord(value.accessibility, "target.accessibility"),
    bounds: region(value.bounds, "target.bounds"),
    documentBounds: region(value.documentBounds, "target.documentBounds"),
    selector: text(value.selector, "target.selector"),
    styles: stringRecord(value.styles, "target.styles"),
    ...(typeof value.text === "string"
      ? {
          text: value.text,
        }
      : {}),
    visibleBounds: region(value.visibleBounds, "target.visibleBounds"),
  };
}

async function waitForReadiness(
  client: CdpClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const reasons: string[] = [];
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  for (;;) {
    throwIfAborted(signal);
    const value = await evaluate(
      client,
      sessionId,
      `({fonts: document.fonts ? document.fonts.status === "loaded" : true, images: Array.from(document.images).filter((image) => { const rect = image.getBoundingClientRect(); return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth; }).every((image) => image.complete && image.naturalWidth > 0), readyState: document.readyState})`,
    );
    if (!isRecord(value)) throw new Error("page readiness is invalid");
    const complete = value.readyState === "complete";
    const fonts = value.fonts === true;
    const images = value.images === true;
    if (complete && fonts && images) return reasons;
    if (Date.now() >= deadline) {
      if (!complete) reasons.push("document not complete");
      if (!fonts) reasons.push("fonts not ready");
      if (!images) reasons.push("visible images not ready");
      return reasons;
    }
    await sleep(READINESS_POLL_MS, signal);
  }
}

async function assertionOwnership(
  client: CdpClient,
  owned: OwnedTargets,
  targetId: string,
): Promise<string> {
  const sessionId = owned.session(targetId);
  if (sessionId === undefined)
    throw new Error("refusing to act on a target this session does not own");
  let info: unknown;
  try {
    info = await client.send("Target.getTargetInfo", {
      targetId,
    });
  } catch {
    throw new Error(
      "the owned browser target is no longer available; prepare the page again",
    );
  }
  if (
    !isRecord(info) ||
    !isRecord(info.targetInfo) ||
    info.targetInfo.targetId !== targetId
  )
    throw new Error(
      "the owned browser target is no longer available; prepare the page again",
    );
  return sessionId;
}

export async function openOwnedTarget(
  client: CdpClient,
  owned: OwnedTargets,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const created = await client.send("Target.createTarget", {
    background: true,
    url: "about:blank",
  });
  if (!isRecord(created) || typeof created.targetId !== "string")
    throw new Error("browser did not return a created target");
  const targetId = created.targetId;
  owned.add(targetId, "");
  try {
    const attached = await client.send("Target.attachToTarget", {
      flatten: true,
      targetId,
    });
    if (!isRecord(attached) || typeof attached.sessionId !== "string")
      throw new Error("browser did not return an attached session");
    owned.add(targetId, attached.sessionId);
    return targetId;
  } catch (error) {
    owned.delete(targetId);
    await client
      .send("Target.closeTarget", {
        targetId,
      })
      .catch(() => undefined);
    throw error;
  }
}

export async function closeOwnedTarget(
  client: CdpClient,
  owned: OwnedTargets,
  targetId: string,
  expectedUrl: string,
): Promise<void> {
  const sessionId = await assertionOwnership(client, owned, targetId);
  const value = await evaluate(client, sessionId, "location.href");
  if (value !== expectedUrl)
    throw new Error("owned target URL changed; refusing to close it");
  await dropOwnedTarget(client, owned, targetId, sessionId);
}

/**
 * Closes a target this session opened without the URL guard. Shutdown uses it
 * because refusing to close would leak the page, and the ownership table is
 * the only claim being acted on: other tabs are never in it.
 */
export async function dropOwnedTarget(
  client: CdpClient,
  owned: OwnedTargets,
  targetId: string,
  sessionId: string,
): Promise<void> {
  await client
    .send("Target.closeTarget", {
      targetId,
    })
    .catch(() => undefined);
  owned.delete(targetId);
  owned.diagnostics.detach();
  await client
    .send("Target.detachFromTarget", {
      sessionId,
    })
    .catch(() => undefined);
}

export async function prepareOwnedPage(
  client: CdpClient,
  owned: OwnedTargets,
  request: CdpPrepareRequest,
  signal?: AbortSignal,
): Promise<CdpPrepareResult> {
  const url = validateLocalPageUrl(request.url);
  throwIfAborted(signal);
  const existing = owned.first();
  const targetId = existing ?? (await openOwnedTarget(client, owned, signal));
  if (existing !== undefined) await assertionOwnership(client, owned, existing);
  const sessionId = owned.session(targetId);
  if (sessionId === undefined || sessionId === "")
    throw new Error("owned target session is unavailable");
  // Only a fresh target needs new observers; re-enabling on the same session
  // would restart the observation window mid-inspection without gaining events.
  if (existing === undefined) await owned.diagnostics.attach(client, sessionId);
  await client.send(
    "Emulation.setDeviceMetricsOverride",
    {
      deviceScaleFactor: request.dpr,
      height: request.viewport.height,
      mobile: false,
      width: request.viewport.width,
    },
    sessionId,
  );
  await client.send(
    "Page.navigate",
    {
      url,
    },
    sessionId,
  );
  const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
  for (;;) {
    throwIfAborted(signal);
    const state = await evaluate(client, sessionId, "document.readyState");
    if (state === "complete") break;
    if (Date.now() >= deadline) break;
    await sleep(READINESS_POLL_MS, signal);
  }
  const page = await pageInfo(client, sessionId);
  validateLocalPageUrl(page.url);
  const dpr = finite(
    await evaluate(client, sessionId, "window.devicePixelRatio"),
    "dpr",
  );
  return {
    dpr,
    page,
    targetId,
  };
}

function regionScale(region: CdpRegion, dpr: number): number {
  const edge = Math.max(region.width, region.height) * dpr;
  if (edge <= MAX_EXPORT_EDGE) return 1;
  // A scale below 1 narrows the export size only; the pixel-to-page mapping is not
  // linear under scaling, so scaled shots must not feed coordinate verification.
  return Math.min(1, (MAX_EXPORT_EDGE / edge) * SCALE_EPSILON);
}

function pageRect(page: CdpPageInfo): CdpRegion {
  // The document rectangle the viewport shot covers. Chrome clamps a clip to the
  // document, so near the right or bottom edge the covered rectangle is smaller
  // than the viewport; the legacy crop path needs the covered one.
  return {
    height: Math.max(0, Math.min(page.h, page.ph - page.sy)),
    width: Math.max(0, Math.min(page.w, page.pw - page.sx)),
    x: page.sx,
    y: page.sy,
  };
}

async function captureImage(
  client: CdpClient,
  sessionId: string,
  options: {
    clip?: CdpRegion;
    scale?: number;
  } = {},
): Promise<{
  data: string;
}> {
  const { clip, scale = 1 } = options;
  const shot = await client.send(
    "Page.captureScreenshot",
    clip === undefined
      ? {
          format: "png",
        }
      : {
          // Without this the region returns blank pixels outside the viewport
          // while still reporting a correct size, which reads as a silent pass.
          captureBeyondViewport: true,
          format: "png",
          clip: {
            height: clip.height,
            scale,
            width: clip.width,
            x: clip.x,
            y: clip.y,
          },
        },
    sessionId,
  );
  if (!isRecord(shot) || typeof shot.data !== "string")
    throw new Error("browser did not return a screenshot");
  return {
    data: shot.data,
  };
}

export async function captureOwnedPage(
  client: CdpClient,
  owned: OwnedTargets,
  targetId: string,
  request: CdpCaptureRequest,
  signal?: AbortSignal,
): Promise<CdpCaptureResult> {
  const sessionId = await assertionOwnership(client, owned, targetId);
  throwIfAborted(signal);
  const startedAt = new Date().toISOString();
  const pageBefore = await pageInfo(client, sessionId);
  const dpr = finite(
    await evaluate(client, sessionId, "window.devicePixelRatio"),
    "dpr",
  );
  const reasons = await waitForReadiness(client, sessionId, signal);
  let target: CdpTargetInfo | undefined;
  if (request.selector !== undefined) {
    const resolved = await resolveTarget(client, sessionId, request.selector);
    if ("error" in resolved) {
      if (!request.allowTargetFailure)
        throw new Error(`target resolution failed: ${resolved.error}`);
      reasons.push(`target resolution failed: ${resolved.error}`);
    } else {
      target = resolved;
    }
  }
  const shot = await captureImage(client, sessionId);
  const bytes = Buffer.from(shot.data, "base64");
  // A region capture must stay inside the shot's own clipping rectangle, so it
  // re-samples the element rather than cropping the viewport image afterwards.
  let crop: CdpCaptureResult["image"]["crop"];
  if (target !== undefined && request.targetImagePath !== undefined) {
    const regionShot = await captureImage(client, sessionId, {
      clip: target.documentBounds,
      scale: regionScale(target.documentBounds, dpr),
    });
    const regionBytes = Buffer.from(regionShot.data, "base64");
    await writeFile(request.targetImagePath, regionBytes);
    const regionSize = pngSize(regionBytes);
    crop = {
      byteLength: regionBytes.byteLength,
      height: regionSize.height,
      path: request.targetImagePath,
      sourceRegion: target.documentBounds,
      width: regionSize.width,
      x: 0,
      y: 0,
    };
  }
  await writeFile(request.imagePath, bytes);
  const pageAfter = await pageInfo(client, sessionId);
  // Close the observation window at the same instant the capture's own
  // stability readings start, so diagnostics never claim to cover them.
  const diagnostics = owned.diagnostics.summarize(new Date().toISOString());
  if (pageBefore.url !== pageAfter.url) reasons.push("page URL changed during capture");
  if (pageBefore.sx !== pageAfter.sx || pageBefore.sy !== pageAfter.sy)
    reasons.push("scroll changed during capture");
  if (request.selector !== undefined) {
    const before = target?.documentBounds;
    const after = await evaluate(client, sessionId, boundsScript(request.selector));
    const moved =
      before === undefined
        ? after !== null
        : !isRecord(after) ||
          (() => {
            const now = region(after.documentBounds, "bounds.documentBounds");
            return (
              now.x !== before.x ||
              now.y !== before.y ||
              now.width !== before.width ||
              now.height !== before.height
            );
          })();
    if (moved) reasons.push("target bounds changed during capture");
  }
  const size = pngSize(bytes);
  return {
    diagnostics,
    dpr,
    endedAt: new Date().toISOString(),
    image: {
      byteLength: bytes.byteLength,
      ...(crop === undefined
        ? {}
        : {
            crop,
          }),
      height: size.height,
      path: request.imagePath,
      rawHeight: size.height,
      rawWidth: size.width,
      sourceRegion: pageRect(pageBefore),
      width: size.width,
    },
    pageAfter,
    pageBefore,
    readiness: {
      reasons,
      status: reasons.length === 0 ? "ready" : "degraded",
    },
    startedAt,
    ...(target
      ? {
          target,
        }
      : {}),
    targetId,
  };
}
