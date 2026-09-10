import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VisualLoopConfig } from "../src/visual-loop/config.ts";
import { cropParentOffset } from "../src/visual-loop/context.ts";
import { createPrivateHarnessDirs, runCapture } from "../src/visual-loop/harness.ts";

const roots: string[] = [];

async function fakeHarness(result: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xpi-capture-test-"));
  roots.push(directory);
  const path = join(directory, "harness.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(result))}));`,
  );
  await chmod(path, 0o700);
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

const request = {
  action: "capture" as const,
  imagePath: "/tmp/owned.png",
  selector: "[data-value='a\\n\"b']",
  targetId: "target-a",
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    dpr: 1,
    endedAt: "2026-09-09T00:00:01.000Z",
    ok: true,
    protocolVersion: 1,
    startedAt: "2026-09-09T00:00:00.000Z",
    targetId: "target-a",
    image: {
      height: 600,
      path: "/tmp/owned.png",
      rawHeight: 600,
      rawWidth: 800,
      temporaryByteLength: 128,
      width: 800,
    },
    pageAfter: {
      h: 600,
      ph: 600,
      pw: 800,
      sx: 0,
      sy: 0,
      title: "Page",
      url: "http://127.0.0.1:8765/",
      w: 800,
    },
    pageBefore: {
      h: 600,
      ph: 600,
      pw: 800,
      sx: 0,
      sy: 0,
      title: "Page",
      url: "http://127.0.0.1:8765/",
      w: 800,
    },
    readiness: {
      reasons: [],
      status: "ready",
    },
    target: {
      selector: request.selector,
      text: "Example",
      accessibility: {
        label: "Example",
        role: "button",
      },
      bounds: {
        height: 40,
        width: 100,
        x: 20,
        y: 30,
      },
      styles: {
        color: "rgb(0, 0, 0)",
        display: "block",
      },
      visibleBounds: {
        height: 40,
        width: 100,
        x: 20,
        y: 30,
      },
    },
    ...overrides,
  };
}

async function run(value: unknown, allowTargetFailure = false) {
  const harnessPath = await fakeHarness(value);
  const dirs = await createPrivateHarnessDirs();
  roots.push(dirs.root);
  const config: VisualLoopConfig = {
    cdpUrl: "http://127.0.0.1:9333/",
    harnessPath,
  };
  return runCapture(config, dirs, {
    ...request,
    ...(allowTargetFailure
      ? {
          allowTargetFailure: true,
        }
      : {}),
  });
}

describe("capture Harness protocol", () => {
  it("accepts bounded capture metadata and preserves selector data literally", async () => {
    const captured = await run(result());
    expect(captured.diagnostics.console.status).toBe("unknown");
    const observedEmpty = await run(
      result({
        diagnostics: {
          console: {
            entries: [],
            status: "observed",
            truncated: false,
          },
          network: {
            entries: [],
            status: "observed",
            truncated: false,
          },
        },
      }),
    );
    expect(observedEmpty.diagnostics.console).toMatchObject({
      entries: [],
      status: "observed",
    });
    expect(captured.target?.selector).toBe(request.selector);
    expect(captured.readiness.status).toBe("ready");
  });

  it("accepts degraded images but rejects failed or malformed capture results", async () => {
    const degraded = await run(
      result({
        readiness: {
          status: "degraded",
          reasons: [
            "visible images not ready",
          ],
        },
      }),
    );
    expect(degraded.readiness.status).toBe("degraded");
    await expect(
      run(
        result({
          image: undefined,
        }),
      ),
    ).rejects.toThrow("image");
    await expect(
      run(
        result({
          target: {
            error: "multiple-matches",
          },
        }),
      ),
    ).rejects.toThrow("multiple-matches");
  });

  it("preserves the viewport image when verify explicitly allows a missing target", async () => {
    const captured = await run(
      result({
        target: {
          error: "no-match",
        },
      }),
      true,
    );
    expect(captured.image.path).toBe("/tmp/owned.png");
    expect(captured.target).toBeUndefined();
  });
  it("keeps crop coordinates and diagnostic status bounded", async () => {
    const captured = await run(
      result({
        diagnostics: {
          console: {
            observedFrom: "2026-09-09T00:00:00.000Z",
            observedTo: "2026-09-09T00:00:01.000Z",
            status: "observed",
            truncated: false,
            entries: [
              {
                kind: "console",
                message: "console error",
              },
            ],
          },
          network: {
            entries: [],
            status: "unknown",
            truncated: false,
          },
        },
        image: {
          height: 600,
          path: "/tmp/owned.png",
          rawHeight: 1200,
          rawWidth: 1600,
          temporaryByteLength: 512,
          width: 800,
          crop: {
            height: 80,
            path: "/tmp/target.png",
            width: 100,
            x: 20,
            y: 30,
            sourceRegion: {
              height: 40,
              width: 100,
              x: 20,
              y: 30,
            },
          },
        },
      }),
    );
    expect(captured.image.crop?.parentOffset).toEqual({
      x: 20,
      y: 30,
    });
    expect(captured.image.rawWidth).toBe(1600);
    expect(captured.image.temporaryByteLength).toBe(512);
    expect(captured.diagnostics.console.entries).toHaveLength(1);
    expect(captured.diagnostics.network.status).toBe("unknown");
  });
  it("redacts diagnostic messages, strips URL details, and preserves bounded truncation", async () => {
    const entries = Array.from(
      {
        length: 20,
      },
      (_, index) => ({
        kind: "network",
        message:
          index === 0
            ? 'Authorization: Bearer secret password="value"'
            : `HTTP ${500 + index}`,
        status: 500 + index,
        url: "https://example.test/private?token=secret",
      }),
    );
    const captured = await run(
      result({
        diagnostics: {
          console: {
            status: "observed",
            truncated: false,
            entries: [
              {
                kind: "console",
                message: 'password="secret" Bearer abc',
              },
            ],
          },
          network: {
            entries,
            status: "observed",
            truncated: true,
          },
        },
      }),
    );
    expect(captured.diagnostics.console.entries[0].message).toBe(
      "password=[redacted] Bearer [redacted]",
    );
    expect(captured.diagnostics.network.entries).toHaveLength(20);
    expect(captured.diagnostics.network.truncated).toBe(true);
    expect(captured.diagnostics.network.entries[0].url).toBe("https://example.test");
  });
});

describe("crop coordinate mapping", () => {
  it.each([
    {
      dpr: 1,
      exportWidth: 640,
      rawWidth: 640,
      viewportWidth: 640,
      x: 17.25,
    },
    {
      dpr: 2,
      exportWidth: 1280,
      rawWidth: 1280,
      viewportWidth: 640,
      x: 17.25,
    },
    {
      dpr: 2,
      exportWidth: 2000,
      rawWidth: 2880,
      viewportWidth: 1440,
      x: 317.3,
    },
    {
      dpr: 2,
      exportWidth: 2000,
      rawWidth: 2880,
      viewportWidth: 1440,
      x: 0,
    },
  ])(
    "keeps DPR $dpr and scaled crop round trips within one export pixel",
    ({ exportWidth, rawWidth, viewportWidth, x }) => {
      const rawOffset = Math.floor(x * (rawWidth / viewportWidth));
      const offset = cropParentOffset(
        {
          x: rawOffset,
          y: rawOffset,
        },
        {
          height: exportWidth,
          rawHeight: rawWidth,
          rawWidth,
          width: exportWidth,
        },
      );
      const expected = x * (exportWidth / viewportWidth);
      expect(Math.abs(offset.x - expected)).toBeLessThanOrEqual(1);
      expect(Math.abs(offset.y - expected)).toBeLessThanOrEqual(1);
    },
  );
});
