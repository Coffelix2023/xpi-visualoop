import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VisualLoopConfig } from "../src/visual-loop/config.ts";
import { createPrivateHarnessDirs, runPrepare } from "../src/visual-loop/harness.ts";

const temporaryDirectories: string[] = [];

async function fakeHarness(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xpi-visual-loop-harness-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "harness.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

const config = (harnessPath: string): VisualLoopConfig => ({
  cdpUrl: "http://127.0.0.1:9333/",
  harnessPath,
});
const request = {
  action: "prepare" as const,
  dpr: 1,
  url: 'http://127.0.0.1:8765/?quote="line1\nline2',
  viewport: {
    height: 360,
    width: 640,
  },
};

async function run(harnessPath: string, signal?: AbortSignal) {
  const dirs = await createPrivateHarnessDirs();
  try {
    return await runPrepare(config(harnessPath), dirs, request, signal);
  } finally {
    await rm(dirs.root, {
      force: true,
      recursive: true,
    });
  }
}

describe("fixed Harness subprocess protocol", () => {
  it("passes JSON data literally and accepts only the versioned envelope", async () => {
    const path = await fakeHarness(`
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const encoded = input.match(/base64\\.b64decode\\(("[^"]+")\\)/)?.[1];
  const payload = JSON.parse(Buffer.from(JSON.parse(encoded), "base64").toString("utf8"));
  process.stdout.write(JSON.stringify({ dpr: payload.dpr, ok: true, page: { url: payload.url }, protocolVersion: 1, targetId: "owned-target" }));
});`);
    const result = await run(path);
    expect(result.page.url).toBe(request.url);
    expect(result.targetId).toBe("owned-target");
  });

  it("rejects extra output, non-zero exits, and oversized output", async () => {
    const extra = await fakeHarness(
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("banner\\n{}"));',
    );
    await expect(run(extra)).rejects.toThrow("invalid JSON or extra output");

    const failed = await fakeHarness(
      'process.stderr.write("controlled failure\\n"); process.exitCode = 7;',
    );
    await expect(run(failed)).rejects.toThrow("code 7");

    const oversized = await fakeHarness(
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("x".repeat(64 * 1024 + 1)));',
    );
    await expect(run(oversized)).rejects.toThrow("exceeded");
  });

  it("terminates a cancelled operation", async () => {
    const hanging = await fakeHarness(
      'process.stdin.resume(); process.stdin.on("end", () => setInterval(() => {}, 1000));',
    );
    const controller = new AbortController();
    const promise = run(hanging, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow("cancelled");
  });
});
