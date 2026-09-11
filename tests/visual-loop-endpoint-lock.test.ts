import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireEndpointLock, endpointLockPath } from "../src/visual-loop/context.ts";

const CDP_URL = "http://127.0.0.1:9444/";
const lockPath = endpointLockPath(CDP_URL);
const lockDir = join(tmpdir(), "xpi-visualoop-locks");
const survivors: Array<() => void> = [];

async function seed(body: string): Promise<void> {
  await mkdir(lockDir, {
    mode: 0o700,
    recursive: true,
  });
  await writeFile(lockPath, body, {
    mode: 0o600,
  });
}

async function lease(): Promise<{
  error?: unknown;
  pid?: number;
}> {
  try {
    const handle = await acquireEndpointLock(lockPath);
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
    };
    await handle.close();
    return {
      pid: owner.pid,
    };
  } catch (error) {
    return {
      error,
    };
  }
}

afterEach(async () => {
  for (const stop of survivors.splice(0)) stop();
  await rm(lockPath, {
    force: true,
  });
});

describe("endpoint lock ownership", () => {
  it("acquires a free endpoint", async () => {
    await rm(lockPath, {
      force: true,
    });
    expect(await lease()).toMatchObject({
      pid: process.pid,
    });
  });

  it("preempts a lock whose recorded holder no longer exists", async () => {
    await seed(
      JSON.stringify({
        pid: 2147483647,
        startedAt: "2026-09-10T06:34:37.457Z",
      }),
    );
    expect(await lease()).toMatchObject({
      pid: process.pid,
    });
  });

  it("preempts a malformed lock", async () => {
    await seed("not json");
    expect(await lease()).toMatchObject({
      pid: process.pid,
    });
  });

  it("preempts a lock with no usable pid", async () => {
    await seed(
      JSON.stringify({
        startedAt: "2026-09-10T06:34:37.457Z",
      }),
    );
    expect(await lease()).toMatchObject({
      pid: process.pid,
    });
  });

  it("refuses a lock held by a live process", async () => {
    const child = spawn(
      "sleep",
      [
        "30",
      ],
      {
        stdio: "ignore",
      },
    );
    survivors.push(() => child.kill("SIGKILL"));
    await seed(
      JSON.stringify({
        pid: child.pid,
        startedAt: "now",
      }),
    );
    const result = await lease();
    expect(result.pid).toBeUndefined();
    expect(String(result.error)).toContain("already owned by another xpi-visualoop");
  });
});
