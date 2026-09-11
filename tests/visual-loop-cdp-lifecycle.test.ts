import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VisualLoopManager } from "../src/visual-loop/context.ts";
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

async function managed(create: () => Promise<FakeCdpEndpoint>) {
  const endpoint = await create();
  endpoints.push(endpoint);
  const manager = new VisualLoopManager();
  managers.push(manager);
  const ctx = context(await project(endpoint.cdpUrl));
  return {
    ctx,
    endpoint,
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
    await expect(
      manager.prepare(ctx, {
        url: "http://127.0.0.1:8765/",
      }),
    ).rejects.toThrow("unreachable");
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
