import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VisualLoopManager } from "../src/visual-loop/context.ts";
import { type FakeCdpEndpoint, fakePage } from "./helpers/fake-cdp.ts";

type Mode = "stable" | "changed" | "target-lost" | "failed";

const DECLARED_STATE_ERROR =
  /baseline capture declared stateLabel "dialog-open"; pass the same stateLabel/;

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

function pageFor(mode: Mode): Promise<FakeCdpEndpoint> {
  if (mode === "changed")
    return fakePage({
      urlAfterAt: {
        read: 5,
        url: "http://127.0.0.1:8765/changed",
      },
    });
  // The before capture reads the target once; the after capture is the second read.
  if (mode === "target-lost")
    return fakePage({
      targetMissingAfter: 2,
    });
  // The before viewport shot, its region shot, then the after viewport shot.
  if (mode === "failed")
    return fakePage({
      failAfter: 3,
    });
  return fakePage();
}

async function setup(mode: Mode) {
  const cwd = await mkdtemp(join(tmpdir(), "xpi-verify-project-test-"));
  roots.push(cwd);
  await mkdir(join(cwd, ".pi"), {
    recursive: true,
  });
  const endpoint = await pageFor(mode);
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
    url: "http://127.0.0.1:8765/",
    viewport: {
      height: 600,
      width: 800,
    },
  });
  return {
    ctx,
    manager,
  };
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

describe("VisualLoopManager.verify", () => {
  it("rejects an expired baseline before starting a new capture", async () => {
    const { ctx, manager } = await setup("stable");

    await expect(manager.verify(ctx, "capture-expired")).rejects.toThrow(
      "baseline capture is unavailable",
    );
  });

  it("creates a distinct after capture and comparable result", async () => {
    const { ctx, manager } = await setup("stable");
    const before = await manager.capture(ctx, {
      selector: "#target",
    });

    const result = await manager.verify(ctx, before.captureId);

    expect(result.before.captureId).toBe(before.captureId);
    expect(result.after?.captureId).not.toBe(before.captureId);
    expect(result.after?.target?.selector).toBe("#target");
    expect(result.comparison).toMatchObject({
      afterCaptureId: result.after?.captureId,
      beforeCaptureId: before.captureId,
      status: "comparable",
    });
    expect(result.comparison.targetChanges.status).toBe("unchanged");
    expect(result.comparison.commonRegion).toMatchObject({
      clipped: false,
      region: {
        height: 40,
        width: 100,
        x: 20,
        y: 30,
      },
    });
    expect(result.comparison.diagnostics.after).toBeDefined();
  });

  it("keeps both captures and reports a changed route as not-comparable", async () => {
    const { ctx, manager } = await setup("changed");
    const before = await manager.capture(ctx, {});
    const result = await manager.verify(ctx, before.captureId);

    expect(result.before.captureId).toBe(before.captureId);
    expect(result.after).toBeDefined();
    expect(result.comparison.status).toBe("not-comparable");
    expect(result.comparison.reasons).toContain("page URL changed");
    expect(manager.getCapture(before.captureId).status).toBe("available");
  });

  it("keeps the after capture when the target disappears", async () => {
    const { ctx, manager } = await setup("target-lost");
    const before = await manager.capture(ctx, {
      selector: "#target",
    });
    const result = await manager.verify(ctx, before.captureId);

    expect(result.after).toBeDefined();
    expect(result.comparison.status).toBe("not-comparable");
    expect(result.comparison.reasons).toContain("after target is missing");
    expect(result.comparison.targetChanges.status).toBe("missing");
    expect(result.comparison.commonRegion).toBeUndefined();
  });

  it("keeps the failure reason and does not create a blank crop", async () => {
    const { ctx, manager } = await setup("failed");
    const before = await manager.capture(ctx, {
      selector: "#target",
    });
    const result = await manager.verify(ctx, before.captureId);

    expect(result.after).toBeUndefined();
    expect(result.comparison.reasons[0]).toContain("after capture failed");
    expect(result.comparison.commonRegion).toBeUndefined();
  });
});

describe("VisualLoopManager.verify state declaration", () => {
  it("accepts a baseline without a declared state and never asks for one", async () => {
    const { ctx, manager } = await setup("stable");
    const before = await manager.capture(ctx, {});
    expect(before.stateLabel).toBeUndefined();

    const result = await manager.verify(ctx, before.captureId, {});
    expect(result.comparison.status).toBe("comparable");
    expect(result.after?.stateLabel).toBeUndefined();
  });

  it("rejects a silent caller when the baseline declared a state", async () => {
    const { ctx, manager } = await setup("stable");
    const before = await manager.capture(ctx, {
      stateLabel: "dialog-open",
    });

    await expect(manager.verify(ctx, before.captureId)).rejects.toThrow(
      DECLARED_STATE_ERROR,
    );
    // The rejection happens before any new evidence is created.
    expect(manager.getCapture(before.captureId).status).toBe("available");
  });

  it("compares when the caller repeats the declared state", async () => {
    const { ctx, manager } = await setup("stable");
    const before = await manager.capture(ctx, {
      stateLabel: "dialog-open",
    });

    const result = await manager.verify(ctx, before.captureId, {
      stateLabel: "dialog-open",
    });
    expect(result.after?.stateLabel).toBe("dialog-open");
    expect(result.comparison.status).toBe("comparable");
  });

  it("reports a changed declaration instead of inheriting the baseline one", async () => {
    const { ctx, manager } = await setup("stable");
    const before = await manager.capture(ctx, {
      stateLabel: "dialog-open",
    });

    const result = await manager.verify(ctx, before.captureId, {
      stateLabel: "dialog-closed",
    });
    expect(result.comparison.status).toBe("not-comparable");
    expect(result.comparison.reasons).toContain("declared interaction state changed");
  });
});
