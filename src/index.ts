import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { stopOwnedChrome } from "./visual-loop/chrome.ts";
import { formatPrepareResult, VisualLoopManager } from "./visual-loop/context.ts";
import type { Capture, Comparison } from "./visual-loop/evidence.ts";
import {
  comparisonPanelInput,
  embedFeedbackImage,
  feedbackPanelInput,
  loadGlimpse,
  renderFeedbackPanel,
  validateFeedbackBridgeMessage,
  validateFeedbackDraft,
  waitForFeedbackPanel,
} from "./visual-loop/feedback.ts";

const VERSION = "0.1.0";
export const PrepareParameters = Type.Object(
  {
    dpr: Type.Optional(
      Type.Number({
        maximum: 2,
        minimum: 1,
      }),
    ),
    stateLabel: Type.Optional(
      Type.String({
        maxLength: 120,
      }),
    ),
    url: Type.String({
      maxLength: 8192,
    }),
    viewport: Type.Optional(
      Type.Object({
        height: Type.Number({
          description:
            "CSS pixels. The exported screenshot edge stays within 2000 device pixels, so at DPR 2 the effective cap is 1000.",
          maximum: 2000,
          minimum: 240,
        }),
        width: Type.Number({
          description:
            "CSS pixels. The exported screenshot edge stays within 2000 device pixels, so at DPR 2 the effective cap is 1000.",
          maximum: 2000,
          minimum: 320,
        }),
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);
export const CaptureParameters = Type.Object(
  {
    selector: Type.Optional(
      Type.String({
        maxLength: 2048,
        minLength: 1,
      }),
    ),
    stateLabel: Type.Optional(
      Type.String({
        maxLength: 120,
        minLength: 1,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

export const FeedbackParameters = Type.Object(
  {
    captureId: Type.Optional(
      Type.String({
        maxLength: 160,
        minLength: 1,
      }),
    ),
    comparisonId: Type.Optional(
      Type.String({
        maxLength: 160,
        minLength: 1,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

export function feedbackReference(params: {
  captureId?: string;
  comparisonId?: string;
}):
  | {
      captureId: string;
      mode: "capture";
    }
  | {
      comparisonId: string;
      mode: "comparison";
    } {
  if (Boolean(params.captureId) === Boolean(params.comparisonId))
    throw new Error("visual_feedback requires exactly one captureId or comparisonId");
  return params.captureId
    ? {
        captureId: params.captureId,
        mode: "capture",
      }
    : {
        comparisonId: params.comparisonId ?? "",
        mode: "comparison",
      };
}

export const VerifyParameters = Type.Object(
  {
    baselineCaptureId: Type.String({
      maxLength: 160,
      minLength: 1,
    }),
    includeViewportImages: Type.Optional(
      Type.Boolean({
        description:
          "Also return the full before/after viewport images; the default return is only the common region pair.",
      }),
    ),
    stateLabel: Type.Optional(
      Type.String({
        maxLength: 120,
        minLength: 1,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

export const CompareParameters = Type.Object(
  {
    labels: Type.Optional(
      Type.Array(
        Type.String({
          maxLength: 80,
          minLength: 1,
        }),
        {
          maxItems: 2,
          minItems: 2,
        },
      ),
    ),
    leftCaptureId: Type.String({
      maxLength: 160,
      minLength: 1,
    }),
    rightCaptureId: Type.String({
      maxLength: 160,
      minLength: 1,
    }),
  },
  {
    additionalProperties: false,
  },
);

/** Whole-verify image budget in original PNG bytes; the legacy path returned four images (~21 MiB once base64-encoded). */
export const MAX_VERIFY_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_ERROR_TEXT = 4 * 1024;

export function toolErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|cookie|token|password|secret|api[-_]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[redacted]",
    );
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.length <= MAX_TOOL_ERROR_TEXT) return redacted;
  let end = MAX_TOOL_ERROR_TEXT;
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

const MAX_CAPTURE_TEXT = 16 * 1024;
export async function captureContent(
  capture: Awaited<ReturnType<VisualLoopManager["capture"]>>,
) {
  const text = JSON.stringify(capture);
  if (Buffer.byteLength(text, "utf8") > MAX_CAPTURE_TEXT)
    throw new Error("visual capture result exceeded the text budget");
  const data = (await readFile(capture.image.path)).toString("base64");
  return [
    {
      text,
      type: "text" as const,
    },
    {
      type: "image" as const,
      data,
      mimeType: "image/png",
    },
  ];
}

export async function imageContent(path: string, label: string) {
  const [data, file] = await Promise.all([
    readFile(path).then((value) => value.toString("base64")),
    stat(path),
  ]);
  return {
    byteLength: file.size,
    content: [
      {
        text: label,
        type: "text" as const,
      },
      {
        data,
        mimeType: "image/png",
        type: "image" as const,
      },
    ],
  };
}

/**
 * Review payload for `visual_verify`. The common-region pair is the default
 * return because that is what the model actually compares; the viewport images
 * are only added when the caller asks for them. Text and bundled bytes are
 * both budgeted, and an over-budget call fails loudly instead of silently
 * dropping evidence.
 */
export async function verifyContent(
  result: Awaited<ReturnType<VisualLoopManager["verify"]>>,
  options: {
    includeViewportImages?: boolean;
  } = {},
) {
  const text = JSON.stringify(result.comparison);
  if (Buffer.byteLength(text, "utf8") > MAX_CAPTURE_TEXT)
    throw new Error("visual comparison result exceeded the text budget");
  const images: Array<Awaited<ReturnType<typeof imageContent>>> = [];
  const common = result.comparison.commonRegion;
  if (common) {
    images.push(
      await imageContent(
        common.before.path,
        `before common region: ${result.comparison.comparisonId}`,
      ),
      await imageContent(
        common.after.path,
        `after common region: ${result.comparison.comparisonId}`,
      ),
    );
  }
  let bytes = images.reduce((total, image) => total + image.byteLength, 0);
  if (options.includeViewportImages) {
    const viewport = await Promise.all([
      imageContent(
        result.before.image.path,
        `before viewport: ${result.before.captureId}`,
      ),
      ...(result.after
        ? [
            await imageContent(
              result.after.image.path,
              `after viewport: ${result.after.captureId}`,
            ),
          ]
        : []),
    ]);
    bytes += viewport.reduce((total, image) => total + image.byteLength, 0);
    images.push(...viewport);
  }
  if (bytes > MAX_VERIFY_IMAGE_BYTES)
    throw new Error(
      `visual verification images exceeded the ${MAX_VERIFY_IMAGE_BYTES}-byte budget; request a smaller region or a lower DPR`,
    );
  return [
    {
      text,
      type: "text" as const,
    },
    ...images.flatMap((image) => image.content),
  ];
}

function sideLabel(side: "left" | "right", captureId: string, label?: string) {
  return label
    ? `${side} viewport: ${captureId} · ${label}`
    : `${side} viewport: ${captureId}`;
}

/**
 * Review payload for `visual_compare`. Both sides are always returned: the point
 * of a variant comparison is to be looked at, so delivering one side would hand
 * the model half the evidence. Over budget fails loudly instead.
 */
export async function compareContent(
  result: Awaited<ReturnType<VisualLoopManager["compare"]>>,
) {
  const text = JSON.stringify(result.comparison);
  if (Buffer.byteLength(text, "utf8") > MAX_CAPTURE_TEXT)
    throw new Error("visual comparison result exceeded the text budget");
  const labels = result.comparison.labels;
  const images = await Promise.all([
    imageContent(
      result.left.image.path,
      sideLabel("left", result.left.captureId, labels?.[0]),
    ),
    imageContent(
      result.right.image.path,
      sideLabel("right", result.right.captureId, labels?.[1]),
    ),
  ]);
  const bytes = images.reduce((total, image) => total + image.byteLength, 0);
  if (bytes > MAX_VERIFY_IMAGE_BYTES)
    throw new Error(
      `visual comparison images exceeded the ${MAX_VERIFY_IMAGE_BYTES}-byte budget; lower the dpr or capture a smaller region`,
    );
  return [
    {
      text,
      type: "text" as const,
    },
    ...images.flatMap((image) => image.content),
  ];
}
export function unavailableFeedbackResult(captureId: string, imagePath: string) {
  return {
    captureId,
    imagePath,
    scope: "entire-screenshot" as const,
    status: "unavailable" as const,
  };
}

export async function textFeedbackFallback(
  ctx: ExtensionContext,
  capture: Awaited<ReturnType<VisualLoopManager["capture"]>>,
  signal: AbortSignal | undefined,
  addFeedback: (comment: string) => ReturnType<VisualLoopManager["addFeedback"]>,
): Promise<{
  feedback?: ReturnType<VisualLoopManager["addFeedback"]>;
  imagePath: string;
  scope: "entire-screenshot";
  status: "cancelled" | "submitted";
}> {
  const dialogOptions = {
    signal,
    timeout: 10 * 60 * 1000,
  };
  const imagePath = capture.image.path;
  const comment = await ctx.ui.input(
    "Visual feedback (text fallback)",
    `Entire screenshot: ${imagePath}\nCapture: ${capture.captureId}\nDescribe the change`,
    dialogOptions,
  );
  if (comment === undefined || comment.trim().length === 0)
    return {
      imagePath,
      scope: "entire-screenshot",
      status: "cancelled",
    };
  const draft = validateFeedbackDraft({
    comment,
    image: capture.image,
    region: {
      height: capture.image.height,
      width: capture.image.width,
      x: 0,
      y: 0,
    },
  });
  const confirmed = await ctx.ui.confirm(
    "Submit visual feedback?",
    `Scope: entire screenshot\nImage: ${imagePath}\n\n${draft.comment}`,
    dialogOptions,
  );
  if (!confirmed)
    return {
      imagePath,
      scope: "entire-screenshot",
      status: "cancelled",
    };
  return {
    feedback: addFeedback(draft.comment),
    imagePath,
    scope: "entire-screenshot",
    status: "submitted",
  };
}

export async function textComparisonFeedbackFallback(
  ctx: ExtensionContext,
  comparison: Comparison,
  before: Capture,
  after: Capture,
  signal: AbortSignal | undefined,
  addFeedback: (comment: string) => ReturnType<VisualLoopManager["addFeedback"]>,
) {
  const binding = {
    afterCaptureId: after.captureId,
    beforeCaptureId: before.captureId,
    comparisonId: comparison.comparisonId,
  };
  const action = await ctx.ui.select(
    "Visual comparison",
    [
      "Accept this result",
      "Submit feedback on after image",
      "Cancel",
    ],
    {
      signal,
      timeout: 10 * 60 * 1000,
    },
  );
  if (action === "Accept this result")
    return {
      ...binding,
      status: "accepted" as const,
    };
  if (action !== "Submit feedback on after image")
    return {
      ...binding,
      status: "cancelled" as const,
    };
  return {
    ...binding,
    ...(await textFeedbackFallback(ctx, after, signal, addFeedback)),
  };
}

export default function xpiVisualoop(pi: ExtensionAPI): void {
  const manager = new VisualLoopManager();

  const reset = async (): Promise<void> => {
    await manager.resetSession();
  };

  pi.on("session_start", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_shutdown", reset);

  pi.registerCommand("xpi-visualoop", {
    description: "Show xpi-visualoop status or disconnect its local browser context",
    handler: async (args, ctx) => {
      if (args.trim() === "disconnect") {
        await manager.disconnect();
        stopOwnedChrome();
        ctx.ui.notify("xpi-visualoop disconnected");
        return;
      }
      if (args.trim() !== "" && args.trim() !== "status") {
        ctx.ui.notify("Usage: /xpi-visualoop [status|disconnect]", "warning");
        return;
      }
      ctx.ui.notify(JSON.stringify(manager.status()));
    },
  });

  pi.registerTool({
    description:
      "Prepare a configured loopback page in the dedicated local browser context.",
    label: "Prepare local visual page",
    name: "visual_prepare",
    parameters: PrepareParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const prepared = await manager.prepare(ctx, params, _signal);
        return {
          content: [
            {
              text: formatPrepareResult(manager.status().inspectionId, prepared),
              type: "text",
            },
          ],
          details: {
            inspectionId: manager.status().inspectionId,
            ok: true,
            targetId: prepared.result.targetId,
          },
        };
      } catch (error) {
        throw new Error(`visual_prepare failed: ${toolErrorMessage(error)}`);
      }
    },
  });

  pi.registerTool({
    description:
      "Review one capture or comparison and return one explicit user result.",
    label: "Review local visual evidence",
    name: "visual_feedback",
    parameters: FeedbackParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const reference = feedbackReference(params);
        let comparison: Comparison | undefined;
        let before: Capture | undefined;
        let capture: Capture;
        if (reference.mode === "capture") {
          const found = manager.getCapture(reference.captureId);
          if (found.status !== "available")
            throw new Error(`capture is unavailable: ${reference.captureId}`);
          capture = found.capture;
        } else {
          const found = manager.getComparison(reference.comparisonId);
          if (found.status !== "available")
            throw new Error(`comparison is unavailable: ${reference.comparisonId}`);
          comparison = found.comparison;
          if (!comparison.afterCaptureId)
            throw new Error("comparison has no after capture to review");
          const beforeFound = manager.getCapture(comparison.beforeCaptureId);
          const afterFound = manager.getCapture(comparison.afterCaptureId);
          if (beforeFound.status !== "available" || afterFound.status !== "available")
            throw new Error("comparison capture is unavailable");
          before = beforeFound.capture;
          capture = afterFound.capture;
        }
        const binding = comparison
          ? {
              afterCaptureId: capture.captureId,
              beforeCaptureId: before?.captureId ?? comparison.beforeCaptureId,
              comparisonId: comparison.comparisonId,
            }
          : {
              captureId: capture.captureId,
            };
        if (!ctx.hasUI) {
          const result = comparison
            ? {
                ...binding,
                afterImagePath: capture.image.path,
                beforeImagePath: before?.image.path,
                status: "unavailable" as const,
              }
            : unavailableFeedbackResult(capture.captureId, capture.image.path);
          return {
            details: result,
            content: [
              {
                text: JSON.stringify(result),
                type: "text" as const,
              },
            ],
          };
        }
        const glimpse = await loadGlimpse(manager.getGlimpseModulePath());
        const result = await manager.runFeedback(
          capture.captureId,
          _signal ?? ctx.signal,
          async (signal, registerClose) => {
            if (!glimpse) {
              if (comparison && before)
                return textComparisonFeedbackFallback(
                  ctx,
                  comparison,
                  before,
                  capture,
                  signal,
                  (comment) =>
                    manager.addFeedback(
                      capture.captureId,
                      comment,
                      {
                        height: capture.image.height,
                        width: capture.image.width,
                        x: 0,
                        y: 0,
                      },
                      comparison?.comparisonId,
                    ),
                );
              const fallback = await textFeedbackFallback(
                ctx,
                capture,
                signal,
                (comment) =>
                  manager.addFeedback(capture.captureId, comment, {
                    height: capture.image.height,
                    width: capture.image.width,
                    x: 0,
                    y: 0,
                  }),
              );
              return {
                captureId: capture.captureId,
                ...fallback,
              };
            }
            const panelInput = await embedFeedbackImage(
              comparison && before
                ? comparisonPanelInput(comparison, before, capture)
                : feedbackPanelInput(capture),
            );
            const message = await waitForFeedbackPanel(
              glimpse,
              renderFeedbackPanel(panelInput),
              {
                height: 840,
                timeout: 10 * 60 * 1000,
                title: comparison ? "Visual comparison" : "Visual feedback",
                width: comparison ? 1280 : 1000,
              },
              signal,
              registerClose,
            );
            const outcome = validateFeedbackBridgeMessage(
              message,
              capture.image,
              Boolean(comparison),
            );
            if (outcome.status === "cancelled")
              return {
                ...binding,
                status: outcome.status,
              } as const;
            if (outcome.status === "accepted")
              return {
                ...binding,
                status: outcome.status,
              } as const;
            return {
              ...binding,
              feedback: manager.addFeedback(
                capture.captureId,
                outcome.draft.comment,
                outcome.draft.region,
                comparison?.comparisonId,
              ),
              status: outcome.status,
            } as const;
          },
        );
        return {
          details: result,
          content: [
            {
              text: JSON.stringify(result),
              type: "text" as const,
            },
          ],
        };
      } catch (error) {
        throw new Error(`visual_feedback failed: ${toolErrorMessage(error)}`);
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Waiting for visual feedback..."), 0, 0);
      const details = result.details as
        | {
            captureId?: string;
            comparisonId?: string;
            status: "accepted" | "busy" | "cancelled" | "submitted" | "unavailable";
          }
        | undefined;
      if (!details) return new Text(theme.fg("error", "Feedback failed"), 0, 0);
      let color: "success" | "warning" = "warning";
      if (details.status === "accepted" || details.status === "submitted")
        color = "success";
      return new Text(
        theme.fg(
          color,
          `[${details.status}] ${details.comparisonId ?? details.captureId ?? "visual-feedback"}`,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    description:
      "Capture the current viewport and optional unique visible selector without navigating, scrolling, or resizing.",
    label: "Capture local visual evidence",
    name: "visual_capture",
    parameters: CaptureParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const capture = await manager.capture(ctx, params, _signal);
        return {
          content: [
            ...(await captureContent(capture)),
          ],
          details: {
            captureId: capture.captureId,
            ok: true,
            readiness: capture.readiness.status,
          },
        };
      } catch (error) {
        throw new Error(`visual_capture failed: ${toolErrorMessage(error)}`);
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Capturing..."), 0, 0);
      const details = result.details as
        | {
            captureId: string;
            readiness: "degraded" | "ready";
          }
        | undefined;
      if (!details) return new Text(theme.fg("error", "Capture failed"), 0, 0);
      const color = details.readiness === "ready" ? "success" : "warning";
      return new Text(
        theme.fg(color, `[${details.readiness}] ${details.captureId}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    description:
      "Compare a baseline capture with a new capture in the same local visual context.",
    label: "Verify local visual change",
    name: "visual_verify",
    parameters: VerifyParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await manager.verify(
          ctx,
          params.baselineCaptureId,
          {
            stateLabel: params.stateLabel,
          },
          _signal,
        );
        return {
          content: await verifyContent(result, {
            includeViewportImages: params.includeViewportImages,
          }),
          details: result.comparison,
        };
      } catch (error) {
        throw new Error(`visual_verify failed: ${toolErrorMessage(error)}`);
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Verifying visual change..."), 0, 0);
      const details = result.details as
        | {
            comparisonId: string;
            status: "comparable" | "not-comparable";
          }
        | undefined;
      if (!details)
        return new Text(theme.fg("error", "Visual verification failed"), 0, 0);
      const color = details.status === "comparable" ? "success" : "warning";
      return new Text(
        theme.fg(color, `[${details.status}] ${details.comparisonId}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    description:
      "Compose two existing captures into one comparison for choosing between design versions.",
    label: "Compare two local visual versions",
    name: "visual_compare",
    parameters: CompareParameters,
    async execute(_toolCallId, params) {
      try {
        // The schema pins labels to two entries; the tuple keeps compare honest.
        const labels:
          | [
              string,
              string,
            ]
          | undefined = params.labels
          ? [
              params.labels[0],
              params.labels[1],
            ]
          : undefined;
        const result = manager.compare(
          params.leftCaptureId,
          params.rightCaptureId,
          labels,
        );
        return {
          content: await compareContent(result),
          details: result.comparison,
        };
      } catch (error) {
        throw new Error(`visual_compare failed: ${toolErrorMessage(error)}`);
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Comparing visual versions..."), 0, 0);
      const details = result.details as
        | {
            comparisonId: string;
            mode: "regression" | "variant";
          }
        | undefined;
      if (!details)
        return new Text(theme.fg("error", "Visual comparison failed"), 0, 0);
      return new Text(
        theme.fg("success", `[${details.mode}] ${details.comparisonId}`),
        0,
        0,
      );
    },
  });

  void VERSION;
}
