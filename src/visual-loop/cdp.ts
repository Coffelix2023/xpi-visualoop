import { resolveCdpWebSocketUrl } from "./config.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedError(): Error {
  return new Error("CDP connection is closed");
}

export class CdpClient {
  private listeners = new Set<(event: CdpEvent) => void>();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private sessionId?: string;
  private socket?: WebSocket;
  private url?: string;

  get state(): "closed" | "open" {
    return this.socket?.readyState === WebSocket.OPEN ? "open" : "closed";
  }

  static async connect(cdpUrl: string, signal?: AbortSignal): Promise<CdpClient> {
    const client = new CdpClient();
    await client.connect(cdpUrl, signal);
    return client;
  }

  bindSession(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.url = undefined;
    this.sessionId = undefined;
    this.failPending(closedError());
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.socket = undefined;
      return;
    }
    this.socket = undefined;
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      socket.addEventListener("close", finish, {
        once: true,
      });
      socket.close();
      if (socket.readyState === WebSocket.CLOSED) finish();
    });
  }

  async connect(cdpUrl: string, signal?: AbortSignal): Promise<void> {
    if (this.state === "open" && this.url === cdpUrl) return;
    if (this.socket) await this.close();
    const wsUrl = await resolveCdpWebSocketUrl(cdpUrl, signal);
    await this.openSocket(wsUrl, signal);
    this.url = cdpUrl;
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(closedError());
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP request timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        reject,
        resolve,
        timer,
      });
      socket.send(
        JSON.stringify({
          id,
          method,
          ...(params === undefined
            ? {}
            : {
                params,
              }),
          ...(sessionId === undefined
            ? {}
            : {
                sessionId,
              }),
        }),
      );
    });
  }

  private dispatchEvent(event: CdpEvent): void {
    if (this.sessionId !== undefined && event.sessionId !== this.sessionId) return;
    for (const listener of this.listeners) listener(event);
  }

  private failPending(error: Error): void {
    const pending = [
      ...this.pending.values(),
    ];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private handleMessage(raw: unknown): void {
    const text = typeof raw === "string" ? raw : undefined;
    if (text === undefined) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.id === "number") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (isRecord(value.error)) {
        pending.reject(
          new Error(
            typeof value.error.message === "string"
              ? value.error.message
              : "CDP request failed",
          ),
        );
        return;
      }
      pending.resolve(value.result);
      return;
    }
    if (typeof value.method !== "string") return;
    this.dispatchEvent({
      method: value.method,
      ...(isRecord(value.params)
        ? {
            params: value.params,
          }
        : {}),
      ...(typeof value.sessionId === "string"
        ? {
            sessionId: value.sessionId,
          }
        : {}),
    });
  }

  private openSocket(wsUrl: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          this.socket = undefined;
          socket.close();
          reject(error);
          return;
        }
        resolve();
      };
      const onAbort = () => {
        finish(new Error("CDP connection cancelled"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, {
        once: true,
      });
      socket.addEventListener("open", () => finish());
      socket.addEventListener("error", () => {
        if (!settled) finish(new Error("CDP WebSocket failed"));
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = undefined;
        this.url = undefined;
        this.failPending(closedError());
        if (!settled) finish(new Error("CDP WebSocket failed"));
      });
    });
  }
}
