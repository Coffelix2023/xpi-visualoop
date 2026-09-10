import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisualLoopManager } from "../src/visual-loop/context.ts";

const roots: string[] = [];
const managers: VisualLoopManager[] = [];

async function fakeHarness(
  mode: "stable" | "changed" | "target-lost" | "failed",
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xpi-verify-manager-test-"));
  roots.push(directory);
  const path = join(directory, "harness.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const encoded = input.match(/base64\\.b64decode\\(("[^"]+")\\)/)?.[1];
  const request = JSON.parse(Buffer.from(JSON.parse(encoded), "base64").toString("utf8"));
  const counterPath = join(process.env.BH_HOME, "count");
  const count = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
  writeFileSync(counterPath, String(count));
  if (${JSON.stringify(mode)} === "failed" && count >= 3) {
    process.stderr.write("after capture unavailable");
    process.exit(1);
  }
  const url = ${JSON.stringify(mode)} === "changed" && count >= 3 ? "http://127.0.0.1:8765/changed" : "http://127.0.0.1:8765/";
  if (request.action === "close") {
    process.stdout.write(JSON.stringify({ dpr: 1, ok: true, page: { url: request.expectedUrl }, protocolVersion: 1, targetId: request.targetId }));
    return;
  }
  if (request.action === "prepare") {
    process.stdout.write(JSON.stringify({ dpr: 1, ok: true, page: { h: request.viewport.height, ph: request.viewport.height, pw: request.viewport.width, sx: 0, sy: 0, title: "Page", url: request.url, w: request.viewport.width }, protocolVersion: 1, targetId: request.targetId || "target-owned" }));
    return;
  }
  if (request.action === "crop") {
    writeFileSync(request.outputPath, "png");
    process.stdout.write(JSON.stringify({ height: 1, ok: true, path: request.outputPath, protocolVersion: 1, width: 1 }));
    return;
  }
  mkdirSync(dirname(request.imagePath), { recursive: true });
  writeFileSync(request.imagePath, "png");
  if (request.targetImagePath) writeFileSync(request.targetImagePath, "png");
  const page = { h: 600, ph: 600, pw: 800, sx: 0, sy: 0, title: "Page", url, w: 800 };
  const target = request.selector && !(${JSON.stringify(mode)} === "target-lost" && count >= 3) ? { accessibility: {}, bounds: { height: 40, width: 100, x: 20, y: 30 }, selector: request.selector, styles: {}, text: "Target", visibleBounds: { height: 40, width: 100, x: 20, y: 30 } } : undefined;
  process.stdout.write(JSON.stringify({ dpr: 1, endedAt: "2026-09-09T00:00:01.000Z", image: { ...(request.selector ? { crop: { height: 40, path: request.targetImagePath, sourceRegion: { height: 40, width: 100, x: 20, y: 30 }, width: 100, x: 20, y: 30 } } : {}), height: 600, path: request.imagePath, rawHeight: 600, rawWidth: 800, temporaryByteLength: 3, width: 800 }, ok: true, pageAfter: page, pageBefore: page, protocolVersion: 1, readiness: { reasons: [], status: "ready" }, target, targetId: request.targetId, startedAt: "2026-09-09T00:00:00.000Z" }));
});
`,
  );
  await chmod(path, 0o700);
  return path;
}

function context(cwd: string) {
  return {
    cwd,
    signal: new AbortController().signal,
    isProjectTrusted: () => true,
  } as never;
}

async function setup(mode: "stable" | "changed" | "target-lost" | "failed") {
  const cwd = await mkdtemp(join(tmpdir(), "xpi-verify-project-test-"));
  roots.push(cwd);
  await mkdir(join(cwd, ".pi"), {
    recursive: true,
  });
  const harnessPath = await fakeHarness(mode);
  await writeFile(
    join(cwd, ".pi", "xpi-visualoop.json"),
    JSON.stringify({
      cdpUrl: "http://127.0.0.1:9333/",
      harnessPath,
    }),
  );
  const manager = new VisualLoopManager();
  managers.push(manager);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools",
      }),
    })),
  );
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
  vi.unstubAllGlobals();
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
