import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DEFAULT_CDP_URL, ensureEndpoint, probeEndpoint } from "./chrome.ts";

export interface VisualLoopConfig {
  cdpUrl: string;
  glimpseModulePath?: string;
}

interface PartialVisualLoopConfig {
  cdpUrl?: string;
  glimpseModulePath?: string;
  /** Legacy external backend path; rejected with a migration hint. */
  harnessPath?: unknown;
}

export interface ConfigLoadResult {
  config?: VisualLoopConfig;
  diagnostics: string[];
}

const CONFIG_KEYS = new Set([
  "cdpUrl",
  "glimpseModulePath",
]);
const REMOVED_KEYS = new Set([
  "harnessPath",
]);
export const HARNESS_MIGRATION_HINT =
  "harnessPath has been removed: the visual loop now drives Chrome directly over the Chrome DevTools Protocol and no longer uses an external browser backend; delete the harnessPath key from your configuration.";
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

function objectRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
}

export function validateEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("cdpUrl must be a non-empty URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("cdpUrl must be a valid URL");
  }
  if (url.protocol !== "http:") throw new Error("cdpUrl must use http");
  if (!isLoopbackHost(url.hostname)) throw new Error("cdpUrl must use a loopback host");
  if (url.username || url.password)
    throw new Error("cdpUrl must not contain user information");
  if (url.search || url.hash)
    throw new Error("cdpUrl must not contain query or fragment data");
  return url.toString();
}

export function validateLocalPageUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new Error("url must be a non-empty URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
  if (!isLoopbackHost(url.hostname)) throw new Error("url must use a loopback host");
  if (url.username || url.password)
    throw new Error("url must not contain user information");
  return url.toString();
}

function parsePartial(value: unknown, source: string): PartialVisualLoopConfig {
  const record = objectRecord(value, source);
  for (const key of Object.keys(record)) {
    if (REMOVED_KEYS.has(key)) throw new Error(`${source}: ${HARNESS_MIGRATION_HINT}`);
    if (!CONFIG_KEYS.has(key))
      throw new Error(`${source} contains unknown field: ${key}`);
  }
  const result: PartialVisualLoopConfig = {};
  if ("cdpUrl" in record) result.cdpUrl = validateEndpoint(record.cdpUrl);
  if ("glimpseModulePath" in record) {
    if (
      typeof record.glimpseModulePath !== "string" ||
      !isAbsolute(record.glimpseModulePath)
    ) {
      throw new Error(`${source}.glimpseModulePath must be an absolute path`);
    }
    result.glimpseModulePath = resolve(record.glimpseModulePath);
  }
  return result;
}

export function parseConfigText(text: string, source: string): PartialVisualLoopConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  return parsePartial(value, source);
}

async function readConfigFile(
  path: string,
): Promise<PartialVisualLoopConfig | undefined> {
  try {
    return parseConfigText(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadConfig(
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
): Promise<ConfigLoadResult> {
  const diagnostics: string[] = [];
  const merged: PartialVisualLoopConfig = {};
  const userPath = resolve(agentDir, "xpi-visualoop.json");
  try {
    Object.assign(merged, (await readConfigFile(userPath)) ?? {});
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return {
      diagnostics,
    };
  }

  const projectPath = resolve(cwd, ".pi", "xpi-visualoop.json");
  if (!projectTrusted) {
    try {
      if (await readConfigFile(projectPath))
        diagnostics.push(
          "project configuration ignored because the project is untrusted",
        );
    } catch (error) {
      diagnostics.push(
        `project configuration ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    try {
      Object.assign(merged, (await readConfigFile(projectPath)) ?? {});
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      return {
        diagnostics,
      };
    }
  }

  // No cdpUrl anywhere: fall back to the documented default endpoint instead of
  // refusing to start. Every other failure mode stays fail-closed.
  if (!merged.cdpUrl) {
    diagnostics.push(
      `visual loop uses the default CDP endpoint ${DEFAULT_CDP_URL}; set cdpUrl at ${userPath} to change it`,
    );
    return {
      config: {
        cdpUrl: DEFAULT_CDP_URL,
      },
      diagnostics,
    };
  }
  return {
    config: {
      cdpUrl: merged.cdpUrl,
      ...(merged.glimpseModulePath
        ? {
            glimpseModulePath: merged.glimpseModulePath,
          }
        : {}),
      ...(merged.glimpseModulePath
        ? {
            glimpseModulePath: merged.glimpseModulePath,
          }
        : {}),
    },
    diagnostics,
  };
}

export async function resolveCdpWebSocketUrl(
  cdpUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = new URL("/json/version", cdpUrl);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      signal,
    });
  } catch {
    throw new Error("configured CDP endpoint is unreachable");
  }
  if (!response.ok)
    throw new Error(`configured CDP endpoint returned HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("configured CDP endpoint did not return JSON");
  }
  const websocket = objectRecord(payload, "CDP endpoint response").webSocketDebuggerUrl;
  if (typeof websocket !== "string")
    throw new Error("CDP endpoint did not advertise a WebSocket");
  let wsUrl: URL;
  try {
    wsUrl = new URL(websocket);
  } catch {
    throw new Error("CDP WebSocket URL is invalid");
  }
  if (
    (wsUrl.protocol !== "ws:" && wsUrl.protocol !== "wss:") ||
    !isLoopbackHost(wsUrl.hostname)
  ) {
    throw new Error("CDP WebSocket URL must remain on a loopback host");
  }
  return wsUrl.toString();
}

/**
 * Reachability check with one lazy repair step: when nothing listens on the
 * endpoint, start the extension-owned browser once and re-probe. An endpoint
 * that answers but is not CDP is not ours to fix, so its own error wins.
 */
export async function validateEndpointReachability(
  cdpUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await resolveCdpWebSocketUrl(cdpUrl, signal);
    return;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (await probeEndpoint(cdpUrl, signal)) throw error;
    await ensureEndpoint(cdpUrl, signal);
    try {
      await resolveCdpWebSocketUrl(cdpUrl, signal);
    } catch {
      throw error;
    }
  }
}
