import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import xpiVisualoop, {
  CaptureParameters,
  CompareParameters,
  captureContent,
  compareContent,
  FeedbackParameters,
  feedbackQuestion,
  feedbackReference,
  MAX_VERIFY_IMAGE_BYTES,
  PrepareParameters,
  suppressedFeedbackResult,
  textComparisonFeedbackFallback,
  textFeedbackFallback,
  toolErrorMessage,
  unavailableFeedbackResult,
  VerifyParameters,
  verifyContent,
} from "../src/index.ts";
import type { LaunchForm, WindowState } from "../src/visual-loop/chrome.ts";
import { describeLaunch, VisualLoopManager } from "../src/visual-loop/context.ts";
import type { Capture, Comparison } from "../src/visual-loop/evidence.ts";

const roots: string[] = [];

/** What a headless context must say, and what a minimized one must not claim. */
const INVISIBLE_PAGE = /not visible/;
const FOREGROUND_CLAIM = /foreground|in front|has focus/i;

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
      "visual_compare",
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
    expect(
      feedback.Check({
        captureId: "capture-tool",
        question: "Which one?",
        options: [
          "B1",
          "B2",
        ],
      }),
    ).toBe(true);
    expect(
      feedback.Check({
        captureId: "capture-tool",
        options: [
          "only-one",
        ],
      }),
    ).toBe(false);
    expect(
      feedback.Check({
        captureId: "capture-tool",
        options: [
          "a",
          "b",
          "c",
          "d",
          "e",
        ],
      }),
    ).toBe(false);

    // A question and its options are one decision; half of it is refused.
    expect(
      feedbackQuestion({
        question: "Which one?",
        options: [
          "B1",
          "B2",
        ],
      }),
    ).toEqual({
      question: "Which one?",
      options: [
        "B1",
        "B2",
      ],
    });
    expect(feedbackQuestion({})).toBeUndefined();
    expect(() =>
      feedbackQuestion({
        question: "Which one?",
      }),
    ).toThrow("together");
    expect(() =>
      feedbackQuestion({
        options: [
          "B1",
          "B2",
        ],
      }),
    ).toThrow("together");

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

    const compare = Compile(CompareParameters);
    expect(
      compare.Check({
        leftCaptureId: "capture-left",
        rightCaptureId: "capture-right",
      }),
    ).toBe(true);
    expect(
      compare.Check({
        leftCaptureId: "capture-left",
        rightCaptureId: "capture-right",
        labels: [
          "B1",
          "B2",
        ],
      }),
    ).toBe(true);
    // A variant comparison names both sides or neither.
    expect(
      compare.Check({
        leftCaptureId: "capture-left",
        rightCaptureId: "capture-right",
        labels: [
          "B1",
        ],
      }),
    ).toBe(false);
    expect(
      compare.Check({
        leftCaptureId: "capture-left",
        rightCaptureId: "capture-right",
        labels: [
          "B1",
          "B2",
          "B3",
        ],
      }),
    ).toBe(false);
    expect(
      compare.Check({
        extra: true,
        leftCaptureId: "capture-left",
        rightCaptureId: "capture-right",
      }),
    ).toBe(false);
    expect(
      compare.Check({
        leftCaptureId: "capture-left",
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
    const compareRender = tools.find(
      (tool) => tool.name === "visual_compare",
    )?.renderResult;
    const compared = compareRender?.(
      {
        content: [],
        details: {
          comparisonId: "comparison-render",
          mode: "variant",
        },
      },
      {
        isPartial: false,
      },
      {
        fg: (_color: string, text: string) => text,
      },
    );
    expect(compared?.render(80).join("")).toContain("[variant] comparison-render");
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

describe("suppressed visual feedback", () => {
  it("returns the suppression instead of opening anything", () => {
    expect(
      suppressedFeedbackResult(false, {
        captureId: "capture-tool",
      }),
    ).toBeUndefined();
    expect(
      suppressedFeedbackResult(true, {
        captureId: "capture-tool",
      }),
    ).toEqual({
      captureId: "capture-tool",
      status: "suppressed",
    });
    // A comparison keeps its binding too: the caller asked about a version pair, and
    // the suppression answers that same reference.
    expect(
      suppressedFeedbackResult(true, {
        afterCaptureId: "capture-after",
        beforeCaptureId: "capture-before",
        comparisonId: "comparison-tool",
      }),
    ).toEqual({
      afterCaptureId: "capture-after",
      beforeCaptureId: "capture-before",
      comparisonId: "comparison-tool",
      status: "suppressed",
    });
  });
});

describe("visual verify tool output", () => {
  async function verifyFixture(bytes = 3) {
    const directory = await mkdtemp(join(tmpdir(), "xpi-verify-tool-test-"));
    roots.push(directory);
    const beforePath = join(directory, "before.png");
    const afterPath = join(directory, "after.png");
    const regionBeforePath = join(directory, "region-before.png");
    const regionAfterPath = join(directory, "region-after.png");
    // Distinct fill bytes so a leaked viewport image cannot masquerade as a region one.
    await Promise.all(
      [
        beforePath,
        afterPath,
        regionBeforePath,
        regionAfterPath,
      ].map((path, index) => writeFile(path, Buffer.alloc(bytes, index + 1))),
    );
    const before = capture(beforePath, {
      captureId: "capture-before",
    });
    const after = capture(afterPath, {
      captureId: "capture-after",
    });
    return {
      after,
      before,
      result: {
        after,
        before,
        comparison: {
          afterCaptureId: after.captureId,
          beforeCaptureId: before.captureId,
          comparisonId: "comparison-tool",
          reasons: [],
          status: "comparable",
          commonRegion: {
            clipped: false,
            after: {
              byteLength: bytes,
              height: 1,
              path: regionAfterPath,
              width: 1,
              sourceRegion: {
                height: 1,
                width: 1,
                x: 0,
                y: 0,
              },
            },
            before: {
              byteLength: bytes,
              height: 1,
              path: regionBeforePath,
              width: 1,
              sourceRegion: {
                height: 1,
                width: 1,
                x: 0,
                y: 0,
              },
            },
            region: {
              height: 1,
              width: 1,
              x: 0,
              y: 0,
            },
            sourceRegions: {
              after: {
                height: 1,
                width: 1,
                x: 0,
                y: 0,
              },
              before: {
                height: 1,
                width: 1,
                x: 0,
                y: 0,
              },
            },
          },
          diagnostics: {
            after: after.diagnostics,
            before: before.diagnostics,
          },
          targetChanges: {
            changedFields: [],
            status: "unchanged",
          },
        },
      } satisfies Awaited<ReturnType<VisualLoopManager["verify"]>>,
    };
  }

  it("defaults to the common region pair only", async () => {
    const { before, after, result } = await verifyFixture();
    const content = await verifyContent(result);

    expect(content).toHaveLength(5);
    expect(content[0].type).toBe("text");
    const labels = content
      .filter((item) => item.type === "text")
      .map((item) => item.text);
    expect(labels).toEqual([
      JSON.stringify(result.comparison),
      "before common region: comparison-tool",
      "after common region: comparison-tool",
    ]);

    const data = content
      .filter((item) => item.type === "image")
      .map((item) => item.data);
    expect(data).toHaveLength(2);
    expect(data).not.toContain(Buffer.alloc(3, 1).toString("base64"));
    expect(data).not.toContain(Buffer.alloc(3, 2).toString("base64"));
    void before;
    void after;
  });

  it("adds the viewport images only when the caller asks for them", async () => {
    const { before, after, result } = await verifyFixture();
    const content = await verifyContent(result, {
      includeViewportImages: true,
    });

    expect(content).toHaveLength(9);
    const labels = content
      .filter((item) => item.type === "text")
      .map((item) => item.text);
    expect(labels).toContain(`before viewport: ${before.captureId}`);
    expect(labels).toContain(`after viewport: ${after.captureId}`);
  });

  it("still returns text when no common region could be produced", async () => {
    const { result } = await verifyFixture();
    const cloned = structuredClone(result) as {
      comparison: {
        commonRegion?: unknown;
      };
    };
    cloned.comparison.commonRegion = undefined;
    const content = await verifyContent(cloned as typeof result);
    expect(content).toEqual([
      {
        text: JSON.stringify(cloned.comparison),
        type: "text",
      },
    ]);
  });

  it("fails loudly when the returned images exceed the byte budget", async () => {
    const { result } = await verifyFixture(MAX_VERIFY_IMAGE_BYTES + 1);
    await expect(verifyContent(result)).rejects.toThrow("byte budget");
  });
});

describe("visual compare tool output", () => {
  async function compareFixture(bytes = 3) {
    const directory = await mkdtemp(join(tmpdir(), "xpi-compare-tool-test-"));
    roots.push(directory);
    const leftPath = join(directory, "left.png");
    const rightPath = join(directory, "right.png");
    // Distinct fill bytes so a swapped side cannot pass unnoticed.
    await Promise.all([
      writeFile(leftPath, Buffer.alloc(bytes, 1)),
      writeFile(rightPath, Buffer.alloc(bytes, 2)),
    ]);
    const left = capture(leftPath, {
      captureId: "capture-left",
    });
    const right = capture(rightPath, {
      captureId: "capture-right",
    });
    return {
      left,
      right,
      result: {
        comparison: {
          afterCaptureId: right.captureId,
          beforeCaptureId: left.captureId,
          comparisonId: "comparison-tool",
          mode: "variant",
          status: "comparable",
          diagnostics: {
            after: right.diagnostics,
            before: left.diagnostics,
          },
          labels: [
            "B1 紧凑",
            "B2 宽松",
          ],
          reasons: [
            "page URL changed",
          ],
          targetChanges: {
            changedFields: [],
            status: "missing",
          },
        },
        left,
        right,
      } satisfies Awaited<ReturnType<VisualLoopManager["compare"]>>,
    };
  }

  it("returns both sides with their labels and never one without the other", async () => {
    const { result } = await compareFixture();
    const content = await compareContent(result);

    expect(content).toHaveLength(5);
    const labels = content
      .filter((item) => item.type === "text")
      .map((item) => item.text);
    expect(labels).toEqual([
      JSON.stringify(result.comparison),
      "left viewport: capture-left · B1 紧凑",
      "right viewport: capture-right · B2 宽松",
    ]);
    // The captions name the sides; before/after survives only as a storage field
    // name inside the comparison record, which the spec does not ask to rename.
    const captions = labels.slice(1);
    expect(captions.join(" ")).not.toContain("before");
    expect(captions.join(" ")).not.toContain("after");

    const data = content
      .filter((item) => item.type === "image")
      .map((item) => item.data);
    expect(data).toEqual([
      Buffer.alloc(3, 1).toString("base64"),
      Buffer.alloc(3, 2).toString("base64"),
    ]);
  });

  it("fails loudly over budget instead of delivering a single side", async () => {
    const { result } = await compareFixture(MAX_VERIFY_IMAGE_BYTES / 2 + 1);
    await expect(compareContent(result)).rejects.toThrow("byte budget");
  });
});

describe("launch declaration in the prepare result", () => {
  interface PreparePayload {
    interaction: string;
    launch: string;
    userOperable: boolean;
    windowState?: string;
  }

  async function preparePayload(
    launch: LaunchForm,
    windowState: WindowState,
  ): Promise<PreparePayload> {
    const tools = new Map<
      string,
      {
        execute: (...args: unknown[]) => Promise<{
          content: Array<{
            text: string;
          }>;
        }>;
      }
    >();
    xpiVisualoop({
      on() {},
      registerCommand() {},
      registerTool(tool: unknown) {
        const registered = tool as {
          name: string;
        };
        tools.set(registered.name, tool as never);
      },
    } as unknown as ExtensionAPI);
    const spy = vi.spyOn(VisualLoopManager.prototype, "prepare").mockResolvedValue({
      epoch: 1,
      launch,
      result: {
        dpr: 1,
        targetId: "target-1",
        page: {
          h: 600,
          ph: 600,
          pw: 800,
          sx: 0,
          sy: 0,
          title: "Page",
          url: "http://127.0.0.1:8765/",
          w: 800,
        },
      },
      windowState,
    });
    try {
      const response = await tools.get("visual_prepare")?.execute(
        "prepare-call",
        {
          url: "http://127.0.0.1:8765/",
        },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          signal: new AbortController().signal,
          isProjectTrusted: () => true,
        },
      );
      return JSON.parse(String(response?.content[0]?.text)) as PreparePayload;
    } finally {
      spy.mockRestore();
    }
  }

  it("reports the launch form and whether the user can operate the page", async () => {
    const headless = await preparePayload("headless", "unknown");
    expect(headless.launch).toBe("headless");
    expect(headless.userOperable).toBe(false);
    expect(headless.interaction).toMatch(INVISIBLE_PAGE);

    const minimized = await preparePayload("minimized", "minimized");
    expect(minimized.launch).toBe("minimized");
    expect(minimized.userOperable).toBe(true);
    expect(minimized.windowState).toBe("minimized");
    // The two forms must not read as the same context.
    expect(minimized.interaction).not.toBe(headless.interaction);

    const windowed = await preparePayload("windowed", "unknown");
    expect(windowed.userOperable).toBe(true);
    expect(windowed.interaction).not.toBe(minimized.interaction);
  });

  it("routes a minimized window back to the user without claiming it is in front", () => {
    const minimized = describeLaunch("minimized", "minimized");
    expect(minimized.interaction).toContain("minimized");
    expect(minimized.interaction).toContain("Dock");
    expect(minimized.interaction).toContain("taskbar");
    expect(minimized.interaction).not.toMatch(FOREGROUND_CLAIM);

    // An unconfirmed minimization must not be described as one.
    const unknown = describeLaunch("minimized", "unknown");
    expect(unknown.interaction).toContain("unknown");
    expect(unknown.interaction).not.toContain("window is minimized");
  });
});
