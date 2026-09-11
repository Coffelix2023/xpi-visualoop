import type { CdpClient, CdpEvent } from "./cdp.ts";
import { safeDiagnosticUrl, sanitizeDiagnosticMessage } from "./redact.ts";

/** Same cap the legacy harness applied before truncation. */
export const MAX_DIAGNOSTIC_ENTRIES = 20;

export interface CdpDiagnosticEntry {
  kind: "console" | "network";
  message: string;
  status?: number;
  url?: string;
}

/**
 * Structurally identical to the legacy `HarnessDiagnosticSummary` so the
 * switchover in task 2.10 is a type rename, not a shape change.
 */
export interface CdpDiagnosticSummary {
  entries: CdpDiagnosticEntry[];
  observedFrom?: string;
  observedTo?: string;
  status: "observed" | "unknown";
  truncated: boolean;
}

export interface CdpDiagnosticsResult {
  console: CdpDiagnosticSummary;
  network: CdpDiagnosticSummary;
}
type DiagnosticSummary = CdpDiagnosticSummary;

/**
 * Collects console errors and network failures between prepare and capture.
 *
 * Two behaviours differ deliberately from the dismissed external backend:
 * - `unknown` means "this collector was not attached", not "the browser had
 *   nothing to report". Setup failures must not read as a clean run.
 * - Browser events that carry attached data (console arguments, stack traces)
 *   are dropped rather than sanitized; only the plain text fields are read.
 */
export class CdpDiagnostics {
  private attached = false;
  private readonly consoleEntries: DiagnosticSummary["entries"] = [];
  private readonly networkEntries: DiagnosticSummary["entries"] = [];
  private observedFrom = "";
  private unsubscribe?: () => void;

  /** Attaches to one flat session; returns false when the browser refused. */
  async attach(client: CdpClient, sessionId: string): Promise<boolean> {
    this.detach();
    this.consoleEntries.length = 0;
    this.networkEntries.length = 0;
    try {
      // Runtime.enable is required for console API calls and uncaught
      // exceptions; Log.enable alone only reports network-level errors.
      await client.send("Runtime.enable", {}, sessionId);
      await client.send("Log.enable", {}, sessionId);
      await client.send("Network.enable", {}, sessionId);
    } catch {
      this.detach();
      return false;
    }
    this.unsubscribe = client.onEvent((event) => this.record(event, sessionId));
    this.attached = true;
    // The browser does not replay events emitted before enable, so the moment
    // enable returned is the honest start of the observation window.
    this.observedFrom = new Date().toISOString();
    return true;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.attached = false;
  }

  /** Ends the window at the given instant; the window starts when enable returned. */
  summarize(endedAt: string): CdpDiagnosticsResult {
    return {
      console: this.summary(this.consoleEntries, endedAt),
      network: this.summary(this.networkEntries, endedAt),
    };
  }

  private summary(
    entries: DiagnosticSummary["entries"],
    endedAt: string,
  ): DiagnosticSummary {
    // Not attached means "nothing was observed", which must stay distinct from
    // "observed and found no errors" — the browser never replays missed events.
    if (!this.attached) return unknownSummary();
    return {
      entries: entries.slice(0, MAX_DIAGNOSTIC_ENTRIES),
      observedFrom: this.observedFrom,
      observedTo: endedAt,
      status: "observed",
      truncated: entries.length > MAX_DIAGNOSTIC_ENTRIES,
    };
  }

  private record(event: CdpEvent, sessionId: string): void {
    if (event.sessionId !== sessionId) return;
    const params = event.params;
    if (params === undefined) return;
    if (event.method === "Runtime.consoleAPICalled") {
      if (params.type !== "error" && params.type !== "assert") return;
      this.push(this.consoleEntries, "console", consoleMessage(params.args));
      return;
    }
    if (event.method === "Runtime.exceptionThrown") {
      const details = record(params.exceptionDetails);
      this.push(this.consoleEntries, "console", exceptionMessage(details));
      return;
    }
    if (event.method === "Log.entryAdded") {
      const entry = record(params.entry);
      if (entry.level !== "error") return;
      const message = text(entry.text);
      // Network-level errors already arrive as Network.* events with a status;
      // re-reporting the browser's own wording would double every failure.
      if (entry.source === "network") return;
      this.push(
        this.consoleEntries,
        "console",
        message === undefined ? "console error" : sanitizeDiagnosticMessage(message),
      );
      return;
    }
    if (event.method === "Network.responseReceived") {
      const response = record(record(params.response));
      const status = response.status;
      if (typeof status !== "number" || status < 400) return;
      const url = text(response.url);
      this.push(
        this.networkEntries,
        "network",
        `HTTP ${Math.trunc(status)}`,
        status,
        url === undefined ? undefined : safeDiagnosticUrl(url),
      );
      return;
    }
    // Network.loadingFailed also fires with canceled=true when the page itself
    // aborts a request during navigation; that is not a failure to report.
    if (event.method === "Network.loadingFailed" && params.canceled !== true) {
      const errorText = text(params.errorText);
      this.push(
        this.networkEntries,
        "network",
        sanitizeDiagnosticMessage(errorText ?? "loading failed"),
      );
    }
  }

  private push(
    entries: DiagnosticSummary["entries"],
    kind: "console" | "network",
    message: string,
    status?: number,
    url?: string,
  ): void {
    // Keep counting past the cap so `truncated` stays truthful.
    if (entries.length >= MAX_DIAGNOSTIC_ENTRIES * 4) return;
    entries.push({
      kind,
      message,
      ...(status === undefined
        ? {}
        : {
            status,
          }),
      ...(url === undefined
        ? {}
        : {
            url,
          }),
    });
  }
}

function unknownSummary(): DiagnosticSummary {
  return {
    entries: [],
    status: "unknown",
    truncated: false,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function describeArgument(argument: Record<string, unknown>): string | undefined {
  if ("value" in argument) {
    const value = argument.value;
    if (value === null) return "null";
    if (typeof value === "object") return Array.isArray(value) ? "Array" : "Object";
    return typeof value === "string" ? value : String(value);
  }
  return text(argument.description) ?? text(argument.unserializableValue);
}

function consoleMessage(args: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(args))
    for (const argument of args) {
      const value = describeArgument(record(argument));
      if (value !== undefined) parts.push(value);
    }
  return sanitizeDiagnosticMessage(parts.join(" ") || "console error");
}

function exceptionMessage(details: Record<string, unknown>): string {
  const parts: string[] = [];
  const exception = record(details.exception);
  for (const value of [
    details.text,
    text(exception.description),
    text(exception.value),
  ]) {
    const item = text(value);
    if (item !== undefined) parts.push(item);
  }
  return sanitizeDiagnosticMessage(parts.join(" ") || "uncaught exception");
}
