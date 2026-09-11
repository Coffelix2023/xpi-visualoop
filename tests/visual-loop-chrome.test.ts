import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROME_BINARY_ENV,
  chromeCandidates,
  chromeProfileDirectory,
  resolveChromeBinary,
  waitUntilReady,
} from "../src/visual-loop/chrome.ts";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xpi-visual-loop-chrome-"));
  temporaryDirectories.push(directory);
  return directory;
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

describe("chrome binary discovery", () => {
  it("lets the environment override the platform defaults", () => {
    const env = {
      [CHROME_BINARY_ENV]: "/opt/custom/chrome",
    };
    expect(chromeCandidates(env, "darwin")).toEqual([
      "/opt/custom/chrome",
    ]);
    expect(resolveChromeBinary(env, "darwin")).toBeUndefined();
  });

  it("prefers a binary that exists and reports nothing when none does", async () => {
    const directory = await tempDirectory();
    const binary = join(directory, "chrome");
    await writeFile(binary, "");
    expect(
      resolveChromeBinary(
        {
          [CHROME_BINARY_ENV]: binary,
        },
        "darwin",
      ),
    ).toBe(binary);
    expect(
      resolveChromeBinary(
        {
          [CHROME_BINARY_ENV]: join(directory, "absent"),
        },
        "darwin",
      ),
    ).toBeUndefined();
  });

  it("resolves a command name through PATH", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "chromium"), "");
    const env = {
      PATH: `/absent:${directory}`,
    };
    expect(resolveChromeBinary(env, "linux")).toBe("chromium");
  });

  it("derives the profile directory from HOME and supports no platform", () => {
    expect(
      chromeProfileDirectory({
        HOME: "/home/operator",
      }),
    ).toBe("/home/operator/.cache/xpi-visualoop/chrome-profile");
    expect(chromeCandidates({}, "win32")).toEqual([]);
    expect(resolveChromeBinary({}, "win32")).toBeUndefined();
  });
});

describe("endpoint readiness polling", () => {
  it("returns as soon as the probe succeeds", async () => {
    let attempts = 0;
    await waitUntilReady(
      async () => {
        attempts += 1;
        return attempts >= 3;
      },
      {
        deadlineMs: 1_000,
        pollMs: 1,
      },
    );
    expect(attempts).toBe(3);
  });

  it("gives up at the deadline instead of polling forever", async () => {
    await expect(
      waitUntilReady(async () => false, {
        deadlineMs: 20,
        pollMs: 1,
      }),
    ).rejects.toThrow("did not expose a CDP endpoint");
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitUntilReady(async () => false, {
        deadlineMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});

describe("chrome module layout", () => {
  it("keeps the profile under the documented cache path", async () => {
    const directory = await tempDirectory();
    await mkdir(join(directory, "nested"), {
      recursive: true,
    });
    expect(
      chromeProfileDirectory({
        HOME: directory,
      }),
    ).toBe(join(directory, ".cache", "xpi-visualoop", "chrome-profile"));
  });
});
