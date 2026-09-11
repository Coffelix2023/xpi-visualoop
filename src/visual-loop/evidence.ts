import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface Region {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface CaptureTarget {
  accessibility: Record<string, string>;
  bounds: Region;
  selector: string;
  styles: Record<string, string>;
  text?: string;
  visibleBounds: Region;
}
export interface ImageArtifact {
  byteLength: number;
  /** Output pixels per page (document) coordinate unit. */
  coordinateScale: {
    x: number;
    y: number;
  };
  height: number;
  path: string;
  /** Page document rectangle this image covers. */
  sourceRegion: Region;
  width: number;
}
export interface DiagnosticEntry {
  kind: "console" | "network";
  message: string;
  status?: number;
  url?: string;
}

export interface DiagnosticSummary {
  entries: DiagnosticEntry[];
  observedFrom?: string;
  observedTo?: string;
  status: "observed" | "unknown";
  truncated: boolean;
}

export interface Capture {
  captureId: string;
  diagnostics: {
    console: DiagnosticSummary;
    network: DiagnosticSummary;
  };
  dpr: number;
  endedAt: string;
  image: ImageArtifact & {
    crop?: ImageArtifact;
    raw: {
      byteLength: number;
      height: number;
      width: number;
    };
  };
  inspectionId: string;
  page: {
    height: number;
    scrollX: number;
    scrollY: number;
    title: string;
    url: string;
    width: number;
  };
  readiness: {
    reasons: string[];
    status: "degraded" | "ready";
  };
  sessionEpoch: number;
  startedAt: string;
  stateLabel?: string;
  target?: CaptureTarget;
  targetId: string;
  viewport: {
    height: number;
    width: number;
  };
}

export interface Feedback {
  captureId: string;
  comment: string;
  comparisonId?: string;
  feedbackId: string;
  region: Region;
  sourceImageId: string;
  submittedAt: string;
}

export interface TargetChangeSummary {
  after?: {
    bounds: Region;
    styles: Record<string, string>;
    visibleBounds: Region;
  };
  before?: {
    bounds: Region;
    styles: Record<string, string>;
    visibleBounds: Region;
  };
  changedFields: string[];
  status: "changed" | "missing" | "unchanged";
}

export interface ComparisonCrop {
  after: ImageArtifact;
  before: ImageArtifact;
  clipped: boolean;
  region: Region;
  sourceRegions: {
    after: Region;
    before: Region;
  };
}

export interface Comparison {
  afterCaptureId?: string;
  beforeCaptureId: string;
  commonRegion?: ComparisonCrop;
  comparisonId: string;
  diagnostics: {
    after?: Capture["diagnostics"];
    before: Capture["diagnostics"];
  };
  labels?: [
    string,
    string,
  ];
  mode: "regression" | "variant";
  reasons: string[];
  status: "comparable" | "not-comparable";
  targetChanges: TargetChangeSummary;
}

function targetSnapshot(target: CaptureTarget | undefined) {
  return target
    ? {
        bounds: target.bounds,
        styles: target.styles,
        visibleBounds: target.visibleBounds,
      }
    : undefined;
}

function changedStyleFields(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const fields = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  return [
    ...fields,
  ]
    .filter((field) => before[field] !== after[field])
    .sort();
}

export function summarizeTargetChanges(
  before: CaptureTarget | undefined,
  after: CaptureTarget | undefined,
): TargetChangeSummary {
  const beforeSnapshot = targetSnapshot(before);
  const afterSnapshot = targetSnapshot(after);
  if (!beforeSnapshot || !afterSnapshot) {
    return {
      ...(afterSnapshot
        ? {
            after: afterSnapshot,
          }
        : {}),
      ...(beforeSnapshot
        ? {
            before: beforeSnapshot,
          }
        : {}),
      changedFields: [],
      status: "missing",
    };
  }
  const changedFields: string[] = [];
  if (JSON.stringify(beforeSnapshot.bounds) !== JSON.stringify(afterSnapshot.bounds))
    changedFields.push("bounds");
  if (
    JSON.stringify(beforeSnapshot.visibleBounds) !==
    JSON.stringify(afterSnapshot.visibleBounds)
  )
    changedFields.push("visibleBounds");
  changedFields.push(
    ...changedStyleFields(beforeSnapshot.styles, afterSnapshot.styles).map(
      (field) => `styles.${field}`,
    ),
  );
  return {
    after: afterSnapshot,
    before: beforeSnapshot,
    changedFields,
    status: changedFields.length > 0 ? "changed" : "unchanged",
  };
}

export function commonViewportRegion(
  before: CaptureTarget | undefined,
  after: CaptureTarget | undefined,
  viewport: Region,
):
  | {
      clipped: boolean;
      region: Region;
    }
  | undefined {
  if (!before || !after) return undefined;
  const left = Math.min(before.visibleBounds.x, after.visibleBounds.x);
  const top = Math.min(before.visibleBounds.y, after.visibleBounds.y);
  const right = Math.max(
    before.visibleBounds.x + before.visibleBounds.width,
    after.visibleBounds.x + after.visibleBounds.width,
  );
  const bottom = Math.max(
    before.visibleBounds.y + before.visibleBounds.height,
    after.visibleBounds.y + after.visibleBounds.height,
  );
  const clipped =
    left < viewport.x ||
    top < viewport.y ||
    right > viewport.x + viewport.width ||
    bottom > viewport.y + viewport.height;
  const x = Math.max(left, viewport.x);
  const y = Math.max(top, viewport.y);
  const maxX = Math.min(right, viewport.x + viewport.width);
  const maxY = Math.min(bottom, viewport.y + viewport.height);
  if (maxX <= x || maxY <= y) return undefined;
  return {
    clipped,
    region: {
      height: maxY - y,
      width: maxX - x,
      x,
      y,
    },
  };
}

export function compareCaptureConditions(before: Capture, after: Capture): string[] {
  const reasons: string[] = [];
  if (
    before.inspectionId !== after.inspectionId ||
    before.sessionEpoch !== after.sessionEpoch
  )
    reasons.push("inspection context changed");
  if (before.targetId !== after.targetId) reasons.push("bound browser target changed");
  if (before.page.url !== after.page.url) reasons.push("page URL changed");
  if (
    before.viewport.width !== after.viewport.width ||
    before.viewport.height !== after.viewport.height
  )
    reasons.push("viewport changed");
  if (before.dpr !== after.dpr) reasons.push("device pixel ratio changed");
  if (
    before.page.scrollX !== after.page.scrollX ||
    before.page.scrollY !== after.page.scrollY
  )
    reasons.push("scroll position changed");
  if (before.stateLabel !== after.stateLabel)
    reasons.push("declared interaction state changed");
  // sourceRegion is the document rectangle for both paths, so this is a real
  // mapping comparison now that the legacy pixel-ratio conversion is gone.
  if (
    before.image.sourceRegion.x !== after.image.sourceRegion.x ||
    before.image.sourceRegion.y !== after.image.sourceRegion.y ||
    before.image.sourceRegion.width !== after.image.sourceRegion.width ||
    before.image.sourceRegion.height !== after.image.sourceRegion.height ||
    before.image.coordinateScale.x !== after.image.coordinateScale.x ||
    before.image.coordinateScale.y !== after.image.coordinateScale.y
  )
    reasons.push("image coordinate mapping changed");
  if (before.target?.selector !== after.target?.selector)
    reasons.push("target selector changed");
  if (before.readiness.status === "degraded")
    reasons.push(
      `baseline capture is degraded: ${before.readiness.reasons.join(", ") || "unspecified"}`,
    );
  if (after.readiness.status === "degraded")
    reasons.push(
      `after capture is degraded: ${after.readiness.reasons.join(", ") || "unspecified"}`,
    );
  if (before.target && !after.target) reasons.push("after target is missing");
  return reasons;
}

interface EvidenceLimits {
  maxBytes: number;
  maxCaptures: number;
}

const DEFAULT_LIMITS: EvidenceLimits = {
  maxBytes: 128 * 1024 * 1024,
  maxCaptures: 20,
};
const ID = /^[a-z]+-[A-Za-z0-9._-]+$/;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max = 8192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function identifier(value: unknown, name: string): string {
  const result = string(value, name, 160);
  if (!ID.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function timestamp(value: unknown, name: string): string {
  const result = string(value, name, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${name} is invalid`);
  return result;
}

function _diagnostic(value: unknown, name: string): DiagnosticSummary {
  const item = record(value, name);
  if (item.status !== "observed" && item.status !== "unknown")
    throw new Error(`${name}.status is invalid`);
  if (
    !Array.isArray(item.entries) ||
    item.entries.length > 20 ||
    item.entries.some((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return true;
      const value = entry as Record<string, unknown>;
      return (
        (value.kind !== "console" && value.kind !== "network") ||
        typeof value.message !== "string"
      );
    })
  )
    throw new Error(`${name}.entries is invalid`);
  return {
    entries: item.entries.map((entry) => {
      const value = entry as Record<string, unknown>;
      return {
        kind: value.kind as "console" | "network",
        message: value.message as string,
        ...(typeof value.status === "number"
          ? {
              status: value.status,
            }
          : {}),
        ...(typeof value.url === "string"
          ? {
              url: value.url,
            }
          : {}),
      };
    }),
    ...(typeof item.observedFrom === "string"
      ? {
          observedFrom: item.observedFrom,
        }
      : {}),
    ...(typeof item.observedTo === "string"
      ? {
          observedTo: item.observedTo,
        }
      : {}),
    status: item.status,
    truncated: item.truncated === true,
  };
}

function region(value: unknown, name: string): Region {
  const item = record(value, name);
  const height = item.height;
  const width = item.width;
  const x = item.x;
  const y = item.y;
  if (
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y)
  ) {
    throw new Error(`${name} coordinates must be finite`);
  }
  if (height <= 0 || width <= 0) throw new Error(`${name} must have positive area`);
  if (x < 0 || y < 0) throw new Error(`${name} must not start outside the image`);
  return {
    height,
    width,
    x,
    y,
  };
}

export function validateFeedback(value: unknown): Feedback {
  const item = record(value, "feedback");
  const comment = string(item.comment, "feedback.comment", 2000);
  if (comment.trim().length === 0)
    throw new Error("feedback.comment must not be blank");
  return {
    captureId: identifier(item.captureId, "feedback.captureId"),
    comment,
    ...(item.comparisonId === undefined
      ? {}
      : {
          comparisonId: identifier(item.comparisonId, "feedback.comparisonId"),
        }),
    feedbackId: identifier(item.feedbackId, "feedback.feedbackId"),
    region: region(item.region, "feedback.region"),
    sourceImageId: identifier(item.sourceImageId, "feedback.sourceImageId"),
    submittedAt: timestamp(item.submittedAt, "feedback.submittedAt"),
  };
}

function unknownDiagnostics(): Capture["diagnostics"] {
  return {
    console: {
      entries: [],
      status: "unknown",
      truncated: false,
    },
    network: {
      entries: [],
      status: "unknown",
      truncated: false,
    },
  };
}

function comparisonDiagnostics(value: unknown): Comparison["diagnostics"] {
  if (value === undefined)
    return {
      before: unknownDiagnostics(),
    };
  const item = record(value, "comparison.diagnostics");
  if (item.before === undefined)
    throw new Error("comparison.diagnostics.before is required");
  return {
    after: item.after as Capture["diagnostics"] | undefined,
    before: item.before as Capture["diagnostics"],
  };
}
function comparisonImage(value: unknown, name: string): ImageArtifact {
  const item = record(value, name);
  const width = item.width;
  const height = item.height;
  const byteLength = item.byteLength;
  const coordinateScale = record(item.coordinateScale, `${name}.coordinateScale`);
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0 ||
    typeof byteLength !== "number" ||
    !Number.isFinite(byteLength) ||
    byteLength < 0
  )
    throw new Error(`${name} dimensions are invalid`);
  const scaleX = coordinateScale.x;
  const scaleY = coordinateScale.y;
  if (
    typeof scaleX !== "number" ||
    !Number.isFinite(scaleX) ||
    scaleX <= 0 ||
    typeof scaleY !== "number" ||
    !Number.isFinite(scaleY) ||
    scaleY <= 0
  )
    throw new Error(`${name}.coordinateScale is invalid`);
  return {
    byteLength,
    coordinateScale: {
      x: scaleX,
      y: scaleY,
    },
    height,
    path: string(item.path, `${name}.path`),
    sourceRegion: region(item.sourceRegion, `${name}.sourceRegion`),
    width,
  };
}

function comparisonCrop(value: unknown): ComparisonCrop {
  const item = record(value, "comparison.commonRegion");
  if (typeof item.clipped !== "boolean")
    throw new Error("comparison.commonRegion.clipped is invalid");
  const sourceRegions = record(
    item.sourceRegions,
    "comparison.commonRegion.sourceRegions",
  );
  return {
    after: comparisonImage(item.after, "comparison.commonRegion.after"),
    before: comparisonImage(item.before, "comparison.commonRegion.before"),
    clipped: item.clipped,
    region: region(item.region, "comparison.commonRegion.region"),
    sourceRegions: {
      after: region(sourceRegions.after, "comparison.commonRegion.sourceRegions.after"),
      before: region(
        sourceRegions.before,
        "comparison.commonRegion.sourceRegions.before",
      ),
    },
  };
}

function comparisonTargetChanges(value: unknown): TargetChangeSummary {
  if (value === undefined)
    return {
      changedFields: [],
      status: "missing",
    };
  const item = record(value, "comparison.targetChanges");
  if (
    item.status !== "changed" &&
    item.status !== "missing" &&
    item.status !== "unchanged"
  )
    throw new Error("comparison.targetChanges.status is invalid");
  if (
    !Array.isArray(item.changedFields) ||
    item.changedFields.some((field) => typeof field !== "string")
  )
    throw new Error("comparison.targetChanges.changedFields must be strings");
  return {
    ...(item.after === undefined
      ? {}
      : {
          after: item.after as TargetChangeSummary["after"],
        }),
    ...(item.before === undefined
      ? {}
      : {
          before: item.before as TargetChangeSummary["before"],
        }),
    status: item.status,
    changedFields: [
      ...item.changedFields,
    ],
  };
}

function comparisonLabels(value: unknown): [
  string,
  string,
] {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error("comparison.labels must contain exactly two strings");
  return [
    string(value[0], "comparison.labels[0]", 80),
    string(value[1], "comparison.labels[1]", 80),
  ];
}

export function validateComparison(value: unknown): Comparison {
  const item = record(value, "comparison");
  if (item.status !== "comparable" && item.status !== "not-comparable")
    throw new Error("comparison.status is invalid");
  if (
    !Array.isArray(item.reasons) ||
    item.reasons.some((reason) => typeof reason !== "string")
  )
    throw new Error("comparison.reasons must be strings");
  // mode is recorded by whichever operation produced the comparison and is never a
  // caller choice, so an unknown value means corrupted evidence rather than a request.
  if (item.mode !== "regression" && item.mode !== "variant")
    throw new Error("comparison.mode is invalid");
  if (item.status === "comparable" && item.afterCaptureId === undefined)
    throw new Error("comparison.afterCaptureId is required when comparable");
  return {
    ...(item.afterCaptureId === undefined
      ? {}
      : {
          afterCaptureId: identifier(item.afterCaptureId, "comparison.afterCaptureId"),
        }),
    beforeCaptureId: identifier(item.beforeCaptureId, "comparison.beforeCaptureId"),
    comparisonId: identifier(item.comparisonId, "comparison.comparisonId"),
    diagnostics: comparisonDiagnostics(item.diagnostics),
    ...(item.commonRegion === undefined
      ? {}
      : {
          commonRegion: comparisonCrop(item.commonRegion),
        }),
    ...(item.labels === undefined
      ? {}
      : {
          labels: comparisonLabels(item.labels),
        }),
    mode: item.mode,
    status: item.status,
    targetChanges: comparisonTargetChanges(item.targetChanges),
    reasons: [
      ...item.reasons,
    ],
  };
}

function freezeCapture(value: Capture): Capture {
  Object.freeze(value.diagnostics);
  Object.freeze(value.diagnostics.console.entries);
  Object.freeze(value.diagnostics.network.entries);
  Object.freeze(value.diagnostics.console);
  Object.freeze(value.diagnostics.network);
  Object.freeze(value.image.sourceRegion);
  Object.freeze(value.image.coordinateScale);
  Object.freeze(value.image.raw);
  if (value.image.crop) {
    Object.freeze(value.image.crop.coordinateScale);
    Object.freeze(value.image.crop.sourceRegion);
    Object.freeze(value.image.crop);
  }
  Object.freeze(value.image);
  Object.freeze(value.page);
  Object.freeze(value.readiness.reasons);
  Object.freeze(value.readiness);
  Object.freeze(value.viewport);
  if (value.target) {
    Object.freeze(value.target.accessibility);
    Object.freeze(value.target.bounds);
    Object.freeze(value.target.styles);
    Object.freeze(value.target.visibleBounds);
    Object.freeze(value.target);
  }
  return Object.freeze(value);
}
function freezeComparison(value: Comparison): Comparison {
  Object.freeze(value.reasons);
  Object.freeze(value.diagnostics.before.console.entries);
  Object.freeze(value.diagnostics.before.network.entries);
  Object.freeze(value.diagnostics.before.console);
  Object.freeze(value.diagnostics.before.network);
  Object.freeze(value.diagnostics.before);
  if (value.diagnostics.after) {
    Object.freeze(value.diagnostics.after.console.entries);
    Object.freeze(value.diagnostics.after.network.entries);
    Object.freeze(value.diagnostics.after.console);
    Object.freeze(value.diagnostics.after.network);
    Object.freeze(value.diagnostics.after);
  }
  Object.freeze(value.targetChanges.changedFields);
  for (const target of [
    value.targetChanges.before,
    value.targetChanges.after,
  ]) {
    if (!target) continue;
    Object.freeze(target.bounds);
    Object.freeze(target.styles);
    Object.freeze(target.visibleBounds);
    Object.freeze(target);
  }
  if (value.commonRegion) {
    for (const image of [
      value.commonRegion.before,
      value.commonRegion.after,
    ]) {
      Object.freeze(image.coordinateScale);
      Object.freeze(image.sourceRegion);
      Object.freeze(image);
    }
    Object.freeze(value.commonRegion.region);
    Object.freeze(value.commonRegion.sourceRegions.before);
    Object.freeze(value.commonRegion.sourceRegions.after);
    Object.freeze(value.commonRegion.sourceRegions);
    Object.freeze(value.commonRegion);
  }
  if (value.labels) Object.freeze(value.labels);
  return Object.freeze(value);
}

async function verifyArtifact(
  rootPath: string,
  ownedRoot: string,
  artifact: ImageArtifact,
  name: string,
): Promise<ImageArtifact> {
  if (!isAbsolute(artifact.path)) throw new Error(`${name} path must be absolute`);
  const lexical = relative(rootPath, resolve(artifact.path));
  if (lexical.startsWith("..") || isAbsolute(lexical))
    throw new Error(`${name} must remain in the owned evidence directory`);
  if ((await lstat(artifact.path)).isSymbolicLink())
    throw new Error(`${name} must not be a symbolic link`);
  const imagePath = await realpath(artifact.path);
  const actual = relative(ownedRoot, imagePath);
  if (actual.startsWith("..") || isAbsolute(actual))
    throw new Error(`${name} escaped the owned evidence directory`);
  return {
    ...artifact,
    byteLength: (await stat(imagePath)).size,
    path: imagePath,
  };
}

export class EvidenceStore {
  private bytes = 0;
  private readonly captures = new Map<string, Capture>();
  private readonly comparisons = new Map<string, Comparison>();
  private readonly feedback = new Map<string, Feedback>();
  private readonly limits: EvidenceLimits;

  constructor(
    private readonly root: string,
    private readonly epoch: number,
    limits: Partial<EvidenceLimits> = {},
  ) {
    this.limits = {
      ...DEFAULT_LIMITS,
      ...limits,
    };
  }

  async addCapture(capture: Capture): Promise<Capture> {
    identifier(capture.captureId, "capture.captureId");
    if (capture.sessionEpoch !== this.epoch)
      throw new Error("capture belongs to another session");
    if (this.captures.has(capture.captureId))
      throw new Error(`capture already exists: ${capture.captureId}`);
    const rootPath = resolve(this.root);
    const ownedRoot = await realpath(rootPath);
    const image = await verifyArtifact(
      rootPath,
      ownedRoot,
      capture.image,
      "capture image",
    );
    const crop = capture.image.crop
      ? await verifyArtifact(rootPath, ownedRoot, capture.image.crop, "capture crop")
      : undefined;
    const size =
      image.byteLength + (crop?.byteLength ?? 0) + capture.image.raw.byteLength;
    if (
      this.captures.size >= this.limits.maxCaptures ||
      this.bytes + size > this.limits.maxBytes
    )
      throw new Error("evidence capacity reached; disconnect before capturing again");
    const stored = freezeCapture({
      ...capture,
      image: {
        ...image,
        raw: capture.image.raw,
        ...(crop
          ? {
              crop,
            }
          : {}),
      },
    });
    this.captures.set(stored.captureId, stored);
    this.bytes += size;
    return stored;
  }

  addFeedback(value: unknown, sessionEpoch: number): Feedback {
    if (sessionEpoch !== this.epoch)
      throw new Error("feedback belongs to another session");
    const feedback = validateFeedback(value);
    if (this.feedback.has(feedback.feedbackId))
      throw new Error(`feedback already exists: ${feedback.feedbackId}`);
    if (!this.captures.has(feedback.captureId))
      throw new Error(`feedback capture is unavailable: ${feedback.captureId}`);
    if (feedback.sourceImageId !== feedback.captureId)
      throw new Error("feedback source image must match its capture");
    if (feedback.comparisonId) {
      const comparison = this.comparisons.get(feedback.comparisonId);
      if (!comparison)
        throw new Error(`feedback comparison is unavailable: ${feedback.comparisonId}`);
      if (comparison.afterCaptureId !== feedback.captureId)
        throw new Error("comparison feedback must reference the after capture");
    }
    const stored = Object.freeze({
      ...feedback,
      region: Object.freeze(feedback.region),
    });
    this.feedback.set(stored.feedbackId, stored);
    return stored;
  }

  addComparison(value: unknown, sessionEpoch: number): Comparison {
    if (sessionEpoch !== this.epoch)
      throw new Error("comparison belongs to another session");
    const comparison = validateComparison(value);
    if (this.comparisons.has(comparison.comparisonId))
      throw new Error(`comparison already exists: ${comparison.comparisonId}`);
    if (!this.captures.has(comparison.beforeCaptureId))
      throw new Error(
        `comparison baseline is unavailable: ${comparison.beforeCaptureId}`,
      );
    if (comparison.afterCaptureId && !this.captures.has(comparison.afterCaptureId))
      throw new Error(
        `comparison capture is unavailable: ${comparison.afterCaptureId}`,
      );
    const stored = freezeComparison({
      ...comparison,
      reasons: [
        ...comparison.reasons,
      ],
    });
    Object.freeze(stored.reasons);
    this.comparisons.set(stored.comparisonId, stored);
    return stored;
  }

  getComparison(
    comparisonId: string,
    sessionEpoch: number,
  ):
    | {
        comparison: Comparison;
        status: "available";
      }
    | {
        status: "missing" | "wrong-session";
      } {
    if (sessionEpoch !== this.epoch)
      return {
        status: "wrong-session",
      };
    const comparison = this.comparisons.get(comparisonId);
    return comparison
      ? {
          comparison,
          status: "available",
        }
      : {
          status: "missing",
        };
  }
  getCapture(
    captureId: string,
    sessionEpoch: number,
  ):
    | {
        capture: Capture;
        status: "available";
      }
    | {
        status: "missing" | "wrong-session";
      } {
    if (sessionEpoch !== this.epoch)
      return {
        status: "wrong-session",
      };
    const capture = this.captures.get(captureId);
    return capture
      ? {
          capture,
          status: "available",
        }
      : {
          status: "missing",
        };
  }
}
