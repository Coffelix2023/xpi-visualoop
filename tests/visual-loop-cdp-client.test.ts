import { afterEach, describe, expect, it } from "vitest";
import { CdpClient, type CdpEvent } from "../src/visual-loop/cdp.ts";
import { type FakeCdpEndpoint, fakeCdp } from "./helpers/fake-cdp.ts";

const pending: FakeCdpEndpoint[] = [];

afterEach(async () => {
  await Promise.all(pending.splice(0).map((endpoint) => endpoint.close()));
});

describe("native CDP client", () => {
  it("pairs responses, times out, reports unknown methods, and fails on drop", async () => {
    const endpoint = await fakeCdp((request) => {
      if (request.method === "Runtime.evaluate") {
        return {
          result: {
            value: request.id,
          },
        };
      }
      if (request.method === "Page.captureScreenshot") return undefined;
      if (request.method === "Browser.close") return "drop";
      return {
        error: {
          code: -32601,
          message: `'${request.method}' wasn't found`,
        },
      };
    });
    pending.push(endpoint);

    const client = await CdpClient.connect(endpoint.cdpUrl);
    try {
      const first = await client.send("Runtime.evaluate", {
        expression: "1",
      });
      const second = await client.send("Runtime.evaluate", {
        expression: "2",
      });
      expect(first).toEqual({
        value: expect.any(Number),
      });
      expect(second).toEqual({
        value: expect.any(Number),
      });
      expect(
        (
          first as {
            value: number;
          }
        ).value,
      ).not.toBe(
        (
          second as {
            value: number;
          }
        ).value,
      );

      await expect(client.send("Bogus.method")).rejects.toThrow("wasn't found");
      await expect(
        client.send("Page.captureScreenshot", undefined, undefined, 30),
      ).rejects.toThrow("timed out");
      await expect(client.send("Browser.close")).rejects.toThrow("closed");
    } finally {
      await client.close();
    }
  });

  it("reuses an open connection, rejects after close, and stays closed on failure", async () => {
    const endpoint = await fakeCdp(() => ({
      result: {
        ok: true,
      },
    }));
    pending.push(endpoint);

    const client = new CdpClient();
    await client.connect(endpoint.cdpUrl);
    await client.connect(endpoint.cdpUrl);
    expect(endpoint.versionHits).toBe(1);
    expect(endpoint.connectHits).toBe(1);
    await expect(client.send("Browser.getVersion")).resolves.toEqual({
      ok: true,
    });

    await client.close();
    expect(client.state).toBe("closed");
    await expect(client.send("Browser.getVersion")).rejects.toThrow("closed");

    await client.connect(endpoint.cdpUrl);
    expect(endpoint.versionHits).toBe(2);
    expect(endpoint.connectHits).toBe(2);
    await expect(client.send("Browser.getVersion")).resolves.toEqual({
      ok: true,
    });
    await client.close();

    const failed = new CdpClient();
    await expect(failed.connect("http://127.0.0.1:9/")).rejects.toThrow("unreachable");
    expect(failed.state).toBe("closed");
    await expect(failed.send("Browser.getVersion")).rejects.toThrow("closed");
  });

  it("drops events that do not match the bound session", async () => {
    const endpoint = await fakeCdp(() => ({
      result: {},
    }));
    pending.push(endpoint);
    const client = await CdpClient.connect(endpoint.cdpUrl);
    const seen: CdpEvent[] = [];
    client.onEvent((event) => {
      seen.push(event);
    });
    try {
      client.bindSession("session-owned");
      endpoint.sendEvent({
        method: "Log.entryAdded",
        sessionId: "session-other",
        params: {
          entry: {
            text: "other",
          },
        },
      });
      endpoint.sendEvent({
        method: "Log.entryAdded",
        sessionId: "session-owned",
        params: {
          entry: {
            text: "owned",
          },
        },
      });
      endpoint.sendEvent({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "session-other",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(seen).toEqual([
        {
          method: "Log.entryAdded",
          sessionId: "session-owned",
          params: {
            entry: {
              text: "owned",
            },
          },
        },
      ]);
    } finally {
      await client.close();
    }
  });
});
