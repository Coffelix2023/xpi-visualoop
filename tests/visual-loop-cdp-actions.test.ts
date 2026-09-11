import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CdpClient } from "../src/visual-loop/cdp.ts";
import {
  captureOwnedPage,
  closeOwnedTarget,
  type OwnedTargets,
  OwnedTargets as OwnedTargetsClass,
  openOwnedTarget,
  prepareOwnedPage,
} from "../src/visual-loop/cdp-actions.ts";
import {
  type FakeCdpEndpoint,
  type FakeCdpReply,
  type FakeCdpRequest,
  fakeCdp,
} from "./helpers/fake-cdp.ts";

const pendingEndpoints: FakeCdpEndpoint[] = [];
const pendingClients: CdpClient[] = [];
const roots: string[] = [];

function imageBytes(): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write("89504e470d0a1a0a", 0, "hex");
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(800, 16);
  buffer.writeUInt32BE(600, 20);
  return buffer;
}

const PNG = imageBytes();

function value(result: unknown): FakeCdpReply {
  return {
    result: {
      result: {
        value: result,
      },
    },
  };
}

type PageInfoOverrides = Partial<
  Record<"h" | "ph" | "pw" | "sx" | "sy" | "w", number>
> & {
  url?: string;
};

function pageInfoValue(url: string, overrides: PageInfoOverrides = {}) {
  return {
    h: 600,
    ph: 600,
    pw: 800,
    sx: 0,
    sy: 0,
    title: "Page",
    url,
    w: 800,
    ...overrides,
  };
}

function targetValue(
  selector: string,
  x = 20,
  y = 30,
  size: {
    height: number;
    width: number;
  } = {
    height: 40,
    width: 100,
  },
) {
  return {
    accessibility: {},
    bounds: {
      height: size.height,
      width: size.width,
      x,
      y,
    },
    documentBounds: {
      height: size.height,
      width: size.width,
      x: x + 250,
      y: y + 250,
    },
    selector,
    styles: {},
    text: "Target",
    visibleBounds: {
      height: size.height,
      width: size.width,
      x,
      y,
    },
  };
}

async function client(url: string): Promise<{
  client: CdpClient;
  owned: OwnedTargets;
}> {
  const instance = await CdpClient.connect(url);
  pendingClients.push(instance);
  return {
    client: instance,
    owned: new OwnedTargetsClass(),
  };
}

async function root(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `xpi-cdp-actions-${name}-`));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(pendingClients.splice(0).map((instance) => instance.close()));
  await Promise.all(pendingEndpoints.splice(0).map((endpoint) => endpoint.close()));
  await Promise.all(
    roots.splice(0).map((path) =>
      rm(path, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("target ownership", () => {
  it("closes only its own live target", async () => {
    const closed = new Set<string>();
    const endpoint = await fakeCdp((request: FakeCdpRequest): FakeCdpReply => {
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
        const targetId = request.params?.targetId;
        if (targetId === "owned-1" && !closed.has("owned-1"))
          return {
            result: {
              targetInfo: {
                targetId: "owned-1",
              },
            },
          };
        return {
          error: {
            code: -32602,
            message: "No target with given id found",
          },
        };
      }
      if (request.method === "Runtime.evaluate") {
        if (request.params?.expression === "location.href")
          return value("http://127.0.0.1:8765/");
        return value(1);
      }
      if (request.method === "Target.closeTarget") {
        const targetId = String(request.params?.targetId);
        if (targetId !== "owned-1" || closed.has("owned-1"))
          return {
            error: {
              code: -32602,
              message: "No target with given id found",
            },
          };
        closed.add("owned-1");
        return {
          result: {
            success: true,
          },
        };
      }
      return {
        result: {},
      };
    });
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);

    const targetId = await openOwnedTarget(connection, owned);
    expect(targetId).toBe("owned-1");
    expect(owned.session(targetId)).toBe("session-1");
    expect(owned.first()).toBe("owned-1");

    await expect(
      closeOwnedTarget(connection, owned, "stranger-1", "http://127.0.0.1:8765/"),
    ).rejects.toThrow("does not own");
    await expect(
      closeOwnedTarget(connection, owned, targetId, "http://127.0.0.1:8765/other"),
    ).rejects.toThrow("URL changed");

    await closeOwnedTarget(connection, owned, targetId, "http://127.0.0.1:8765/");
    expect(owned.first()).toBeUndefined();

    const reopened = await openOwnedTarget(connection, owned);
    closed.add(reopened);
    await expect(
      closeOwnedTarget(connection, owned, reopened, "http://127.0.0.1:8765/"),
    ).rejects.toThrow("no longer available");
  });

  it("reports an unreachable target without closing anything", async () => {
    const endpoint = await fakeCdp((request: FakeCdpRequest): FakeCdpReply => {
      if (request.method === "Target.createTarget")
        return {
          result: {
            targetId: "owned-2",
          },
        };
      if (request.method === "Target.attachToTarget")
        return {
          result: {
            sessionId: "session-2",
          },
        };
      return {
        error: {
          code: -32602,
          message: "No target with given id found",
        },
      };
    });
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);
    const targetId = await openOwnedTarget(connection, owned);
    expect(targetId).toBe("owned-2");
    await expect(
      closeOwnedTarget(connection, owned, targetId, "http://127.0.0.1:8765/"),
    ).rejects.toThrow("no longer available");
  });
});

describe("owned page preparation", () => {
  it("reuses one owned target and applies the requested viewport", async () => {
    let createHits = 0;
    let enableHits = 0;
    let navigateCount = 0;
    const metrics: Array<Record<string, unknown>> = [];
    const endpoint = await fakeCdp((request: FakeCdpRequest): FakeCdpReply => {
      if (request.method === "Target.createTarget") {
        createHits += 1;
        return {
          result: {
            targetId: "owned-3",
          },
        };
      }
      if (request.method === "Target.attachToTarget")
        return {
          result: {
            sessionId: "session-3",
          },
        };
      if (request.method === "Target.getTargetInfo")
        return {
          result: {
            targetInfo: {
              targetId: "owned-3",
            },
          },
        };
      if (request.method.endsWith(".enable")) {
        enableHits += 1;
        return {
          result: {},
        };
      }
      if (request.method === "Emulation.setDeviceMetricsOverride") {
        metrics.push(request.params ?? {});
        return {
          result: {},
        };
      }
      if (request.method === "Page.navigate") {
        navigateCount += 1;
        return {
          result: {
            frameId: "frame-1",
          },
        };
      }
      if (request.method === "Runtime.evaluate") {
        const expression = String(request.params?.expression);
        if (expression === "document.readyState") return value("complete");
        if (expression === "window.devicePixelRatio") return value(2);
        if (expression.includes("document.title")) {
          const url =
            navigateCount > 1 ? "http://127.0.0.1:8765/next" : "http://127.0.0.1:8765/";
          return value(pageInfoValue(url));
        }
        return value(1);
      }
      return {
        result: {},
      };
    });
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);

    const first = await prepareOwnedPage(connection, owned, {
      dpr: 2,
      url: "http://127.0.0.1:8765/",
      viewport: {
        height: 600,
        width: 800,
      },
    });
    expect(first.targetId).toBe("owned-3");
    expect(first.dpr).toBe(2);
    expect(first.page.url).toBe("http://127.0.0.1:8765/");

    const second = await prepareOwnedPage(connection, owned, {
      dpr: 1,
      url: "http://127.0.0.1:8765/next",
      viewport: {
        height: 400,
        width: 900,
      },
    });
    expect(second.targetId).toBe(first.targetId);
    expect(second.page.url).toBe("http://127.0.0.1:8765/next");
    expect(createHits).toBe(1);
    // Enabling the observers twice would restart the observation window.
    expect(enableHits).toBe(3);
    expect(metrics).toEqual([
      {
        deviceScaleFactor: 2,
        height: 600,
        mobile: false,
        width: 800,
      },
      {
        deviceScaleFactor: 1,
        height: 400,
        mobile: false,
        width: 900,
      },
    ]);
  });

  it("refuses a page that leaves the allowed local range", async () => {
    let navigated = false;
    const endpoint = await fakeCdp((request: FakeCdpRequest): FakeCdpReply => {
      if (request.method === "Target.createTarget")
        return {
          result: {
            targetId: "owned-4",
          },
        };
      if (request.method === "Target.attachToTarget")
        return {
          result: {
            sessionId: "session-4",
          },
        };
      if (request.method === "Page.navigate") {
        navigated = true;
        return {
          result: {},
        };
      }
      if (request.method === "Runtime.evaluate") {
        const expression = String(request.params?.expression);
        if (expression === "document.readyState") return value("complete");
        if (expression.includes("document.title"))
          return value(pageInfoValue("https://example.com/"));
        return value(1);
      }
      return {
        result: {},
      };
    });
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);

    await expect(
      prepareOwnedPage(connection, owned, {
        dpr: 1,
        url: "https://example.com/",
        viewport: {
          height: 600,
          width: 800,
        },
      }),
    ).rejects.toThrow("loopback");
    expect(navigated).toBe(false);

    await expect(
      prepareOwnedPage(connection, owned, {
        dpr: 1,
        url: "http://127.0.0.1:8765/",
        viewport: {
          height: 600,
          width: 800,
        },
      }),
    ).rejects.toThrow("loopback");
    expect(navigated).toBe(true);
    expect(owned.first()).toBe("owned-4");
  });
});

describe("owned page capture", () => {
  function captureEndpoint(options: {
    oversized?: boolean;
    shots?: Array<Record<string, unknown>>;
    pageAfter?: PageInfoOverrides;
    readiness?: Record<string, unknown>;
    target?: "changed" | "ok" | "unresolved";
  }): (request: FakeCdpRequest) => FakeCdpReply {
    let pageReads = 0;
    return (request: FakeCdpRequest): FakeCdpReply => {
      if (request.method === "Target.createTarget")
        return {
          result: {
            targetId: "owned-5",
          },
        };
      if (request.method === "Target.attachToTarget")
        return {
          result: {
            sessionId: "session-5",
          },
        };
      if (request.method === "Target.getTargetInfo")
        return {
          result: {
            targetInfo: {
              targetId: "owned-5",
            },
          },
        };
      if (request.method === "Page.captureScreenshot") {
        options.shots?.push(request.params ?? {});
        return {
          result: {
            data: PNG.toString("base64"),
          },
        };
      }
      if (request.method === "Runtime.evaluate") {
        const expression = String(request.params?.expression);
        if (expression === "document.readyState") return value("complete");
        if (expression === "window.devicePixelRatio") return value(1);
        if (expression.includes("document.fonts"))
          return value(
            options.readiness ?? {
              fonts: true,
              images: true,
              readyState: "complete",
            },
          );
        if (expression.includes("document.title")) {
          pageReads += 1;
          const url = options.pageAfter?.url ?? "http://127.0.0.1:8765/";
          return value(
            pageInfoValue(pageReads === 1 ? "http://127.0.0.1:8765/" : url, {
              ...(pageReads === 1 ? {} : options.pageAfter),
            }),
          );
        }
        if (expression.includes("getComputedStyle")) {
          if (options.target === "unresolved")
            return value({
              error: "no-match",
            });
          return value(
            targetValue(
              "#target",
              20,
              30,
              options.oversized === true
                ? {
                    height: 3000,
                    width: 1000,
                  }
                : undefined,
            ),
          );
        }
        if (expression.includes("querySelectorAll")) {
          if (options.target === "unresolved") return value(null);
          let height = options.oversized === true ? 3000 : 40;
          if (options.target === "changed") height = 44;
          const width = options.oversized === true ? 1000 : 100;
          return value({
            documentBounds: {
              height,
              width,
              x: 270,
              y: 280,
            },
          });
        }
        return value(1);
      }
      return {
        result: {},
      };
    };
  }

  it("captures page metadata, target data, and an image on disk", async () => {
    const shots: Array<Record<string, unknown>> = [];
    const endpoint = await fakeCdp(
      captureEndpoint({
        shots,
      }),
    );
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);
    const targetId = await openOwnedTarget(connection, owned);
    const imagePath = join(await root("capture"), "shot.png");
    const targetImagePath = join(await root("capture"), "target.png");

    const result = await captureOwnedPage(connection, owned, targetId, {
      imagePath,
      selector: "#target",
      targetImagePath,
    });
    expect(result.targetId).toBe("owned-5");
    expect(result.readiness).toEqual({
      reasons: [],
      status: "ready",
    });
    expect(result.pageAfter).toMatchObject({
      h: 600,
      sx: 0,
      sy: 0,
    });
    expect(result.target?.visibleBounds).toEqual({
      height: 40,
      width: 100,
      x: 20,
      y: 30,
    });
    expect(result.image).toMatchObject({
      byteLength: PNG.byteLength,
      height: 600,
      rawHeight: 600,
      rawWidth: 800,
      width: 800,
    });
    expect(result.image.path).toBe(imagePath);
    expect(await readFile(imagePath)).toEqual(PNG);
    // The viewport shot carries no clip; the region shot clips to the target's
    // document rectangle, which is the viewport rectangle shifted by the scroll
    // offset (fixture: bounds 20,30 and scrollX/Y 250).
    expect(shots).toEqual([
      {
        format: "png",
      },
      {
        // Blank pixels come back for out-of-viewport regions without this flag,
        // while size and stability checks still pass — a silent wrong answer.
        captureBeyondViewport: true,
        format: "png",
        clip: {
          height: 40,
          scale: 1,
          width: 100,
          x: 270,
          y: 280,
        },
      },
    ]);
    expect(result.image.crop?.sourceRegion).toEqual({
      height: 40,
      width: 100,
      x: 270,
      y: 280,
    });
    expect(result.image.crop?.path).toBe(targetImagePath);
    expect(await readFile(targetImagePath)).toEqual(PNG);
    // The collector was never attached on this target, so the capture must say
    // so instead of implying a clean run.
    expect(result.diagnostics.console.status).toBe("unknown");
    expect(result.diagnostics.network.status).toBe("unknown");
  });

  it("clamps an oversized target region into the exported-edge budget via clip.scale", async () => {
    const shots: Array<Record<string, unknown>> = [];
    const endpoint = await fakeCdp(
      captureEndpoint({
        oversized: true,
        shots,
      }),
    );
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);
    const targetId = await openOwnedTarget(connection, owned);
    const targetImagePath = join(await root("clamped"), "target.png");

    const result = await captureOwnedPage(connection, owned, targetId, {
      imagePath: join(await root("clamped"), "shot.png"),
      selector: "#target",
      targetImagePath,
    });
    // 1000x3000 CSS at DPR 1: the 3000 edge exceeds 2000, so the scale is the
    // budget ratio times SCALE_EPSILON and the source region stays page-truth.
    const [regionShot] = shots.slice(-1);
    expect(regionShot).toMatchObject({
      captureBeyondViewport: true,
      clip: {
        height: 3000,
        width: 1000,
      },
    });
    const scale = (
      regionShot?.clip as
        | {
            scale?: number;
          }
        | undefined
    )?.scale;
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);
    expect((2000 / 3000) * 0.999).toBeCloseTo(scale ?? 0, 5);
    expect(result.image.crop?.sourceRegion).toEqual({
      height: 3000,
      width: 1000,
      x: 270,
      y: 280,
    });
    expect(await readFile(targetImagePath)).toEqual(PNG);
  });

  it("observes console and network failures between prepare and capture", async () => {
    const endpoint = await fakeCdp(captureEndpoint({}));
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);
    const prepared = await prepareOwnedPage(connection, owned, {
      dpr: 1,
      url: "http://127.0.0.1:8765/",
      viewport: {
        height: 600,
        width: 800,
      },
    });
    const sessionId = owned.session(prepared.targetId);
    expect(sessionId).toBeTypeOf("string");
    endpoint.sendEvent({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "error",
        args: [
          {
            value: "broken",
          },
        ],
      },
      sessionId,
    });
    endpoint.sendEvent({
      method: "Network.loadingFailed",
      params: {
        errorText: "net::ERR_CONNECTION_REFUSED",
      },
      sessionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await captureOwnedPage(connection, owned, prepared.targetId, {
      imagePath: join(await root("diagnosed"), "shot.png"),
    });
    expect(result.diagnostics.console.status).toBe("observed");
    expect(result.diagnostics.console.entries.map((entry) => entry.message)).toEqual([
      "broken",
    ]);
    expect(result.diagnostics.network.entries.map((entry) => entry.message)).toEqual([
      "net::ERR_CONNECTION_REFUSED",
    ]);
    expect(result.diagnostics.console.observedFrom).toBeTypeOf("string");
  });

  it("reports navigation, scroll, and target-bound changes instead of throwing", async () => {
    const navigated = await fakeCdp(
      captureEndpoint({
        pageAfter: {
          url: "http://127.0.0.1:8765/changed",
        },
      }),
    );
    pendingEndpoints.push(navigated);
    const first = await client(navigated.cdpUrl);
    const firstTarget = await openOwnedTarget(first.client, first.owned);
    const firstResult = await captureOwnedPage(first.client, first.owned, firstTarget, {
      imagePath: join(await root("navigated"), "shot.png"),
    });
    expect(firstResult.readiness.status).toBe("degraded");
    expect(firstResult.readiness.reasons).toContain("page URL changed during capture");

    const scrolled = await fakeCdp(
      captureEndpoint({
        pageAfter: {
          sy: 40,
        },
      }),
    );
    pendingEndpoints.push(scrolled);
    const second = await client(scrolled.cdpUrl);
    const secondTarget = await openOwnedTarget(second.client, second.owned);
    const secondResult = await captureOwnedPage(
      second.client,
      second.owned,
      secondTarget,
      {
        imagePath: join(await root("scrolled"), "shot.png"),
      },
    );
    expect(secondResult.readiness.reasons).toContain("scroll changed during capture");

    const moved = await fakeCdp(
      captureEndpoint({
        target: "changed",
      }),
    );
    pendingEndpoints.push(moved);
    const third = await client(moved.cdpUrl);
    const thirdTarget = await openOwnedTarget(third.client, third.owned);
    const thirdResult = await captureOwnedPage(third.client, third.owned, thirdTarget, {
      imagePath: join(await root("moved"), "shot.png"),
      selector: "#target",
    });
    expect(thirdResult.readiness.reasons).toContain(
      "target bounds changed during capture",
    );
  });

  it("keeps the viewport image when the target disappears and the caller allows it", async () => {
    const endpoint = await fakeCdp(
      captureEndpoint({
        target: "unresolved",
      }),
    );
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);
    const targetId = await openOwnedTarget(connection, owned);
    const imagePath = join(await root("target"), "shot.png");

    await expect(
      captureOwnedPage(connection, owned, targetId, {
        imagePath,
        selector: "#target",
      }),
    ).rejects.toThrow("target resolution failed: no-match");

    const allowed = await captureOwnedPage(connection, owned, targetId, {
      allowTargetFailure: true,
      imagePath,
      selector: "#target",
    });
    expect(allowed.target).toBeUndefined();
    expect(allowed.readiness).toEqual({
      status: "degraded",
      reasons: [
        "target resolution failed: no-match",
      ],
    });
    expect(await readFile(imagePath)).toEqual(PNG);
  });

  it("degrades a page that never finishes loading", async () => {
    const endpoint = await fakeCdp(
      captureEndpoint({
        readiness: {
          fonts: true,
          images: true,
          readyState: "loading",
        },
      }),
    );
    pendingEndpoints.push(endpoint);
    const { client: connection, owned } = await client(endpoint.cdpUrl);
    const targetId = await openOwnedTarget(connection, owned);
    const result = await captureOwnedPage(connection, owned, targetId, {
      imagePath: join(await root("loading"), "shot.png"),
    });
    expect(result.readiness).toEqual({
      status: "degraded",
      reasons: [
        "document not complete",
      ],
    });
  }, 15_000);
});
