import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import xpiVisualoop, {
  CaptureParameters,
  captureContent,
  FeedbackParameters,
  feedbackReference,
  PrepareParameters,
  textComparisonFeedbackFallback,
  textFeedbackFallback,
  toolErrorMessage,
  unavailableFeedbackResult,
  VerifyParameters,
} from "../src/index.ts";
import type { Capture, Comparison } from "../src/visual-loop/evidence.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) =>
      rm(path, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

function capture(path: string, overrides: Partial<Capture> = {}): Capture {
  return {
    captureId: "capture-tool",
    dpr: 2,
    endedAt: "2026-09-09T00:00:01.000Z",
    inspectionId: "inspection-tool",
    sessionEpoch: 1,
    startedAt: "2026-09-09T00:00:00.000Z",
    targetId: "target-tool",
    diagnostics: {
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
    },
    image: {
      byteLength: 3,
      height: 2,
      coordinateScale: {
        x: 2,
        y: 2,
      },
      raw: {
        byteLength: 4,
        height: 2,
        width: 2,
      },
      path,
      width: 2,
      sourceRegion: {
        height: 1,
        width: 1,
        x: 0,
        y: 0,
      },
    },
    page: {
      height: 1,
      scrollX: 0,
      scrollY: 0,
      title: "Page",
      url: "http://127.0.0.1:8765/",
      width: 1,
    },
    readiness: {
      reasons: [],
      status: "ready",
    },
    viewport: {
      height: 1,
      width: 1,
    },
    ...overrides,
  };
}

describe("visual tool registration", () => {
  it("registers prepare and capture with strict bounded schemas", () => {
    const tools: Array<{
      name: string;
      renderResult?: (...args: unknown[]) => {
        render(width: number): string[];
      };
    }> = [];
    xpiVisualoop({
      on() {},
      registerCommand() {},
      registerTool(tool: unknown) {
        tools.push(
          tool as {
            name: string;
            renderResult?: (...args: unknown[]) => {
              render(width: number): string[];
            };
          },
        );
      },
    } as unknown as ExtensionAPI);
    expect(tools.map((tool) => tool.name)).toEqual([
      "visual_prepare",
      "visual_feedback",
      "visual_capture",
      "visual_verify",
    ]);

    const prepare = Compile(PrepareParameters);
    expect(
      prepare.Check({
        dpr: 2,
        url: "http://127.0.0.1:8766/",
        viewport: {
          height: 240,
          width: 320,
        },
      }),
    ).toBe(true);
    expect(
      prepare.Check({
        extra: true,
        url: "http://127.0.0.1:8766/",
      }),
    ).toBe(false);
    expect(
      prepare.Check({
        dpr: 2.1,
        url: "http://127.0.0.1:8766/",
      }),
    ).toBe(false);

    const capture = Compile(CaptureParameters);
    expect(
      capture.Check({
        selector: "#target",
        stateLabel: "dialog-open",
      }),
    ).toBe(true);
    expect(
      capture.Check({
        extra: true,
        selector: "",
      }),
    ).toBe(false);

    const feedback = Compile(FeedbackParameters);
    expect(
      feedback.Check({
        captureId: "capture-tool",
      }),
    ).toBe(true);
    expect(
      feedback.Check({
        captureId: "capture-tool",
        extra: true,
      }),
    ).toBe(false);
    expect(
      feedback.Check({
        comparisonId: "comparison-tool",
      }),
    ).toBe(true);
    expect(() => feedbackReference({})).toThrow("exactly one");
    expect(() =>
      feedbackReference({
        captureId: "capture-tool",
        comparisonId: "comparison-tool",
      }),
    ).toThrow("exactly one");

    const verify = Compile(VerifyParameters);
    expect(
      verify.Check({
        baselineCaptureId: "capture-tool",
        stateLabel: "dialog-open",
      }),
    ).toBe(true);
    expect(
      verify.Check({
        baselineCaptureId: "capture-tool",
        extra: true,
      }),
    ).toBe(false);

    const renderResult = tools.find(
      (tool) => tool.name === "visual_capture",
    )?.renderResult;
    const component = renderResult?.(
      {
        content: [],
        details: {
          captureId: "capture-render",
          readiness: "degraded",
        },
      },
      {
        isPartial: false,
      },
      {
        fg: (_color: string, text: string) => text,
      },
    );
    expect(component?.render(80).join("")).toContain("[degraded] capture-render");
  });
});
describe("visual tool errors", () => {
  it("redacts and bounds tool errors to 4 KiB", () => {
    const message = toolErrorMessage(
      new Error(
        `Authorization: Bearer super-secret password=value ${"界".repeat(5000)}`,
      ),
    );
    expect(message).not.toContain("super-secret");
    expect(message).not.toContain("password=value");
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(4 * 1024);
  });
});

describe("visual capture tool output", () => {
  it("returns the registered PNG bytes as an image content block", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xpi-tool-test-"));
    roots.push(directory);
    const path = join(directory, "capture.png");
    await writeFile(
      path,
      Buffer.from([
        137,
        80,
        78,
      ]),
    );

    const content = await captureContent(capture(path));

    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({
      data: Buffer.from([
        137,
        80,
        78,
      ]).toString("base64"),
      mimeType: "image/png",
      type: "image",
    });
    expect(content[0].type).toBe("text");
  });
  it("rejects capture text over 16 KiB before reading image bytes", async () => {
    const oversized = capture("/missing.png");
    oversized.target = {
      accessibility: {},
      selector: "#target",
      styles: {},
      text: "x".repeat(17 * 1024),
      bounds: {
        height: 1,
        width: 1,
        x: 0,
        y: 0,
      },
      visibleBounds: {
        height: 1,
        width: 1,
        x: 0,
        y: 0,
      },
    };
    await expect(captureContent(oversized)).rejects.toThrow("text budget");
  });

  describe("text feedback fallback", () => {
    it("submits the full image region after confirmation", async () => {
      const calls: string[] = [];
      const result = await textFeedbackFallback(
        {
          ui: {
            confirm: async () => {
              calls.push("confirm");
              return true;
            },
            input: async () => {
              calls.push("input");
              return "Fix the whole layout";
            },
          },
        } as never,
        capture("/tmp/capture-fallback.png"),
        undefined,
        (comment) =>
          ({
            comment,
          }) as never,
      );
      expect(result.status).toBe("submitted");
      expect(result.scope).toBe("entire-screenshot");
      expect(result.imagePath).toBe("/tmp/capture-fallback.png");
      expect(calls).toEqual([
        "input",
        "confirm",
      ]);
    });

    it("distinguishes cancelled input and unavailable interaction", async () => {
      const result = await textFeedbackFallback(
        {
          ui: {
            confirm: async () => true,
            input: async () => undefined,
          },
        } as never,
        capture("/tmp/capture-cancelled.png"),
        undefined,
        () => undefined as never,
      );
      expect(result).toEqual({
        imagePath: "/tmp/capture-cancelled.png",
        scope: "entire-screenshot",
        status: "cancelled",
      });
      expect(
        unavailableFeedbackResult("capture-unavailable", "/tmp/missing.png"),
      ).toEqual({
        captureId: "capture-unavailable",
        imagePath: "/tmp/missing.png",
        scope: "entire-screenshot",
        status: "unavailable",
      });
    });

    it("binds accepted, submitted, and cancelled comparison results to one version", async () => {
      const before = capture("/tmp/before.png", {
        captureId: "capture-before",
      });
      const after = capture("/tmp/after.png", {
        captureId: "capture-after",
      });
      const comparison = {
        afterCaptureId: after.captureId,
        beforeCaptureId: before.captureId,
        comparisonId: "comparison-tool",
        reasons: [],
        status: "comparable",
        diagnostics: {
          after: after.diagnostics,
          before: before.diagnostics,
        },
        targetChanges: {
          changedFields: [],
          status: "unchanged",
        },
      } satisfies Comparison;
      const context = (action: string | undefined) =>
        ({
          ui: {
            confirm: async () => true,
            input: async () => "Adjust the after image",
            select: async () => action,
          },
        }) as never;
      const addFeedback = (comment: string) =>
        ({
          captureId: after.captureId,
          comment,
          comparisonId: comparison.comparisonId,
          sourceImageId: after.captureId,
        }) as never;
      const accepted = await textComparisonFeedbackFallback(
        context("Accept this result"),
        comparison,
        before,
        after,
        undefined,
        addFeedback,
      );
      expect(accepted).toMatchObject({
        afterCaptureId: after.captureId,
        beforeCaptureId: before.captureId,
        comparisonId: comparison.comparisonId,
        status: "accepted",
      });
      const submitted = await textComparisonFeedbackFallback(
        context("Submit feedback on after image"),
        comparison,
        before,
        after,
        undefined,
        addFeedback,
      );
      expect(submitted).toMatchObject({
        afterCaptureId: after.captureId,
        beforeCaptureId: before.captureId,
        comparisonId: comparison.comparisonId,
        status: "submitted",
        feedback: {
          captureId: after.captureId,
          comparisonId: comparison.comparisonId,
          sourceImageId: after.captureId,
        },
      });
      const cancelled = await textComparisonFeedbackFallback(
        context(undefined),
        comparison,
        before,
        after,
        undefined,
        addFeedback,
      );
      expect(cancelled).toMatchObject({
        afterCaptureId: after.captureId,
        beforeCaptureId: before.captureId,
        comparisonId: comparison.comparisonId,
        status: "cancelled",
      });
    });
  });
});
