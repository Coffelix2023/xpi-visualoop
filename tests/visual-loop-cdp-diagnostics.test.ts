import { afterEach, describe, expect, it } from "vitest";
import { CdpClient } from "../src/visual-loop/cdp.ts";
import { CdpDiagnostics } from "../src/visual-loop/cdp-diagnostics.ts";
import { type FakeCdpEndpoint, fakeCdp } from "./helpers/fake-cdp.ts";

const endpoints: FakeCdpEndpoint[] = [];
const clients: CdpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
});

async function attached(
  handler: (method: string) =>
    | {
        error?: {
          code: number;
          message: string;
        };
      }
    | undefined = () => undefined,
  expectAttached = true,
): Promise<{
  diagnostics: CdpDiagnostics;
  endpoint: FakeCdpEndpoint;
  sessionId: string;
}> {
  const endpoint = await fakeCdp((request) => {
    const refusal = handler(request.method);
    return (
      refusal ?? {
        result: {},
      }
    );
  });
  endpoints.push(endpoint);
  const client = await CdpClient.connect(endpoint.cdpUrl);
  clients.push(client);
  const diagnostics = new CdpDiagnostics();
  const sessionId = "session-1";
  expect(await diagnostics.attach(client, sessionId)).toBe(expectAttached);
  return {
    diagnostics,
    endpoint,
    sessionId,
  };
}

function summary(
  result: ReturnType<CdpDiagnostics["summarize"]>,
  kind: "console" | "network",
) {
  return result[kind];
}

/** Events arrive over a real socket, so let the frames land before reading. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe("CDP diagnostics attachment", () => {
  it("enables runtime, log, and network on the bound session", async () => {
    const seen: Array<{
      method: string;
      sessionId?: string;
    }> = [];
    const endpoint = await fakeCdp((request) => {
      seen.push({
        method: request.method,
        sessionId: request.sessionId,
      });
      return {
        result: {},
      };
    });
    endpoints.push(endpoint);
    const client = await CdpClient.connect(endpoint.cdpUrl);
    clients.push(client);

    const diagnostics = new CdpDiagnostics();
    expect(await diagnostics.attach(client, "session-1")).toBe(true);
    expect(seen).toEqual([
      {
        method: "Runtime.enable",
        sessionId: "session-1",
      },
      {
        method: "Log.enable",
        sessionId: "session-1",
      },
      {
        method: "Network.enable",
        sessionId: "session-1",
      },
    ]);
  });

  it("distinguishes an unattached collector from an observed clean run", async () => {
    const diagnostics = new CdpDiagnostics();
    const never = diagnostics.summarize("2026-09-11T00:00:00.000Z");
    expect(summary(never, "console")).toEqual({
      entries: [],
      status: "unknown",
      truncated: false,
    });
    expect(summary(never, "network")).toEqual({
      entries: [],
      status: "unknown",
      truncated: false,
    });
    expect(summary(never, "console").observedFrom).toBeUndefined();

    const { diagnostics: attachedCollector } = await attached();
    const clean = attachedCollector.summarize("2026-09-11T00:00:10.000Z");
    expect(summary(clean, "console").status).toBe("observed");
    expect(summary(clean, "console").entries).toEqual([]);
    expect(summary(clean, "console").observedFrom).toBeTypeOf("string");
    expect(summary(clean, "console").observedTo).toBe("2026-09-11T00:00:10.000Z");
  });

  it("treats a refused enable as unknown rather than as zero errors", async () => {
    const { diagnostics } = await attached(
      (method) =>
        method === "Network.enable"
          ? {
              error: {
                code: -32601,
                message: "Network.enable is not available",
              },
            }
          : undefined,
      false,
    );
    const result = diagnostics.summarize("2026-09-11T00:00:20.000Z");
    expect(summary(result, "console")).toEqual({
      entries: [],
      status: "unknown",
      truncated: false,
    });
    expect(summary(result, "network").status).toBe("unknown");
  });
});

describe("CDP diagnostics collection", () => {
  it("records console errors, uncaught exceptions, and network failures", async () => {
    const { diagnostics, endpoint, sessionId } = await attached();
    endpoint.sendEvent({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "error",
        args: [
          {
            value: "boom",
          },
          {
            value: {
              nested: true,
            },
          },
        ],
      },
      sessionId,
    });
    endpoint.sendEvent({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        args: [
          {
            value: "noise",
          },
        ],
      },
      sessionId,
    });
    endpoint.sendEvent({
      method: "Runtime.exceptionThrown",
      params: {
        exceptionDetails: {
          text: "Uncaught",
          exception: {
            description:
              "Error: uncaught token=supersecretvalue\n    at http://127.0.0.1:8766/:6:28",
          },
        },
      },
      sessionId,
    });
    endpoint.sendEvent({
      method: "Log.entryAdded",
      params: {
        entry: {
          level: "error",
          source: "javascript",
          text: "deprecated api",
        },
      },
      sessionId,
    });
    endpoint.sendEvent({
      method: "Log.entryAdded",
      params: {
        entry: {
          level: "error",
          source: "network",
          text: "duplicate of the network event below",
        },
      },
      sessionId,
    });
    endpoint.sendEvent({
      method: "Network.responseReceived",
      params: {
        response: {
          status: 404,
          url: "http://127.0.0.1:8766/missing.png?token=supersecretvalue",
        },
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
    endpoint.sendEvent({
      method: "Network.loadingFailed",
      params: {
        canceled: true,
        errorText: "net::ERR_ABORTED",
      },
      sessionId,
    });
    await settle();
    const result = diagnostics.summarize("2026-09-11T00:00:30.000Z");
    const consoleEntries = summary(result, "console").entries;
    expect(consoleEntries.map((entry) => entry.message)).toEqual([
      "boom Object",
      // The stack line survives sanitization but the credential in it does not.
      "Uncaught Error: uncaught token=[redacted]\n    at http://127.0.0.1:8766/:6:28",
      "deprecated api",
    ]);
    expect(summary(result, "network").entries).toEqual([
      {
        kind: "network",
        message: "HTTP 404",
        status: 404,
        url: "http://127.0.0.1",
      },
      {
        kind: "network",
        message: "net::ERR_CONNECTION_REFUSED",
      },
    ]);
    expect(summary(result, "console").truncated).toBe(false);
  });

  it("drops events from other sessions and other observation windows", async () => {
    const { diagnostics, endpoint, sessionId } = await attached();
    endpoint.sendEvent({
      method: "Runtime.consoleAPICalled",
      sessionId: "session-2",
      params: {
        type: "error",
        args: [
          {
            value: "foreign",
          },
        ],
      },
    });
    endpoint.sendEvent({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "error",
        args: [
          {
            value: "mine",
          },
        ],
      },
      sessionId,
    });
    await settle();
    const result = diagnostics.summarize("2026-09-11T00:00:40.000Z");
    expect(summary(result, "console").entries.map((entry) => entry.message)).toEqual([
      "mine",
    ]);
  });

  it("caps entries and reports truncation instead of growing without bound", async () => {
    const { diagnostics, endpoint, sessionId } = await attached();
    for (let index = 0; index < 30; index += 1)
      endpoint.sendEvent({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [
            {
              value: `error-${index}`,
            },
          ],
        },
        sessionId,
      });

    await settle();
    const result = diagnostics.summarize("2026-09-11T00:00:50.000Z");
    expect(summary(result, "console").entries).toHaveLength(20);
    expect(summary(result, "console").entries[0]?.message).toBe("error-0");
    expect(summary(result, "console").truncated).toBe(true);
  });

  it("stops observing once detached", async () => {
    const { diagnostics, endpoint, sessionId } = await attached();
    diagnostics.detach();
    endpoint.sendEvent({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "error",
        args: [
          {
            value: "after detach",
          },
        ],
      },
      sessionId,
    });
    await settle();
    const result = diagnostics.summarize("2026-09-11T00:01:00.000Z");
    expect(summary(result, "console")).toEqual({
      entries: [],
      status: "unknown",
      truncated: false,
    });
  });
});
