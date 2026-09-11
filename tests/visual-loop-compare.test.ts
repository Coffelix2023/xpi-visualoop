import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VisualLoopManager } from "../src/visual-loop/context.ts";
import {
  type FakeCdpEndpoint,
  type FakePageOptions,
  fakePage,
} from "./helpers/fake-cdp.ts";

const VIEWPORT = {
  height: 600,
  width: 800,
};

const roots: string[] = [];
const managers: VisualLoopManager[] = [];
const endpoints: FakeCdpEndpoint[] = [];

function context(cwd: string) {
  return {
    cwd,
    signal: new AbortController().signal,
    isProjectTrusted: () => true,
  } as never;
}

async function setup(options: FakePageOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "xpi-compare-project-test-"));
  roots.push(cwd);
  await mkdir(join(cwd, ".pi"), {
    recursive: true,
  });
  const endpoint = await fakePage(options);
  endpoints.push(endpoint);
  await writeFile(
    join(cwd, ".pi", "xpi-visualoop.json"),
    JSON.stringify({
      cdpUrl: endpoint.cdpUrl,
    }),
  );
  const manager = new VisualLoopManager();
  managers.push(manager);
  const ctx = context(cwd);
  await manager.prepare(ctx, {
    url: "http://127.0.0.1:8765/variant-a",
    viewport: VIEWPORT,
  });
  return {
    ctx,
    endpoint,
    manager,
  };
}

/** Prepare a second version and capture it, which is the real selection flow. */
async function captureVersion(
  ctx: ReturnType<typeof context>,
  manager: VisualLoopManager,
  version: string,
  stateLabel?: string,
) {
  await manager.prepare(ctx, {
    url: `http://127.0.0.1:8765/variant-${version}`,
    viewport: VIEWPORT,
    ...(stateLabel === undefined
      ? {}
      : {
          stateLabel,
        }),
  });
  return manager.capture(
    ctx,
    stateLabel === undefined
      ? {}
      : {
          stateLabel,
        },
  );
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disconnect()));
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  await Promise.all(
    roots.splice(0).map((path) =>
      rm(path, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("VisualLoopManager.compare", () => {
  it("files a version difference as information instead of refusing it", async () => {
    // The fake page flips its URL on the fifth page read, so the second capture
    // records the other version without any navigation. A regression check refuses
    // this exact pair; a variant comparison files the difference instead.
    const { ctx, manager } = await setup({
      urlAfterAt: {
        read: 5,
        url: "http://127.0.0.1:8765/variant-b",
      },
    });
    const left = await manager.capture(ctx, {});
    const right = await manager.capture(ctx, {});
    expect(left.page.url).not.toBe(right.page.url);

    const result = manager.compare(left.captureId, right.captureId, [
      "B1 紧凑",
      "B2 宽松",
    ]);

    expect(result.left.captureId).toBe(left.captureId);
    expect(result.right.captureId).toBe(right.captureId);
    expect(result.comparison).toMatchObject({
      afterCaptureId: right.captureId,
      beforeCaptureId: left.captureId,
      labels: [
        "B1 紧凑",
        "B2 宽松",
      ],
      mode: "variant",
      status: "comparable",
    });
    expect(result.comparison.reasons).toContain("page URL changed");
  });

  it("returns both sides untouched and crops nothing", async () => {
    const { ctx, manager } = await setup();
    const left = await captureVersion(ctx, manager, "b1");
    const right = await captureVersion(ctx, manager, "b2");

    const result = manager.compare(left.captureId, right.captureId);

    expect(result.left.image.path).toBe(left.image.path);
    expect(result.right.image.path).toBe(right.image.path);
    expect(result.left.image.path).not.toBe(result.right.image.path);
    expect(result.comparison.commonRegion).toBeUndefined();
    expect(result.comparison.labels).toBeUndefined();
    expect(manager.getCapture(left.captureId).status).toBe("available");
    expect(manager.getCapture(right.captureId).status).toBe("available");
  });

  it("rejects an unavailable side without observing anything", async () => {
    const { ctx, endpoint, manager } = await setup();
    const left = await captureVersion(ctx, manager, "b1");
    const versionHits = endpoint.versionHits;

    expect(() => manager.compare(left.captureId, "capture-missing")).toThrow(
      "comparison capture is unavailable: capture-missing",
    );
    expect(() => manager.compare("capture-missing", left.captureId)).toThrow(
      "comparison capture is unavailable: capture-missing",
    );
    expect(endpoint.versionHits).toBe(versionHits);
  });

  it("takes no capture and touches no endpoint", async () => {
    // The trap is armed at the third screenshot; the two captures below take the
    // first two, so a compare that re-observed anything would fail here.
    const { ctx, endpoint, manager } = await setup({
      failAfter: 3,
    });
    const left = await captureVersion(ctx, manager, "b1");
    const right = await captureVersion(ctx, manager, "b2");
    const versionHits = endpoint.versionHits;

    const result = manager.compare(left.captureId, right.captureId);

    expect(result.comparison.status).toBe("comparable");
    expect(endpoint.versionHits).toBe(versionHits);
    await expect(manager.capture(ctx, {})).rejects.toThrow("capture failed");
  });

  it("never asks for a declared state and never refuses the pair", async () => {
    const { ctx, manager } = await setup();
    const left = await captureVersion(ctx, manager, "b1", "card default");
    const right = await captureVersion(ctx, manager, "b2", "menu open");

    const result = manager.compare(left.captureId, right.captureId);

    expect(left.stateLabel).toBe("card default");
    expect(right.stateLabel).toBe("menu open");
    expect(result.comparison.reasons).toContain("declared interaction state changed");
    expect(result.comparison.status).toBe("comparable");
    // Three declared parameters: there is no mode or stateLabel knob to turn.
    expect(VisualLoopManager.prototype.compare.length).toBe(3);
  });

  it("refuses to compare before the loop is prepared", async () => {
    const manager = new VisualLoopManager();
    managers.push(manager);

    expect(() => manager.compare("capture-a", "capture-b")).toThrow(
      "visual loop is not prepared",
    );
  });
});
