import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noBrowserMessage } from "../src/visual-loop/chrome.ts";
import { endpointLockPath, VisualLoopManager } from "../src/visual-loop/context.ts";
import { type FakeCdpEndpoint, fakeCdp, fakePage } from "./helpers/fake-cdp.ts";

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

async function project(cdpUrl: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "xpi-cdp-lifecycle-project-"));
  roots.push(cwd);
  await mkdir(join(cwd, ".pi"), {
    recursive: true,
  });
  await writeFile(
    join(cwd, ".pi", "xpi-visualoop.json"),
    JSON.stringify({
      cdpUrl,
    }),
  );
  return cwd;
}

async function managed(
  create: () => Promise<FakeCdpEndpoint>,
  /** Whether the extension started the browser behind the fixture endpoint. */
  startedBrowser: (cdpUrl: string) => boolean = () => false,
) {
  const endpoint = await create();
  endpoints.push(endpoint);
  const manager = new VisualLoopManager(startedBrowser);
  managers.push(manager);
  const ctx = context(await project(endpoint.cdpUrl));
  return {
    ctx,
    endpoint,
    manager,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
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

describe("CDP connection lifecycle", () => {
  it("reuses one connection and one owned page across repeated prepare", async () => {
    const { ctx, endpoint, manager } = await managed(() => fakePage());
    const first = await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    const second = await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/next",
    });
    expect(first.result.targetId).toBe("target-1");
    expect(second.result.targetId).toBe("target-1");
    expect(endpoint.connectHits).toBe(1);
    expect(manager.status().state).toBe("ready");
  });

  it("stays disconnected when the endpoint is unreachable", async () => {
    const manager = new VisualLoopManager();
    managers.push(manager);
    const ctx = context(await project("http://127.0.0.1:9/"));
    // Nothing listens on port 9, so prepare also tries to start the owned
    // browser; pinning the binary override to a missing path keeps that
    // deterministic and stops the suite from launching a real Chrome.
    vi.stubEnv("XPI_VISUALOOP_CHROME", join(tmpdir(), "xpi-no-such-chrome"));
    await expect(
      manager.prepare(ctx, {
        url: "http://127.0.0.1:8765/",
      }),
    ).rejects.toThrow(noBrowserMessage("http://127.0.0.1:9/"));
    expect(manager.status()).toEqual({
      state: "disconnected",
    });
  });

  it("rejects capture after close", async () => {
    const { ctx, manager } = await managed(() => fakePage());
    await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    await manager.disconnect();
    expect(manager.status().state).toBe("disconnected");
    await expect(manager.capture(ctx, {})).rejects.toThrow("not prepared");
  });

  it("tightens the viewport cap to the exported-edge budget at DPR 2", async () => {
    const { ctx, manager } = await managed(() => fakePage());
    await expect(
      manager.prepare(ctx, {
        dpr: 2,
        url: "http://127.0.0.1:8765/",
        viewport: {
          height: 900,
          width: 1500,
        },
      }),
    ).rejects.toThrow("viewport.width must be between 320 and 1000");
    const prepared = await manager.prepare(ctx, {
      dpr: 2,
      url: "http://127.0.0.1:8765/",
      viewport: {
        height: 1000,
        width: 1000,
      },
    });
    expect(prepared.result.page.w).toBe(1000);
  });
});

describe("CDP resource release", () => {
  it("closes its own page, keeps strangers open, and leaves the browser process alone", async () => {
    const closed: string[] = [];
    const stranger = "stranger-tab";
    const endpoint = await fakeCdp((request) => {
      if (request.method === "Target.createTarget")
        return {
          result: {
            targetId: "owned-1",
          },
        };
      if (request.method === "Target.attachToTarget")
        return {
          result: {
            sessionId: "session-1",
          },
        };
      if (request.method === "Target.getTargetInfo") {
        const targetId = String(request.params?.targetId);
        return targetId === "stranger-tab"
          ? {
              result: {
                targetInfo: {
                  targetId,
                },
              },
            }
          : {
              result: {
                targetInfo: {
                  targetId: "owned-1",
                },
              },
            };
      }
      if (request.method === "Target.closeTarget") {
        closed.push(String(request.params?.targetId));
        return {
          result: {
            success: true,
          },
        };
      }
      if (request.method === "Runtime.evaluate") {
        const expression = String(request.params?.expression);
        if (expression === "location.href")
          return {
            result: {
              result: {
                value: "http://127.0.0.1:8765/",
              },
            },
          };
        if (expression === "document.readyState")
          return {
            result: {
              result: {
                value: "complete",
              },
            },
          };
        if (expression === "window.devicePixelRatio")
          return {
            result: {
              result: {
                value: 1,
              },
            },
          };
        if (expression.includes("document.title"))
          return {
            result: {
              result: {
                value: {
                  h: 600,
                  ph: 600,
                  pw: 800,
                  sx: 0,
                  sy: 0,
                  title: "Page",
                  url: "http://127.0.0.1:8765/",
                  w: 800,
                },
              },
            },
          };
        return {
          result: {
            result: {
              value: 1,
            },
          },
        };
      }
      return {
        result: {},
      };
    });
    endpoints.push(endpoint);
    const manager = new VisualLoopManager();
    managers.push(manager);
    const ctx = context(await project(endpoint.cdpUrl));
    await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    await manager.disconnect();
    expect(closed).toEqual([
      "owned-1",
    ]);
    expect(closed).not.toContain(stranger);
  });

  it("cancels an in-flight prepare and still releases the connection", async () => {
    const { ctx, manager } = await managed(() => fakePage());
    const controller = new AbortController();
    const preparing = manager.prepare(
      ctx,
      {
        url: "http://127.0.0.1:8765/",
      },
      controller.signal,
    );
    const disconnecting = manager.disconnect();
    controller.abort();
    await expect(preparing).rejects.toThrow();
    await disconnecting;
    expect(manager.status().state).toBe("disconnected");
  });

  it("reconnects cleanly after a reload-style reset", async () => {
    const { ctx, endpoint, manager } = await managed(() => fakePage());
    await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    await manager.resetSession();
    expect(manager.status().state).toBe("disconnected");
    await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    expect(manager.status().state).toBe("ready");
    expect(endpoint.connectHits).toBe(2);
  });
});

/** Wait out the server side of a client-initiated close, then report it. */
async function settledSockets(endpoint: FakeCdpEndpoint): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (endpoint.openSockets() === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return endpoint.openSockets();
}

describe("quiet launch window state", () => {
  it("minimizes the window of a browser it started", async () => {
    const { ctx, endpoint, manager } = await managed(
      () => fakePage(),
      () => true,
    );
    const prepared = await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    expect(prepared.windowState).toBe("minimized");
    expect(manager.status().windowState).toBe("minimized");
    expect(endpoint.requests).toContainEqual({
      id: expect.any(Number),
      method: "Browser.getWindowForTarget",
      params: {
        targetId: "target-1",
      },
    });
    expect(endpoint.requests).toContainEqual({
      id: expect.any(Number),
      method: "Browser.setWindowBounds",
      params: {
        windowId: 1,
        bounds: {
          windowState: "minimized",
        },
      },
    });
  });

  it("decides the window state once, so a reload does not pull the window back", async () => {
    const { ctx, endpoint, manager } = await managed(
      () => fakePage(),
      () => true,
    );
    await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    const windowCalls = endpoint.requests.filter((request) =>
      request.method.startsWith("Browser."),
    ).length;
    await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/next",
    });
    expect(
      endpoint.requests.filter((request) => request.method.startsWith("Browser."))
        .length,
    ).toBe(windowCalls);
  });

  it("still prepares and reports an unknown window state when there is no window", async () => {
    const { ctx, manager } = await managed(
      () =>
        fakePage({
          windowUnavailable: true,
        }),
      () => true,
    );
    const prepared = await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    expect(prepared.result.targetId).toBe("target-1");
    expect(prepared.windowState).toBe("unknown");
    expect(manager.status()).toMatchObject({
      state: "ready",
      windowState: "unknown",
    });
  });

  it("leaves an endpoint it did not start alone", async () => {
    const { ctx, endpoint, manager } = await managed(() => fakePage());
    const prepared = await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    expect(prepared.windowState).toBe("unknown");
    expect(
      endpoint.requests.some((request) => request.method.startsWith("Browser.")),
    ).toBe(false);
  });
});

describe("browser-level connection release", () => {
  it("closes the connection on disconnect", async () => {
    const { ctx, endpoint, manager } = await managed(
      () => fakePage(),
      () => true,
    );
    await manager.prepare(ctx, {
      url: "http://127.0.0.1:8765/",
    });
    expect(endpoint.openSockets()).toBe(1);
    await manager.disconnect();
    expect(await settledSockets(endpoint)).toBe(0);
  });

  it("closes the connection when the connect step fails after it opened", async () => {
    const { ctx, endpoint, manager } = await managed(
      () => fakePage(),
      () => true,
    );
    // A live holder on the same endpoint makes the connect step fail after the
    // WebSocket is already open: the leak this test exists to catch.
    const holder = spawn(
      "sleep",
      [
        "30",
      ],
      {
        stdio: "ignore",
      },
    );
    const lockPath = endpointLockPath(endpoint.cdpUrl);
    await mkdir(dirname(lockPath), {
      mode: 0o700,
      recursive: true,
    });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: holder.pid,
        startedAt: "now",
      }),
      {
        mode: 0o600,
      },
    );
    try {
      await expect(
        manager.prepare(ctx, {
          url: "http://127.0.0.1:8765/",
        }),
      ).rejects.toThrow("already owned by another xpi-visualoop process");
      expect(await settledSockets(endpoint)).toBe(0);
    } finally {
      holder.kill("SIGKILL");
      await rm(lockPath, {
        force: true,
      });
    }
  });
});
