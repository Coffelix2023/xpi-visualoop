import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROME_BINARY_ENV,
  chromeCandidates,
  chromeProfileDirectory,
  probeEndpoint,
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

  it("gives up at the deadline when the endpoint accepts and never answers", async () => {
    // Chrome can complete the TCP handshake and then stay silent. A probe
    // without its own bound would never return, and the checks above would
    // never run again — the exact way visual_prepare wedged before.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("silent endpoint has no port");
    const cdpUrl = `http://127.0.0.1:${address.port}/`;
    try {
      await expect(
        waitUntilReady((signal) => probeEndpoint(cdpUrl, signal), {
          deadlineMs: 50,
          pollMs: 1,
        }),
      ).rejects.toThrow("did not expose a CDP endpoint");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
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
