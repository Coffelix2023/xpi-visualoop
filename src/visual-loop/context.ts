import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
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
  type ImageArtifact,
  imageRegionForViewport,
  type Region,
  summarizeTargetChanges,
} from "./evidence.ts";
import {
  createPrivateHarnessDirs,
  type HarnessCaptureResult,
  type HarnessPrepareResult,
  type PrivateHarnessDirs,
  reloadHarness,
  removePrivateHarnessDirs,
  runCapture,
  runCrop,
  runPrepare,
} from "./harness.ts";

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
}

interface ActiveInspection {
  abortControllers: Set<AbortController>;
  busy: boolean;
  config: VisualLoopConfig;
  dirs: PrivateHarnessDirs;
  evidence: EvidenceStore;
  feedbackCancel?: () => void;
  inspectionId: string;
  lockHandle: Awaited<ReturnType<typeof open>>;
  lockPath: string;
  page?: HarnessPrepareResult["page"];
  queue: Promise<void>;
  stateLabel?: string;
  targetId: string;
}

const DEFAULT_DPR = 1;
const DEFAULT_VIEWPORT: Viewport = {
  height: 900,
  width: 1440,
};
const MAX_DPR = 2;
const MAX_HEIGHT = 1600;
const MAX_WIDTH = 2560;
const MIN_HEIGHT = 240;
const MIN_WIDTH = 320;
const LOCK_DIR = join(tmpdir(), "xpi-visualoop-locks");

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function endpointLockPath(cdpUrl: string): string {
  const digest = createHash("sha256").update(cdpUrl).digest("hex").slice(0, 32);
  return join(LOCK_DIR, `${digest}.lock`);
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
  const width = assertFiniteRange(
    viewport.width,
    MIN_WIDTH,
    MAX_WIDTH,
    "viewport.width",
  );
  const height = assertFiniteRange(
    viewport.height,
    MIN_HEIGHT,
    MAX_HEIGHT,
    "viewport.height",
  );
  const dpr = assertFiniteRange(input.dpr ?? DEFAULT_DPR, 1, MAX_DPR, "dpr");
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

function capturePage(page: HarnessCaptureResult["pageAfter"]): Capture["page"] {
  if (
    page.h === undefined ||
    page.ph === undefined ||
    page.pw === undefined ||
    page.sx === undefined ||
    page.sy === undefined ||
    page.w === undefined
  ) {
    throw new Error("capture page metadata is incomplete");
  }
  return {
    height: page.ph,
    scrollX: page.sx,
    scrollY: page.sy,
    title: page.title ?? "",
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

function comparisonSourceRegion(capture: Capture, cropRegion: Region): Region {
  return {
    height: cropRegion.height / capture.image.coordinateScale.y,
    width: cropRegion.width / capture.image.coordinateScale.x,
    x: capture.image.sourceRegion.x + cropRegion.x / capture.image.coordinateScale.x,
    y: capture.image.sourceRegion.y + cropRegion.y / capture.image.coordinateScale.y,
  };
}

async function createComparisonArtifact(
  config: VisualLoopConfig,
  dirs: PrivateHarnessDirs,
  capture: Capture,
  viewportRegion: Region,
  outputPath: string,
  signal: AbortSignal,
): Promise<ImageArtifact> {
  const cropRegion = imageRegionForViewport(capture, viewportRegion);
  const sourceRegion = comparisonSourceRegion(capture, cropRegion);
  const result = await runCrop(
    config,
    dirs,
    {
      action: "crop",
      cropRegion,
      outputPath,
      sourcePath: capture.image.path,
    },
    signal,
  );
  return imageArtifact(result, sourceRegion);
}
export function cropParentOffset(
  crop: {
    x: number;
    y: number;
  },
  image: {
    height: number;
    rawHeight: number;
    rawWidth: number;
    width: number;
  },
): {
  x: number;
  y: number;
} {
  return {
    x: crop.x * (image.width / image.rawWidth),
    y: crop.y * (image.height / image.rawHeight),
  };
}

export class VisualLoopManager {
  private active?: ActiveInspection;
  private epoch = 0;

  async prepare(
    ctx: ExtensionContext,
    input: PrepareInput,
    operationSignal?: AbortSignal,
  ): Promise<{
    epoch: number;
    result: HarnessPrepareResult;
    stateLabel?: string;
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
      await validateEndpointReachability(config.cdpUrl, operationSignal);
      const result = await runPrepare(
        config,
        active.dirs,
        {
          action: "prepare",
          dpr: request.dpr,
          targetId: active.targetId || undefined,
          url: request.url,
          viewport: request.viewport,
        },
        operationSignal,
      );
      validateLocalPageUrl(result.page.url);
      if (epoch !== this.epoch || this.active !== active)
        throw new Error("visual loop session changed");
      active.targetId = result.targetId;
      active.page = result.page;
      active.stateLabel = request.stateLabel;
      return {
        epoch,
        result,
        stateLabel: request.stateLabel,
      };
    });
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
      await validateEndpointReachability(active.config.cdpUrl, captureSignal);
      const captureId = id("capture");
      const imagePath = join(active.dirs.tmpDir, `${captureId}.png`);
      const targetImagePath = join(active.dirs.tmpDir, `${captureId}.target.png`);
      const result = await runCapture(
        active.config,
        active.dirs,
        {
          action: "capture",
          allowTargetFailure: request.allowTargetFailure,
          targetImagePath,
          imagePath,
          selector: request.selector,
          targetId: active.targetId,
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
          result.pageAfter.h ?? Number.NaN,
          1,
          MAX_HEIGHT,
          "capture viewport height",
        ),
        width: assertFiniteRange(
          result.pageAfter.w ?? Number.NaN,
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
                crop: {
                  ...(await imageArtifact(
                    result.image.crop,
                    result.image.crop.sourceRegion,
                  )),
                  parentOffset: cropParentOffset(
                    result.image.crop.parentOffset,
                    result.image,
                  ),
                },
              }
            : {}),
          ...(await imageArtifact(result.image, {
            height: viewport.height,
            width: viewport.width,
            x: page.scrollX,
            y: page.scrollY,
          })),
          raw: {
            byteLength: result.image.temporaryByteLength,
            height: result.image.rawHeight,
            width: result.image.rawWidth,
          },
        },
        page,
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
    let after: Capture | undefined;
    const signal = operationSignal ?? ctx.signal ?? new AbortController().signal;
    let failure: string | undefined;
    try {
      after = await this.capture(
        ctx,
        {
          allowTargetFailure: true,
          selector: before.target?.selector,
          stateLabel: input.stateLabel ?? before.stateLabel,
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
        const beforePath = join(active.dirs.tmpDir, `${comparisonId}.before.png`);
        const afterPath = join(active.dirs.tmpDir, `${comparisonId}.after.png`);
        try {
          const [beforeImage, afterImage] = await Promise.all([
            createComparisonArtifact(
              active.config,
              active.dirs,
              before,
              common.region,
              beforePath,
              signal,
            ),
            createComparisonArtifact(
              active.config,
              active.dirs,
              after,
              common.region,
              afterPath,
              signal,
            ),
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
    comparisonId?: string,
  ): Feedback {
    const active = this.active;
    if (!active) throw new Error("visual loop is not prepared");
    return active.evidence.addFeedback(
      {
        captureId,
        comment,
        ...(comparisonId
          ? {
              comparisonId,
            }
          : {}),
        feedbackId: `feedback-${randomUUID()}`,
        region,
        sourceImageId: captureId,
        submittedAt: new Date().toISOString(),
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
    };
  }

  async disconnect(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.epoch += 1;
    for (const controller of active.abortControllers) controller.abort();
    await active.queue.catch(() => undefined);
    if (active.targetId && active.page) {
      await runPrepare(active.config, active.dirs, {
        action: "close",
        expectedUrl: active.page.url,
        targetId: active.targetId,
      }).catch(() => undefined);
    }
    await active.lockHandle.close().catch(() => undefined);
    await rm(active.lockPath, {
      force: true,
    }).catch(() => undefined);
    await cleanupHarness(active.config, active.dirs).catch(() => undefined);
  }

  async resetSession(): Promise<void> {
    await this.disconnect();
  }

  private configFor(ctx: ExtensionContext) {
    return loadConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
  }

  private async connect(config: VisualLoopConfig, signal?: AbortSignal): Promise<void> {
    await validateEndpointReachability(config.cdpUrl, signal);
    await mkdir(LOCK_DIR, {
      mode: 0o700,
      recursive: true,
    });
    const lockPath = endpointLockPath(config.cdpUrl);
    let lockHandle: Awaited<ReturnType<typeof open>>;
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          "configured CDP endpoint is already owned by another xpi-visualoop process",
        );
      }
      throw error;
    }
    const dirs = await createPrivateHarnessDirs();
    try {
      await lockHandle.writeFile(
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      );
      this.active = {
        config,
        dirs,
        evidence: new EvidenceStore(dirs.tmpDir, this.epoch),
        inspectionId: id("inspection"),
        lockHandle,
        lockPath,
        abortControllers: new Set(),
        busy: false,
        page: undefined,
        queue: Promise.resolve(),
        stateLabel: undefined,
        targetId: "",
      };
    } catch (error) {
      await lockHandle.close().catch(() => undefined);
      await rm(lockPath, {
        force: true,
      }).catch(() => undefined);
      await removePrivateHarnessDirs(dirs);
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

export function formatPrepareResult(
  inspectionId: string | undefined,
  prepared: {
    epoch: number;
    result: HarnessPrepareResult;
    stateLabel?: string;
  },
): string {
  const value = {
    dpr: prepared.result.dpr,
    epoch: prepared.epoch,
    inspectionId,
    page: prepared.result.page,
    protocolVersion: prepared.result.protocolVersion,
    stateLabel: prepared.stateLabel,
    targetId: prepared.result.targetId,
  };
  return JSON.stringify(value);
}

export function defaultViewport(): Viewport {
  return {
    ...DEFAULT_VIEWPORT,
  };
}

export async function cleanupHarness(
  config: VisualLoopConfig,
  dirs: PrivateHarnessDirs,
): Promise<void> {
  await reloadHarness(config, dirs).catch(() => undefined);
  await removePrivateHarnessDirs(dirs);
}
