import { describe, expect, it } from "vitest";
import type { Capture } from "../src/visual-loop/evidence.ts";
import {
  commonViewportRegion,
  compareCaptureConditions,
  summarizeTargetChanges,
} from "../src/visual-loop/evidence.ts";

function capture(overrides: Partial<Capture> = {}): Capture {
  return {
    captureId: "capture-a",
    dpr: 1,
    endedAt: "2026-09-09T00:00:01.000Z",
    inspectionId: "inspection-a",
    sessionEpoch: 1,
    startedAt: "2026-09-09T00:00:00.000Z",
    stateLabel: "initial",
    targetId: "target-a",
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
      height: 600,
      path: "/tmp/capture.png",
      width: 800,
      coordinateScale: {
        x: 1,
        y: 1,
      },
      raw: {
        byteLength: 3,
        height: 600,
        width: 800,
      },
      sourceRegion: {
        height: 600,
        width: 800,
        x: 0,
        y: 0,
      },
    },
    page: {
      height: 600,
      scrollX: 0,
      scrollY: 0,
      title: "Page",
      url: "http://127.0.0.1:8765/",
      width: 800,
    },
    readiness: {
      reasons: [],
      status: "ready",
    },
    viewport: {
      height: 600,
      width: 800,
    },
    ...overrides,
  };
}

describe("target change and common-region summaries", () => {
  it("summarizes bounds and style changes without making them comparison failures", () => {
    const before = capture({
      target: {
        accessibility: {},
        selector: "#target",
        bounds: {
          height: 40,
          width: 100,
          x: 20,
          y: 30,
        },
        styles: {
          color: "black",
          fontSize: "16px",
        },
        visibleBounds: {
          height: 40,
          width: 100,
          x: 20,
          y: 30,
        },
      },
    });
    const after = capture({
      captureId: "capture-b",
      target: {
        accessibility: {},
        selector: "#target",
        bounds: {
          height: 80,
          width: 160,
          x: 40,
          y: 60,
        },
        styles: {
          color: "white",
          fontSize: "20px",
        },
        visibleBounds: {
          height: 80,
          width: 160,
          x: 40,
          y: 60,
        },
      },
    });

    expect(summarizeTargetChanges(before.target, after.target)).toMatchObject({
      status: "changed",
      changedFields: [
        "bounds",
        "visibleBounds",
        "styles.color",
        "styles.fontSize",
      ],
    });
    expect(compareCaptureConditions(before, after)).toEqual([]);
  });

  it("reports a missing target and clips the union to the viewport", () => {
    const before = capture({
      target: {
        accessibility: {},
        selector: "#target",
        styles: {},
        bounds: {
          height: 40,
          width: 100,
          x: -20,
          y: 30,
        },
        visibleBounds: {
          height: 40,
          width: 20,
          x: 0,
          y: 30,
        },
      },
    });
    const after = capture({
      captureId: "capture-b",
      target: undefined,
    });

    expect(summarizeTargetChanges(before.target, after.target)).toMatchObject({
      changedFields: [],
      status: "missing",
    });
    const moved = capture({
      captureId: "capture-c",
      target: {
        accessibility: {},
        selector: "#target",
        styles: {},
        bounds: {
          height: 40,
          width: 40,
          x: 790,
          y: 30,
        },
        visibleBounds: {
          height: 40,
          width: 20,
          x: 790,
          y: 30,
        },
      },
    });
    expect(
      commonViewportRegion(before.target, moved.target, {
        height: 600,
        width: 800,
        x: 0,
        y: 0,
      }),
    ).toMatchObject({
      clipped: true,
      region: {
        height: 40,
        width: 800,
        x: 0,
        y: 30,
      },
    });
  });
});

describe("compareCaptureConditions", () => {
  it("accepts matching conditions and ignores target layout changes", () => {
    const before = capture({
      target: {
        selector: "#target",
        accessibility: {
          role: "button",
        },
        bounds: {
          height: 40,
          width: 100,
          x: 20,
          y: 30,
        },
        styles: {
          color: "black",
        },
        visibleBounds: {
          height: 40,
          width: 100,
          x: 20,
          y: 30,
        },
      },
    });
    const after = capture({
      captureId: "capture-b",
      target: {
        selector: "#target",
        accessibility: {
          role: "button",
        },
        bounds: {
          height: 80,
          width: 160,
          x: 40,
          y: 60,
        },
        styles: {
          color: "white",
        },
        visibleBounds: {
          height: 80,
          width: 160,
          x: 40,
          y: 60,
        },
      },
    });

    expect(compareCaptureConditions(before, after)).toEqual([]);
  });

  it("reports every changed comparison condition with a concrete reason", () => {
    const before = capture();
    const after = capture({
      captureId: "capture-b",
      dpr: 2,
      stateLabel: "dialog-open",
      page: {
        ...before.page,
        scrollY: 40,
        url: "http://127.0.0.1:8765/changed",
      },
      viewport: {
        height: 700,
        width: 900,
      },
    });

    expect(compareCaptureConditions(before, after)).toEqual([
      "page URL changed",
      "viewport changed",
      "device pixel ratio changed",
      "scroll position changed",
      "declared interaction state changed",
    ]);
  });

  it("rejects different evidence contexts and unstable resources", () => {
    const before = capture();
    const after = capture({
      captureId: "capture-b",
      inspectionId: "inspection-b",
      targetId: "target-b",
      readiness: {
        status: "degraded",
        reasons: [
          "fonts not ready",
        ],
      },
    });

    expect(compareCaptureConditions(before, after)).toEqual([
      "inspection context changed",
      "bound browser target changed",
      "after capture is degraded: fonts not ready",
    ]);
  });
});
