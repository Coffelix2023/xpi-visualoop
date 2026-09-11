import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

export interface FakeCdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface FakeCdpReply {
  error?: {
    code: number;
    message: string;
  };
  result?: unknown;
}

export interface FakeCdpEndpoint {
  cdpUrl: string;
  close: () => Promise<void>;
  connectHits: number;
  sendEvent: (event: Record<string, unknown>) => void;
  versionHits: number;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function encodeText(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const length = data.length;
  let headerBytes: Buffer;
  if (length < 126) {
    headerBytes = Buffer.alloc(2);
    headerBytes[0] = 0x81;
    headerBytes[1] = length;
  } else if (length < 65536) {
    headerBytes = Buffer.alloc(4);
    headerBytes[0] = 0x81;
    headerBytes[1] = 126;
    headerBytes.writeUInt16BE(length, 2);
  } else {
    headerBytes = Buffer.alloc(10);
    headerBytes[0] = 0x81;
    headerBytes[1] = 127;
    headerBytes.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([
    headerBytes,
    data,
  ]);
}

function decodeFrames(buffer: Buffer): {
  messages: Array<{
    opcode: number;
    payload: Buffer;
  }>;
  rest: Buffer;
} {
  const messages: Array<{
    opcode: number;
    payload: Buffer;
  }> = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if (first === undefined || second === undefined) break;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (cursor + maskLength + length > buffer.length) break;
    let payload = buffer.subarray(cursor + maskLength, cursor + maskLength + length);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.length; index += 1)
        payload[index] = (payload[index] ?? 0) ^ (mask[index & 3] ?? 0);
    }
    messages.push({
      opcode,
      payload,
    });
    offset = cursor + maskLength + length;
  }
  return {
    messages,
    rest: buffer.subarray(offset),
  };
}

export async function fakeCdp(
  handler: (request: FakeCdpRequest) => FakeCdpReply | "drop" | undefined = () => ({
    result: {},
  }),
): Promise<FakeCdpEndpoint> {
  const sockets = new Set<Duplex>();
  const endpoint: FakeCdpEndpoint = {
    cdpUrl: "",
    connectHits: 0,
    versionHits: 0,
    close: async () => undefined,
    sendEvent: (event) => {
      const frame = encodeText(JSON.stringify(event));
      for (const socket of sockets) socket.write(frame);
    },
  };

  const server: Server = createServer((request, response) => {
    if (request.url !== "/json/version") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      response.statusCode = 500;
      response.end();
      return;
    }
    endpoint.versionHits += 1;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser`,
      }),
    );
  });

  server.on("upgrade", (request, socket) => {
    if (request.url !== "/devtools/browser") {
      socket.destroy();
      return;
    }
    const key = header(request, "sec-websocket-key");
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${createHash("sha1").update(`${key}${WS_GUID}`).digest("base64")}`,
        "",
        "",
      ].join("\r\n"),
    );
    endpoint.connectHits += 1;
    sockets.add(socket);
    let leftover: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      leftover = Buffer.concat([
        leftover,
        chunk,
      ]);
      const decoded = decodeFrames(leftover);
      leftover = decoded.rest;
      for (const message of decoded.messages) {
        if (message.opcode === 0x8) {
          socket.end();
          return;
        }
        if (message.opcode !== 0x1) continue;
        let value: unknown;
        try {
          value = JSON.parse(message.payload.toString("utf8"));
        } catch {
          continue;
        }
        if (
          typeof value !== "object" ||
          value === null ||
          typeof (value as FakeCdpRequest).id !== "number" ||
          typeof (value as FakeCdpRequest).method !== "string"
        )
          continue;
        const requestMessage = value as FakeCdpRequest;
        const reply = handler(requestMessage);
        if (reply === "drop") {
          socket.destroy();
          return;
        }
        if (reply === undefined) continue;
        socket.write(
          encodeText(
            JSON.stringify({
              id: requestMessage.id,
              ...(reply.error
                ? {
                    error: reply.error,
                  }
                : {
                    result: reply.result ?? {},
                  }),
            }),
          ),
        );
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fake CDP server has no port");
  endpoint.cdpUrl = `http://127.0.0.1:${address.port}/`;
  endpoint.close = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  return endpoint;
}

/** 1x1 PNG that `pngSize` accepts, used as the screenshot payload. */
export const FAKE_PNG: Buffer = (() => {
  const buffer = Buffer.alloc(24);
  buffer.write("89504e470d0a1a0a", 0, "hex");
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(800, 16);
  buffer.writeUInt32BE(600, 20);
  return buffer;
})();

export interface FakePageOptions {
  /** Nth screenshot onward fails; drives a failed capture. */
  failAfter?: number;
  /** Height of the page's single target element; a size change reads as moved. */
  targetHeight?: number;
  /** Nth target read onward reports no match; drives a lost target. */
  targetMissingAfter?: number;
  /** Heading read from `document.title` in the page-info evaluation. */
  title?: string;
  url?: string;
  /** Page-info read index at which `urlAfter` takes over; drives change detection. */
  urlAfterAt?: {
    read: number;
    url: string;
  };
  viewport?: {
    height: number;
    width: number;
  };
}

function valueReply(result: unknown): FakeCdpReply {
  return {
    result: {
      result: {
        value: result,
      },
    },
  };
}

/**
 * Fake Chrome target that answers exactly the CDP calls the four read-only
 * actions make, so manager-level tests exercise the real action code path
 * without a browser. Only the fields those actions read are synthesized.
 */
export async function fakePage(
  options: FakePageOptions = {},
): Promise<FakeCdpEndpoint> {
  const viewport = options.viewport ?? {
    height: 600,
    width: 800,
  };
  const url = options.url ?? "http://127.0.0.1:8765/";
  const title = options.title ?? "Page";
  const targetHeight = options.targetHeight ?? 40;
  // The page reports what prepare asked for, not the fixture defaults, so a
  // DPR or viewport change is observable the way a real browser reports it.
  let pageReads = 0;
  let targetReads = 0;
  let shots = 0;
  let dpr = 1;
  const size = {
    height: viewport.height,
    width: viewport.width,
  };
  const targets: string[] = [];
  const endpoint = await fakeCdp((request: FakeCdpRequest): FakeCdpReply => {
    const sessionId = request.sessionId;
    switch (request.method) {
      case "Target.createTarget": {
        const targetId = `target-${targets.length + 1}`;
        targets.push(targetId);
        return {
          result: {
            targetId,
          },
        };
      }
      case "Target.attachToTarget":
        return {
          result: {
            sessionId: "session-1",
          },
        };
      case "Target.getTargetInfo": {
        const targetId = String(request.params?.targetId);
        if (!targets.includes(targetId))
          return {
            error: {
              code: -32602,
              message: "No target with given id found",
            },
          };
        return {
          result: {
            targetInfo: {
              targetId,
            },
          },
        };
      }
      case "Target.closeTarget": {
        const targetId = String(request.params?.targetId);
        const index = targets.indexOf(targetId);
        if (index === -1)
          return {
            error: {
              code: -32602,
              message: "No target with given id found",
            },
          };
        targets.splice(index, 1);
        return {
          result: {
            success: true,
          },
        };
      }
      case "Page.captureScreenshot": {
        shots += 1;
        if (options.failAfter !== undefined && shots >= options.failAfter)
          return {
            error: {
              code: -32000,
              message: "capture failed",
            },
          };
        return {
          result: {
            data: FAKE_PNG.toString("base64"),
          },
        };
      }
      case "Emulation.setDeviceMetricsOverride": {
        const params = request.params ?? {};
        dpr = Number(params.deviceScaleFactor ?? dpr);
        size.height = Number(params.height ?? size.height);
        size.width = Number(params.width ?? size.width);
        return {
          result: {},
        };
      }
      case "Runtime.evaluate":
        return valueReply(evaluate(String(request.params?.expression), sessionId));
      default:
        return {
          result: {},
        };
    }
  });

  function evaluate(expression: string, sessionId?: string): unknown {
    if (expression === "location.href") return url;
    if (expression === "document.readyState") return "complete";
    if (expression === "window.devicePixelRatio") return dpr;
    if (expression.includes("document.fonts"))
      return {
        fonts: true,
        images: true,
        readyState: "complete",
      };
    if (expression.includes("document.title")) {
      pageReads += 1;
      const next =
        options.urlAfterAt && pageReads >= options.urlAfterAt.read
          ? options.urlAfterAt.url
          : url;
      return {
        h: size.height,
        ph: size.height,
        pw: size.width,
        sx: 0,
        sy: 0,
        title,
        url: next,
        w: size.width,
      };
    }
    // The picker script is the only evaluation that enumerates every element.
    if (expression.includes('querySelectorAll("*")'))
      return [
        {
          role: "button",
          selector: "#target",
          text: "Target",
          bounds: {
            height: 40,
            width: 100,
            x: 20,
            y: 30,
          },
          documentBounds: {
            height: 40,
            width: 100,
            x: 20,
            y: 30,
          },
          visibleBounds: {
            height: 40,
            width: 100,
            x: 20,
            y: 30,
          },
        },
      ];
    if (expression.includes("getComputedStyle")) {
      targetReads += 1;
      if (
        options.targetMissingAfter !== undefined &&
        targetReads >= options.targetMissingAfter
      )
        return {
          error: "no-match",
        };
      return {
        selector: "#target",
        styles: {},
        text: "Target",
        accessibility: {
          description: "",
          label: "",
          role: "",
        },
        bounds: {
          height: targetHeight,
          width: 100,
          x: 20,
          y: 30,
        },
        documentBounds: {
          height: targetHeight,
          width: 100,
          x: 20,
          y: 30,
        },
        visibleBounds: {
          height: targetHeight,
          width: 100,
          x: 20,
          y: 30,
        },
      };
    }
    if (expression.includes("querySelectorAll"))
      return options.targetMissingAfter !== undefined &&
        targetReads >= options.targetMissingAfter
        ? null
        : {
            documentBounds: {
              height: targetHeight,
              width: 100,
              x: 20,
              y: 30,
            },
          };
    void sessionId;
    return 1;
  }

  return endpoint;
}
