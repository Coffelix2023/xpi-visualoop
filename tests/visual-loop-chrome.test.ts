import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROME_BINARY_ENV,
  chromeCandidates,
  chromeProfileDirectory,
  launchArguments,
  minimizeOwnedWindow,
  noBrowserMessage,
  probeEndpoint,
  resolveChromeBinary,
  waitUntilReady,
} from "../src/visual-loop/chrome.ts";

const temporaryDirectories: string[] = [];

/** The two things the missing-browser message must never offer instead. */
const FORBIDDEN_SUBSTITUTE_OFFER = /cloud|fallback|daily profile/i;

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

  it("probes the documented Chromium candidates in order", () => {
    expect(chromeCandidates({}, "darwin")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Arc.app/Contents/MacOS/Arc",
    ]);
    expect(chromeCandidates({}, "linux")).toEqual([
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "brave-browser",
    ]);
  });

  it("uses another Chromium browser when the first choice is missing", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "brave-browser"), "");
    const env = {
      PATH: `/absent:${directory}`,
    };
    expect(resolveChromeBinary(env, "linux")).toBe("brave-browser");
  });

  it("names both recovery steps when no browser exists at all", () => {
    const message = noBrowserMessage("http://127.0.0.1:9444/");
    expect(message).toContain(
      "set XPI_VISUALOOP_CHROME to the browser executable path",
    );
    expect(message).toContain("--remote-debugging-port=9444");
    expect(message).toContain("--user-data-dir=");
    expect(message).toContain("http://127.0.0.1:9444/");
    // No silent substitute: the message never offers another browser or a
    // cloud service in place of the one that is missing.
    expect(message).not.toMatch(FORBIDDEN_SUBSTITUTE_OFFER);
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

describe("launch arguments", () => {
  it("expresses the headless form with no window at all", () => {
    expect(launchArguments("headless")).toEqual([
      "--headless=new",
    ]);
  });

  it("keeps a headed window rendering, and never acts on its state", () => {
    const headed = [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
    ];
    expect(launchArguments("minimized")).toEqual(headed);
    // The visible form means the same flags: minimization is a CDP call, so
    // no argument can hide or minimize a window the user asked to see.
    expect(launchArguments("windowed")).toEqual(headed);
    expect(
      launchArguments("windowed").some((argument) => argument.includes("minimized")),
    ).toBe(false);
  });
});

describe("window state minimization", () => {
  function recorder(reply: (method: string) => unknown) {
    const calls: Array<{
      method: string;
      params?: Record<string, unknown>;
    }> = [];
    return {
      browser: {
        send: async (method: string, params?: Record<string, unknown>) => {
          calls.push({
            method,
            params,
          });
          const value = reply(method);
          if (value instanceof Error) throw value;
          return value;
        },
      },
      calls,
    };
  }

  it("asks the browser-level session for the window and minimizes it", async () => {
    const { browser, calls } = recorder(() => ({
      windowId: 7,
    }));
    expect(await minimizeOwnedWindow(browser, "target-1")).toBe("minimized");
    expect(calls).toEqual([
      {
        method: "Browser.getWindowForTarget",
        params: {
          targetId: "target-1",
        },
      },
      {
        method: "Browser.setWindowBounds",
        params: {
          windowId: 7,
          bounds: {
            windowState: "minimized",
          },
        },
      },
    ]);
  });

  it("reports an unknown state instead of failing when the window is missing", async () => {
    const refused = recorder(() => new Error("Browser window is not available"));
    expect(await minimizeOwnedWindow(refused.browser, "target-1")).toBe("unknown");

    // A browser that answers without a usable window id is the same answer.
    const empty = recorder(() => ({}));
    expect(await minimizeOwnedWindow(empty.browser, "target-1")).toBe("unknown");
    expect(empty.calls).toHaveLength(1);

    const refusedBounds = recorder((method) =>
      method === "Browser.getWindowForTarget"
        ? {
            windowId: 7,
          }
        : new Error("refused"),
    );
    expect(await minimizeOwnedWindow(refusedBounds.browser, "target-1")).toBe(
      "unknown",
    );
  });
});
