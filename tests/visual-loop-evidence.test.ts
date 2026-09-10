import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Capture,
  EvidenceStore,
  validateComparison,
  validateFeedback,
} from "../src/visual-loop/evidence.ts";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "xpi-evidence-test-"));
  roots.push(path);
  return path;
}

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

function capture(imagePath: string, overrides: Partial<Capture> = {}): Capture {
  return {
    captureId: "capture-test",
    dpr: 1,
    endedAt: "2026-09-09T00:00:01.000Z",
    inspectionId: "inspection-test",
    sessionEpoch: 1,
    startedAt: "2026-09-09T00:00:00.000Z",
    targetId: "target-test",
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
      height: 1,
      path: imagePath,
      width: 1,
      coordinateScale: {
        x: 1,
        y: 1,
      },
      raw: {
        byteLength: 1,
        height: 1,
        width: 1,
      },
      sourceRegion: {
        height: 1,
        width: 1,
        x: 0,
        y: 0,
      },
    },
    page: {
      height: 600,
      scrollX: 0,
      scrollY: 0,
      title: "test",
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

describe("session evidence store", () => {
  it("keeps captures immutable, unique, and scoped to one epoch", async () => {
    const directory = await root();
    const imagePath = join(directory, "capture.png");
    await writeFile(imagePath, "png");
    const store = new EvidenceStore(directory, 1);

    const first = await store.addCapture(capture(imagePath));
    expect(Object.isFrozen(first)).toBe(true);
    await expect(store.addCapture(capture(imagePath))).rejects.toThrow(
      "already exists",
    );
    expect(store.getCapture(first.captureId, 2)).toEqual({
      status: "wrong-session",
    });
    expect(store.getCapture(first.captureId, 1)).toEqual({
      capture: first,
      status: "available",
    });
  });

  it("rejects traversal, symlinks, and capacity overflow without evicting evidence", async () => {
    const directory = await root();
    const outside = join(await root(), "outside.png");
    await writeFile(outside, "png");
    const link = join(directory, "link.png");
    await symlink(outside, link);
    const store = new EvidenceStore(directory, 1, {
      maxBytes: 7,
      maxCaptures: 2,
    });

    await expect(store.addCapture(capture(outside))).rejects.toThrow(
      "owned evidence directory",
    );
    await expect(store.addCapture(capture(link))).rejects.toThrow("symbolic link");

    const imagePath = join(directory, "capture.png");
    await writeFile(imagePath, "png");
    const first = await store.addCapture(capture(imagePath));
    const secondPath = join(directory, "second.png");
    await writeFile(secondPath, "png");
    await expect(
      store.addCapture(
        capture(secondPath, {
          captureId: "capture-second",
        }),
      ),
    ).rejects.toThrow("capacity");
    expect(store.getCapture(first.captureId, 1).status).toBe("available");

    const feedback = store.addFeedback(
      {
        captureId: first.captureId,
        comment: "Keep this baseline",
        feedbackId: "feedback-first",
        sourceImageId: first.captureId,
        submittedAt: "2026-09-09T00:00:00.000Z",
        region: {
          height: 1,
          width: 1,
          x: 0,
          y: 0,
        },
      },
      1,
    );
    expect(Object.isFrozen(feedback)).toBe(true);
    const comparison = store.addComparison(
      {
        beforeCaptureId: first.captureId,
        comparisonId: "comparison-first",
        status: "not-comparable",
        reasons: [
          "after capture failed",
        ],
      },
      1,
    );
    expect(Object.isFrozen(comparison)).toBe(true);
    expect(store.getCapture(first.captureId, 1).status).toBe("available");
    expect(() => store.addComparison(comparison, 1)).toThrow("already exists");
  });
});

describe("feedback and comparison validation", () => {
  it("accepts minimal valid records and rejects malformed references", () => {
    expect(
      validateFeedback({
        captureId: "capture-a",
        comment: "Move this",
        feedbackId: "feedback-a",
        sourceImageId: "capture-a",
        submittedAt: "2026-09-09T00:00:00.000Z",
        region: {
          height: 10,
          width: 20,
          x: 1,
          y: 2,
        },
      }).feedbackId,
    ).toBe("feedback-a");
    expect(() =>
      validateFeedback({
        captureId: "capture-a",
        comment: " ",
        feedbackId: "feedback-a",
        sourceImageId: "capture-a",
        submittedAt: "invalid",
        region: {
          height: 0,
          width: 20,
          x: 1,
          y: 2,
        },
      }),
    ).toThrow();

    expect(
      validateComparison({
        afterCaptureId: "capture-b",
        beforeCaptureId: "capture-a",
        comparisonId: "comparison-a",
        reasons: [],
        status: "comparable",
      }).comparisonId,
    ).toBe("comparison-a");
    expect(() =>
      validateComparison({
        beforeCaptureId: "capture-a",
        comparisonId: "comparison-a",
        reasons: [],
        status: "comparable",
      }),
    ).toThrow("afterCaptureId");
  });

  it("binds comparison feedback only to its immutable after capture", async () => {
    const directory = await root();
    const beforePath = join(directory, "before.png");
    const afterPath = join(directory, "after.png");
    await writeFile(beforePath, "png");
    await writeFile(afterPath, "png");
    const store = new EvidenceStore(directory, 1);
    const before = await store.addCapture(capture(beforePath));
    const after = await store.addCapture(
      capture(afterPath, {
        captureId: "capture-after",
      }),
    );
    const comparison = store.addComparison(
      {
        afterCaptureId: after.captureId,
        beforeCaptureId: before.captureId,
        comparisonId: "comparison-bound",
        reasons: [],
        status: "comparable",
      },
      1,
    );
    expect(store.getComparison(comparison.comparisonId, 1)).toEqual({
      comparison,
      status: "available",
    });
    expect(
      store.addFeedback(
        {
          captureId: after.captureId,
          comment: "Adjust the after version",
          comparisonId: comparison.comparisonId,
          feedbackId: "feedback-after",
          sourceImageId: after.captureId,
          submittedAt: "2026-09-09T00:00:00.000Z",
          region: {
            height: 1,
            width: 1,
            x: 0,
            y: 0,
          },
        },
        1,
      ),
    ).toMatchObject({
      captureId: after.captureId,
      comparisonId: comparison.comparisonId,
      sourceImageId: after.captureId,
    });
    expect(() =>
      store.addFeedback(
        {
          captureId: before.captureId,
          comment: "Wrong version",
          comparisonId: comparison.comparisonId,
          feedbackId: "feedback-wrong",
          sourceImageId: before.captureId,
          submittedAt: "2026-09-09T00:00:00.000Z",
          region: {
            height: 1,
            width: 1,
            x: 0,
            y: 0,
          },
        },
        1,
      ),
    ).toThrow("after capture");
  });
});
