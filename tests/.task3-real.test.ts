import { readdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import xpiVisualoop from "../src/index.ts";
import { VisualLoopManager } from "../src/visual-loop/context.ts";

const root = process.env.TASK3_REAL_ROOT;
const cdpUrl = process.env.TASK3_CDP_URL;
type TestContext = Parameters<VisualLoopManager["prepare"]>[0];

function context(): TestContext {
  return {
    cwd: root,
    isProjectTrusted: () => true,
  } as TestContext;
}

const managers = new Set<VisualLoopManager>();

function trackedManager(): VisualLoopManager {
  const manager = new VisualLoopManager();
  managers.add(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(
    [
      ...managers,
    ].map((manager) => manager.disconnect()),
  );
  managers.clear();
});

interface RegisteredTool {
  execute: (...args: unknown[]) => Promise<{
    content: Array<Record<string, unknown>>;
  }>;
  name: string;
}

describe.skipIf(!root)("Task 3 real Chrome capture", () => {
  it("executes registered prepare and capture tools without a UI context", async () => {
    const tools = new Map<string, RegisteredTool>();
    let reset: (() => Promise<void>) | undefined;
    xpiVisualoop({
      on(_event: unknown, handler: unknown) {
        reset ??= handler as () => Promise<void>;
      },
      registerCommand() {},
      registerTool(tool: unknown) {
        const registered = tool as RegisteredTool;
        tools.set(registered.name, registered);
      },
    } as unknown as ExtensionAPI);
    const signal = new AbortController().signal;
    try {
      await tools.get("visual_prepare")?.execute(
        "prepare-call",
        {
          url: "http://127.0.0.1:8766/stable.html",
          viewport: {
            height: 360,
            width: 640,
          },
        },
        signal,
        undefined,
        context(),
      );
      const result = await tools.get("visual_capture")?.execute(
        "capture-call",
        {
          selector: "#stable",
        },
        signal,
        undefined,
        context(),
      );
      const text = result?.content.find((item) => item.type === "text")?.text;
      const image = result?.content.find((item) => item.type === "image");
      expect(typeof text).toBe("string");
      expect(Buffer.byteLength(String(text), "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(image?.mimeType).toBe("image/png");
      const capture = JSON.parse(String(text));
      const bytes = Buffer.from(String(image?.data), "base64");
      expect([
        ...bytes.subarray(0, 4),
      ]).toEqual([
        137,
        80,
        78,
        71,
      ]);
      expect(bytes.equals(await readFile(capture.image.path))).toBe(true);
    } finally {
      await reset?.();
    }
  }, 30_000);
  it("captures a stable page as ready without changing scroll", async () => {
    const manager = trackedManager();
    await manager.prepare(context(), {
      url: "http://127.0.0.1:8766/stable.html",
      viewport: {
        height: 360,
        width: 640,
      },
    });
    const capture = await manager.capture(context(), {
      selector: "#stable",
    });
    expect(capture.readiness.status).toBe("ready");
    expect(capture.image.raw).toMatchObject({
      height: 360,
      width: 640,
    });
    expect(capture.image.crop).toBeDefined();
    const expectedX =
      (capture.target?.visibleBounds.x ?? 0) * capture.image.coordinateScale.x;
    const expectedY =
      (capture.target?.visibleBounds.y ?? 0) * capture.image.coordinateScale.y;
    expect(
      Math.abs((capture.image.crop?.parentOffset.x ?? 0) - expectedX),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((capture.image.crop?.parentOffset.y ?? 0) - expectedY),
    ).toBeLessThanOrEqual(1);
    expect((await stat(capture.image.path)).size).toBe(capture.image.byteLength);
    const files = await readdir(dirname(capture.image.path));
    expect(
      files.some((file) => file.includes(".parent.png") || file.endsWith(".export")),
    ).toBe(false);
    expect(capture.page.scrollY).toBe(0);
    await manager.disconnect();
  }, 15_000);

  it("bounds a DPR 2 high-entropy screenshot and removes intermediate files", async () => {
    const manager = trackedManager();
    await manager.prepare(context(), {
      dpr: 2,
      url: "http://127.0.0.1:8766/noise.html",
      viewport: {
        height: 1600,
        width: 2560,
      },
    });
    const capture = await manager.capture(context(), {
      selector: "#noise",
    });
    expect(capture.dpr).toBe(2);
    expect(capture.image.raw.width).toBeGreaterThanOrEqual(2000);
    expect(capture.image.raw.height).toBeGreaterThanOrEqual(1200);
    expect(Math.max(capture.image.width, capture.image.height)).toBeLessThanOrEqual(
      2000,
    );
    expect(capture.image.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(capture.image.crop?.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    const files = await readdir(dirname(capture.image.path));
    expect(
      files.some((file) => file.includes(".parent.png") || file.endsWith(".export")),
    ).toBe(false);
    await manager.disconnect();
  }, 60_000);
  it("captures degraded resources and validates target resolution", async () => {
    const manager = trackedManager();
    await manager.prepare(context(), {
      url: "http://127.0.0.1:8766/index.html",
      viewport: {
        height: 360,
        width: 640,
      },
    });

    if (cdpUrl) {
      const background = new URL("json/new", cdpUrl);
      background.search = "http://127.0.0.1:8766/background.html";
      await fetch(background, {
        method: "PUT",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stable = await manager.capture(context(), {
      selector: "#stable",
    });
    expect(stable.readiness.status).toBe("degraded");
    expect(stable.readiness.reasons).toContain("visible images not ready");
    expect(stable.diagnostics.console.status).toBe("observed");
    expect(stable.diagnostics.console.entries).toHaveLength(20);
    expect(stable.diagnostics.console.truncated).toBe(true);
    expect(stable.diagnostics.network.status).toBe("observed");
    expect(stable.diagnostics.network.entries.length).toBeGreaterThan(0);
    expect(
      stable.diagnostics.network.entries.every(
        (entry) => entry.status === undefined || entry.status >= 400,
      ),
    ).toBe(true);
    expect(JSON.stringify(stable.diagnostics)).not.toContain("BACKGROUND_MARKER");
    expect(JSON.stringify(stable.diagnostics)).not.toContain("super-secret");
    expect(JSON.stringify(stable.diagnostics)).not.toContain("request-body");
    expect(stable.target?.text).toBe("Stable target");
    expect(stable.page.scrollY).toBe(0);

    const partial = await manager.capture(context(), {
      selector: "#partial",
    });
    expect(partial.target?.bounds.x).toBeLessThan(0);
    expect(partial.target?.visibleBounds.x).toBe(0);
    expect(partial.target?.visibleBounds.width).toBeLessThan(
      partial.target?.bounds.width ?? 0,
    );
    expect(partial.page.scrollY).toBe(0);

    const whitespace = await manager.capture(context(), {});
    expect(whitespace.target).toBeUndefined();

    await expect(
      manager.capture(context(), {
        selector: ".duplicate",
      }),
    ).rejects.toThrow("multiple-matches");
    await expect(
      manager.capture(context(), {
        selector: "#missing",
      }),
    ).rejects.toThrow("no-match");
    await expect(
      manager.capture(context(), {
        selector: "#outside",
      }),
    ).rejects.toThrow("outside-viewport");

    const degraded = await manager.capture(context(), {
      selector: "#broken-image",
    });
    expect(degraded.readiness.status).toBe("degraded");
    expect(degraded.readiness.reasons).toContain("visible images not ready");
    await manager.disconnect();
  }, 60_000);
});
