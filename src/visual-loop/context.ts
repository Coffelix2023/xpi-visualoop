import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CdpClient } from "./cdp.ts";
import {
  type CdpPageInfo,
  type CdpPrepareResult,
  captureOwnedPage,
  dropOwnedTarget,
  type OwnedTargets,
  OwnedTargets as OwnedTargetsClass,
  prepareOwnedPage,
} from "./cdp-actions.ts";
import {
  type LaunchForm,
  minimizeOwnedWindow,
  ownsEndpoint,
  type WindowState,
} from "./chrome.ts";
import {
  loadConfig,
  type VisualLoopConfig,
  validateEndpointReachability,
  validateLocalPageUrl,
} from "./config.ts";
import {
  type Capture,
  type Comparison,
  commonViewportRegion,
  compareCaptureConditions,
  EvidenceStore,
  type Feedback,
  type FeedbackTarget,
  type ImageArtifact,
  type Region,
  summarizeTargetChanges,
} from "./evidence.ts";

export interface Viewport {
  height: number;
  width: number;
}

export interface PrepareInput {
  dpr?: number;
  stateLabel?: string;
  url: string;
  viewport?: Viewport;
}

export interface CaptureInput {
  allowTargetFailure?: boolean;
  selector?: string;
  stateLabel?: string;
}
export interface VerifyInput {
  stateLabel?: string;
}
export interface InspectionContextStatus {
  cdpUrl?: string;
  inspectionId?: string;
  pageUrl?: string;
  state: "disconnected" | "ready" | "busy";
  targetId?: string;
  windowState?: WindowState;
}

interface ActiveInspection {
  abortControllers: Set<AbortController>;
  busy: boolean;
  cdp: CdpClient;
  config: VisualLoopConfig;
  /** Pages this session opened; only these are closed on release. */
  createdTargets: string[];
  evidence: EvidenceStore;
  /** Session-owned evidence directory, removed on release. */
  evidenceDir: string;
  feedbackCancel?: () => void;
  /** "Don't ask again this round"; bounds of the round are this inspection. */
  feedbackSuppressed: boolean;
  inspectionId: string;
  lockHandle: Awaited<ReturnType<typeof open>>;
  lockPath: string;
  owned: OwnedTargets;
  page?: CdpPageInfo;
  queue: Promise<void>;
  stateLabel?: string;
  targetId: string;
  /**
   * Decided once per inspection: a second prepare must not pull a window the
   * user brought forward back out from under them.
   */
  windowState?: WindowState;
}

const DEFAULT_DPR = 1;
const DEFAULT_VIEWPORT: Viewport = {
  height: 900,
  width: 1440,
};
/** Raw exported-edge budget in device pixels; every output screenshot must stay within it. */
export const MAX_EXPORT_EDGE = 2000;
/** Largest CSS pixel edge a viewport may have at DPR 1 (MAX_EXPORT_EDGE / 1). */
const MAX_VIEWPORT_EDGE = MAX_EXPORT_EDGE;
/** Layout caps for prepare; the per-request effective cap divides by the DPR. */
const MAX_DPR = 2;
const MAX_HEIGHT = MAX_VIEWPORT_EDGE;
const MAX_WIDTH = MAX_VIEWPORT_EDGE;
const MIN_HEIGHT = 240;
const MIN_WIDTH = 320;
const LOCK_DIR = join(tmpdir(), "xpi-visualoop-locks");

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function endpointLockPath(cdpUrl: string): string {
  const digest = createHash("sha256").update(cdpUrl).digest("hex").slice(0, 32);
  return join(LOCK_DIR, `${digest}.lock`);
}

function lockOwnerIsGone(text: string): boolean {
  let owner: unknown;
  try {
    owner = JSON.parse(text);
  } catch {
    return true;
  }
  if (typeof owner !== "object" || owner === null) return true;
  const { pid } = owner as {
    pid?: unknown;
  };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function endpointOwnedError(): Error {
  return new Error(
    "configured CDP endpoint is already owned by another xpi-visualoop process",
  );
}

async function claimEndpointLock(
  lockPath: string,
): Promise<Awaited<ReturnType<typeof open>> | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return undefined;
  }
  await handle.writeFile(
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  return handle;
}

export async function acquireEndpointLock(
  lockPath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  const claimed = await claimEndpointLock(lockPath);
  if (claimed) return claimed;
  let owner = "";
  try {
    owner = await readFile(lockPath, "utf8");
  } catch {
    // Lock vanished between open and read; claim once more below.
  }
  if (!lockOwnerIsGone(owner)) throw endpointOwnedError();
  await rm(lockPath, {
    force: true,
  });
  const preempted = await claimEndpointLock(lockPath);
  if (preempted) return preempted;
  throw endpointOwnedError();
}

function assertFiniteRange(
  value: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function normalizePrepareInput(
  input: PrepareInput,
): Required<Pick<PrepareInput, "dpr" | "url" | "viewport">> &
  Pick<PrepareInput, "stateLabel"> {
  const url = validateLocalPageUrl(input.url);
  const viewport = input.viewport ?? DEFAULT_VIEWPORT;
  const dpr = assertFiniteRange(input.dpr ?? DEFAULT_DPR, 1, MAX_DPR, "dpr");
  // The exported-edge budget is in device pixels, so the CSS-pixel viewport cap
  // tightens as the DPR grows (DPR 2 -> 1000x1000).
  const maxViewportEdge = MAX_VIEWPORT_EDGE / dpr;
  const width = assertFiniteRange(
    viewport.width,
    MIN_WIDTH,
    maxViewportEdge,
    "viewport.width",
  );
  const height = assertFiniteRange(
    viewport.height,
    MIN_HEIGHT,
    maxViewportEdge,
    "viewport.height",
  );
  if (
    input.stateLabel !== undefined &&
    (input.stateLabel.length === 0 || input.stateLabel.length > 120)
  ) {
    throw new Error("stateLabel must contain 1 to 120 characters");
  }
  return {
    dpr,
    stateLabel: input.stateLabel,
    url,
    viewport: {
      height,
      width,
    },
  };
}

function normalizeCaptureInput(input: CaptureInput): CaptureInput {
  if (
    input.selector !== undefined &&
    (input.selector.length === 0 || input.selector.length > 2048)
  )
    throw new Error("selector must contain 1 to 2048 characters");
  if (
    input.stateLabel !== undefined &&
    (input.stateLabel.length === 0 || input.stateLabel.length > 120)
  ) {
    throw new Error("stateLabel must contain 1 to 120 characters");
  }
  return input;
}

function capturePage(page: CdpPageInfo): Capture["page"] {
  return {
    height: page.ph,
    scrollX: page.sx,
    scrollY: page.sy,
    title: page.title,
    url: validateLocalPageUrl(page.url),
    width: page.pw,
  };
}

async function imageArtifact(
  value: {
    height: number;
    path: string;
    width: number;
  },
  sourceRegion: Capture["image"]["sourceRegion"],
): Promise<ImageArtifact> {
  const file = await stat(value.path);
  return {
    byteLength: file.size,
    height: value.height,
    path: value.path,
    coordinateScale: {
      x: value.width / sourceRegion.width,
      y: value.height / sourceRegion.height,
    },
    sourceRegion,
    width: value.width,
  };
}

/**
 * Common-region artifact for verify. The viewport image already covers the
 * whole viewport, so the region artifact is a byte-for-byte copy of it; the
 * recorded source region comes straight from the capture.
 */
async function createComparisonArtifact(
  capture: Capture,
  outputPath: string,
): Promise<ImageArtifact> {
  await copyFile(capture.image.path, outputPath);
  return imageArtifact(
    {
      height: capture.image.height,
      path: outputPath,
      width: capture.image.width,
    },
    capture.image.sourceRegion,
  );
}

export class VisualLoopManager {
  private active?: ActiveInspection;
  private epoch = 0;
  private readonly startedBrowser: (cdpUrl: string) => boolean;

  /**
   * `startedBrowser` answers whether this process launched the browser behind
   * an endpoint. Production reads the launcher; tests inject it because a
   * fixture endpoint was never spawned by this module.
   */
  constructor(startedBrowser: (cdpUrl: string) => boolean = ownsEndpoint) {
    this.startedBrowser = startedBrowser;
  }

  async prepare(
    ctx: ExtensionContext,
    input: PrepareInput,
    operationSignal?: AbortSignal,
  ): Promise<{
    epoch: number;
    result: CdpPrepareResult;
    stateLabel?: string;
    windowState: WindowState;
    launch: LaunchForm;
  }> {
    const request = normalizePrepareInput(input);
    const signal = operationSignal ?? ctx.signal;
    const configResult = await this.configFor(ctx);
    if (!configResult.config) throw new Error(configResult.diagnostics.join("; "));
    const config = configResult.config;
    if (this.active && this.active.config.cdpUrl !== config.cdpUrl) {
      await this.disconnect();
    }
    if (!this.active) await this.connect(config, signal);
    const active = this.active;
    if (!active) throw new Error("visual loop context was not created");
    const epoch = this.epoch;
    return this.serial(active, signal, async (operationSignal) => {
      if (epoch !== this.epoch || this.active !== active)
        throw new Error("visual loop session changed");
      await validateEndpointReachability(config.cdpUrl, config.launch, operationSignal);
      const hadTarget = active.targetId !== "";
      const result = await prepareOwnedPage(
        active.cdp,
        active.owned,
        {
          dpr: request.dpr,
          url: request.url,
          viewport: request.viewport,
        },
        operationSignal,
      );
      if (!hadTarget) active.createdTargets.push(result.targetId);
      validateLocalPageUrl(result.page.url);
      if (epoch !== this.epoch || this.active !== active)
        throw new Error("visual loop session changed");
      active.targetId = result.targetId;
      active.page = result.page;
      active.stateLabel = request.stateLabel;
      const windowState = await this.quietWindow(active, result.targetId);
      active.windowState = windowState;
      return {
        epoch,
        result,
        stateLabel: request.stateLabel,
        windowState,
        launch: active.config.launch,
      };
    });
  }

  /**
   * Put the window into the configured form once. Only a browser this process
   * started is moved: an endpoint somebody else started keeps its window, and
   * a form that never minimizes has no window state to report.
   */
  private async quietWindow(
    active: ActiveInspection,
    targetId: string,
  ): Promise<WindowState> {
    const decided = active.windowState;
    if (decided !== undefined) return decided;
    if (active.config.launch !== "minimized") return "unknown";
    if (!this.startedBrowser(active.config.cdpUrl)) return "unknown";
    return minimizeOwnedWindow(active.cdp, targetId);
  }

  async capture(
    ctx: ExtensionContext,
    input: CaptureInput,
    operationSignal?: AbortSignal,
  ): Promise<Capture> {
    const request = normalizeCaptureInput(input);
    const signal = operationSignal ?? ctx.signal;
    const active = this.active;
    if (!active?.page || !active.targetId)
      throw new Error("visual loop is not prepared");
    const preparedPage = active.page;
    const epoch = this.epoch;
    return this.serial(active, signal, async (captureSignal) => {
      if (epoch !== this.epoch || this.active !== active)
        throw new Error("visual loop session changed");
      await validateEndpointReachability(
        active.config.cdpUrl,
        active.config.launch,
        captureSignal,
      );
      const captureId = id("capture");
      const imagePath = join(active.evidenceDir, `${captureId}.png`);
      const targetImagePath = join(active.evidenceDir, `${captureId}.target.png`);
      const result = await captureOwnedPage(
        active.cdp,
        active.owned,
        active.targetId,
        {
          ...(request.allowTargetFailure === undefined
            ? {}
            : {
                allowTargetFailure: request.allowTargetFailure,
              }),
          imagePath,
          ...(request.selector === undefined
            ? {}
            : {
                selector: request.selector,
              }),
          targetImagePath,
        },
        captureSignal,
      );
      if (result.targetId !== active.targetId)
        throw new Error("bound target changed during capture");
      validateLocalPageUrl(result.pageBefore.url);
      validateLocalPageUrl(result.pageAfter.url);
      const page = capturePage(result.pageAfter);
      const viewport = {
        height: assertFiniteRange(
          result.pageAfter.h,
          1,
          MAX_HEIGHT,
          "capture viewport height",
        ),
        width: assertFiniteRange(
          result.pageAfter.w,
          1,
          MAX_WIDTH,
          "capture viewport width",
        ),
      };
      const capture: Capture = {
        captureId,
        diagnostics: result.diagnostics,
        dpr: result.dpr,
        endedAt: result.endedAt,
        inspectionId: active.inspectionId,
        image: {
          ...(result.image.crop
            ? {
                crop: await imageArtifact(
                  result.image.crop,
                  result.image.crop.sourceRegion,
                ),
              }
            : {}),
          ...(await imageArtifact(result.image, result.image.sourceRegion)),
          raw: {
            byteLength: 0,
            height: result.image.rawHeight,
            width: result.image.rawWidth,
          },
        },
        page,
        candidates: result.candidates,
        readiness:
          result.pageBefore.url === preparedPage.url
            ? result.readiness
            : {
                status: "degraded",
                reasons: [
                  ...result.readiness.reasons,
                  "page URL differs from prepared page",
                ],
              },
        sessionEpoch: epoch,
        startedAt: result.startedAt,
        stateLabel: request.stateLabel ?? active.stateLabel,
        target: result.target,
        targetId: result.targetId,
        viewport,
      };
      if (epoch !== this.epoch || this.active !== active)
        throw new Error("visual loop session changed");
      return active.evidence.addCapture(capture);
    });
  }

  async verify(
    ctx: ExtensionContext,
    baselineCaptureId: string,
    input: VerifyInput = {},
    operationSignal?: AbortSignal,
  ): Promise<{
    after?: Capture;
    before: Capture;
    comparison: Comparison;
  }> {
    const active = this.active;
    if (!active) throw new Error("visual loop is not prepared");
    const found = this.getCapture(baselineCaptureId);
    if (found.status !== "available")
      throw new Error(`baseline capture is unavailable: ${found.status}`);
    const before = found.capture;
    // A silent `?? before.stateLabel` would let a page that was clicked without
    // declaring it still compare as equal; the caller has to say the state out loud.
    if (before.stateLabel !== undefined && input.stateLabel === undefined)
      throw new Error(
        `baseline capture declared stateLabel "${before.stateLabel}"; pass the same stateLabel to confirm the interaction state is unchanged, or the new one if it changed`,
      );
    let after: Capture | undefined;
    let failure: string | undefined;
    try {
      after = await this.capture(
        ctx,
        {
          allowTargetFailure: true,
          selector: before.target?.selector,
          stateLabel: input.stateLabel,
        },
        operationSignal,
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const targetChanges = summarizeTargetChanges(before.target, after?.target);
    const reasons = after
      ? compareCaptureConditions(before, after)
      : [
          `after capture failed: ${failure ?? "unknown error"}`,
        ];
    const comparisonId = id("comparison");
    let commonRegion: Comparison["commonRegion"];
    if (after && reasons.length === 0 && targetChanges.status !== "missing") {
      const common = commonViewportRegion(before.target, after.target, {
        height: before.viewport.height,
        width: before.viewport.width,
        x: 0,
        y: 0,
      });
      if (common) {
        const beforePath = join(active.evidenceDir, `${comparisonId}.before.png`);
        const afterPath = join(active.evidenceDir, `${comparisonId}.after.png`);
        try {
          const [beforeImage, afterImage] = await Promise.all([
            createComparisonArtifact(before, beforePath),
            createComparisonArtifact(after, afterPath),
          ]);
          commonRegion = {
            after: afterImage,
            before: beforeImage,
            clipped: common.clipped,
            region: common.region,
            sourceRegions: {
              after: afterImage.sourceRegion,
              before: beforeImage.sourceRegion,
            },
          };
        } catch (error) {
          reasons.push(
            `comparison crop failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await Promise.all([
            rm(beforePath, {
              force: true,
            }),
            rm(afterPath, {
              force: true,
            }),
          ]);
        }
      }
    }
    const comparison = active.evidence.addComparison(
      {
        ...(after
          ? {
              afterCaptureId: after.captureId,
            }
          : {}),
        beforeCaptureId: before.captureId,
        comparisonId,
        mode: "regression",
        ...(commonRegion
          ? {
              commonRegion,
            }
          : {}),
        diagnostics: {
          ...(after
            ? {
                after: after.diagnostics,
              }
            : {}),
          before: before.diagnostics,
        },
        reasons,
        status: reasons.length === 0 ? "comparable" : "not-comparable",
        targetChanges,
      },
      this.epoch,
    );
    return {
      ...(after
        ? {
            after,
          }
        : {}),
      before,
      comparison,
    };
  }

  /**
   * Compose two captures that already exist into one comparison. Nothing is
   * re-observed: no navigation, no screenshot, no endpoint probe. That is what
   * separates a variant comparison from a regression check, and why the caller
   * cannot pick the mode — the producing operation decides it.
   */
  compare(
    leftCaptureId: string,
    rightCaptureId: string,
    labels?: [
      string,
      string,
    ],
  ): {
    comparison: Comparison;
    left: Capture;
    right: Capture;
  } {
    const active = this.active;
    if (!active) throw new Error("visual loop is not prepared");
    const left = this.getCapture(leftCaptureId);
    if (left.status !== "available")
      throw new Error(
        `comparison capture is unavailable: ${leftCaptureId} (${left.status})`,
      );
    const right = this.getCapture(rightCaptureId);
    if (right.status !== "available")
      throw new Error(
        `comparison capture is unavailable: ${rightCaptureId} (${right.status})`,
      );
    const comparison = active.evidence.addComparison(
      {
        afterCaptureId: right.capture.captureId,
        beforeCaptureId: left.capture.captureId,
        comparisonId: id("comparison"),
        diagnostics: {
          after: right.capture.diagnostics,
          before: left.capture.diagnostics,
        },
        ...(labels
          ? {
              labels,
            }
          : {}),
        mode: "variant",
        // The two sides are meant to differ, so every differing condition is
        // information rather than a refusal. compareCaptureConditions is reused
        // unchanged so the regression path keeps its single judge.
        reasons: compareCaptureConditions(left.capture, right.capture),
        status: "comparable",
        targetChanges: summarizeTargetChanges(
          left.capture.target,
          right.capture.target,
        ),
      },
      this.epoch,
    );
    return {
      comparison,
      left: left.capture,
      right: right.capture,
    };
  }

  getComparison(comparisonId: string) {
    if (!this.active)
      return {
        status: "missing" as const,
      };
    return this.active.evidence.getComparison(comparisonId, this.epoch);
  }
  getCapture(captureId: string) {
    if (!this.active)
      return {
        status: "missing" as const,
      };
    return this.active.evidence.getCapture(captureId, this.epoch);
  }

  getGlimpseModulePath(): string | undefined {
    return this.active?.config.glimpseModulePath;
  }

  /**
   * "Don't ask again this round" is scoped to one inspection: the flag lives on the
   * active context, so it dies with the inspection instead of leaking into the next one.
   */
  suppressFeedback(): void {
    if (this.active) this.active.feedbackSuppressed = true;
  }

  feedbackSuppressed(): boolean {
    return this.active?.feedbackSuppressed === true;
  }

  async runFeedback<T>(
    captureId: string,
    signal: AbortSignal | undefined,
    operation: (
      signal: AbortSignal,
      registerClose: (close: () => void) => void,
    ) => Promise<T>,
  ): Promise<
    | T
    | {
        captureId: string;
        status: "busy";
      }
  > {
    const active = this.active;
    if (!active) throw new Error("visual loop is not prepared");
    if (active.feedbackCancel)
      return {
        captureId: captureId,
        status: "busy",
      };
    const epoch = this.epoch;
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([
          signal,
          controller.signal,
        ])
      : controller.signal;
    let closePanel: (() => void) | undefined;
    active.feedbackCancel = () => {
      closePanel?.();
      controller.abort();
    };
    try {
      const result = await operation(combinedSignal, (close) => {
        closePanel = close;
      });
      if (epoch !== this.epoch || this.active !== active)
        throw new Error("visual loop session changed");
      return result;
    } finally {
      if (this.active === active) active.feedbackCancel = undefined;
    }
  }

  addFeedback(
    captureId: string,
    comment: string,
    region: Region,
    options: {
      comparisonId?: string;
      source: "pick" | "drag";
      target?: FeedbackTarget;
    },
  ): Feedback {
    const active = this.active;
    if (!active) throw new Error("visual loop is not prepared");
    return active.evidence.addFeedback(
      {
        captureId,
        comment,
        ...(options.comparisonId
          ? {
              comparisonId: options.comparisonId,
            }
          : {}),
        feedbackId: `feedback-${randomUUID()}`,
        region,
        source: options.source,
        sourceImageId: captureId,
        submittedAt: new Date().toISOString(),
        ...(options.target
          ? {
              target: options.target,
            }
          : {}),
      },
      this.epoch,
    );
  }

  status(): InspectionContextStatus {
    if (!this.active)
      return {
        state: "disconnected",
      };
    return {
      cdpUrl: this.active.config.cdpUrl,
      inspectionId: this.active.inspectionId,
      pageUrl: this.active.page?.url,
      state: this.active.busy ? "busy" : "ready",
      targetId: this.active.targetId,
      windowState: this.active.windowState,
    };
  }

  /**
   * Releases the connection and the pages this session opened. Aborting the
   * in-flight controllers first cancels work already queued or running, and the
   * browser process and its profile are never touched.
   */
  async disconnect(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.epoch += 1;
    for (const controller of active.abortControllers) controller.abort();
    await active.queue.catch(() => undefined);
    for (const targetId of active.createdTargets) {
      const sessionId = active.owned.session(targetId);
      if (sessionId === undefined) continue;
      await dropOwnedTarget(active.cdp, active.owned, targetId, sessionId).catch(
        () => undefined,
      );
    }
    await active.cdp.close().catch(() => undefined);
    await active.lockHandle.close().catch(() => undefined);
    await rm(active.lockPath, {
      force: true,
    }).catch(() => undefined);
    await rm(active.evidenceDir, {
      force: true,
      recursive: true,
    }).catch(() => undefined);
  }

  async resetSession(): Promise<void> {
    await this.disconnect();
  }

  private configFor(ctx: ExtensionContext) {
    return loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
  }

  private async connect(config: VisualLoopConfig, signal?: AbortSignal): Promise<void> {
    const cdp = new CdpClient();
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    let lockPath: string | undefined;
    let evidenceDir: string | undefined;
    try {
      // A cold start has nothing listening yet, and `cdp.connect` only reads an
      // endpoint that already exists. Reachability is also the one step that may
      // start the extension-owned browser, so it has to run first.
      await validateEndpointReachability(config.cdpUrl, config.launch, signal);
      await cdp.connect(config.cdpUrl, signal);
      await mkdir(LOCK_DIR, {
        mode: 0o700,
        recursive: true,
      });
      lockPath = endpointLockPath(config.cdpUrl);
      lockHandle = await acquireEndpointLock(lockPath);
      evidenceDir = await mkdtemp(join(tmpdir(), "xpv-"));
      this.active = {
        abortControllers: new Set(),
        busy: false,
        cdp,
        config,
        createdTargets: [],
        evidenceDir,
        evidence: new EvidenceStore(evidenceDir, this.epoch),
        feedbackSuppressed: false,
        inspectionId: id("inspection"),
        lockHandle,
        lockPath,
        owned: new OwnedTargetsClass(),
        page: undefined,
        queue: Promise.resolve(),
        stateLabel: undefined,
        targetId: "",
      };
    } catch (error) {
      await cdp.close().catch(() => undefined);
      await lockHandle?.close().catch(() => undefined);
      if (lockPath) {
        await rm(lockPath, {
          force: true,
        }).catch(() => undefined);
      }
      if (evidenceDir)
        await rm(evidenceDir, {
          force: true,
          recursive: true,
        }).catch(() => undefined);
      throw error;
    }
  }

  private async serial<T>(
    active: ActiveInspection,
    operationSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = active.queue;
    let release!: () => void;
    const controller = new AbortController();
    active.abortControllers.add(controller);
    active.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signal = operationSignal
      ? AbortSignal.any([
          operationSignal,
          controller.signal,
        ])
      : controller.signal;
    active.busy = true;
    await previous;
    try {
      return await operation(signal);
    } finally {
      active.abortControllers.delete(controller);
      active.busy = false;
      release();
    }
  }
}

/**
 * What the caller may assume about reaching a page by hand. The launch form
 * decides it, the window state refines it, and the text is what the model
 * reads before it asks the user to interact: a headless context must never be
 * described as something the user can see or touch, and a minimized one must
 * not be described as if the window were in the foreground.
 */
export function describeLaunch(
  launch: LaunchForm,
  windowState?: WindowState,
): {
  interaction: string;
  launch: LaunchForm;
  userOperable: boolean;
} {
  if (launch === "headless")
    return {
      interaction:
        "this browser runs headless: the page is not visible and the user cannot reach it, so a verification that needs the user to change the page by hand cannot be completed here",
      launch,
      userOperable: false,
    };
  if (launch === "minimized")
    return {
      interaction:
        windowState === "minimized"
          ? "the browser window is minimized: bring it back from the Dock (macOS) or the taskbar to see the page and change its interaction state by hand, then capture again"
          : "the browser window state is unknown: the extension could not confirm minimization, so bring the window to the front before relying on what the user sees",
      launch,
      userOperable: true,
    };
  return {
    interaction:
      "the browser window is visible: the user can see the page and operate it directly",
    launch,
    userOperable: true,
  };
}

export function formatPrepareResult(
  inspectionId: string | undefined,
  prepared: {
    epoch: number;
    result: CdpPrepareResult;
    stateLabel?: string;
    windowState?: WindowState;
    launch: LaunchForm;
  },
): string {
  const value = {
    dpr: prepared.result.dpr,
    epoch: prepared.epoch,
    inspectionId,
    page: prepared.result.page,
    stateLabel: prepared.stateLabel,
    targetId: prepared.result.targetId,
    windowState: prepared.windowState,
    ...describeLaunch(prepared.launch, prepared.windowState),
  };
  return JSON.stringify(value);
}

export function defaultViewport(): Viewport {
  return {
    ...DEFAULT_VIEWPORT,
  };
}
