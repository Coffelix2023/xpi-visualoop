/**
 * chrome — lazily start the extension-owned Chrome that serves the CDP endpoint.
 *
 * The extension starts a browser only when a visual tool needs the endpoint and
 * nothing is listening on it. It never adopts a browser it did not spawn:
 * `stopOwnedChrome()` kills only that child, and the child is reaped on Pi
 * process exit so a crash cannot leave one behind.
 *
 * The refresh path is deliberately absent: a caller that finds a live endpoint
 * uses it as-is, and a caller that finds a dead one starts a new process.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_CDP_URL = "http://127.0.0.1:9333/";

/** Absolute-path override, e.g. a Chromium build outside the two default locations. */
export const CHROME_BINARY_ENV = "XPI_VISUALOOP_CHROME";

const PROFILE_DIRECTORY = ".cache/xpi-visualoop/chrome-profile";
const READY_POLL_MS = 150;
const READY_TIMEOUT_MS = 10_000;

/**
 * Hard ceiling for a single CDP exchange: the endpoint discovery fetch and
 * the WebSocket handshake that follows it. 15 s is a deliberately generous
 * value so a slow cold start is still allowed to win.
 */
export const CDP_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Combine the caller's cancellation with a hard deadline. Every CDP step runs
 * on an endpoint that can accept a connection and then never answer, so a step
 * without its own deadline can hang the caller forever.
 */
export function withDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal
    ? AbortSignal.any([
        signal,
        timeout,
      ])
    : timeout;
}

interface OwnedChrome {
  cdpUrl: string;
  process: ChildProcess;
}

let owned: OwnedChrome | undefined;
let exitHookRegistered = false;

function darwinCandidates(): string[] {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
}

function linuxCandidates(): string[] {
  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ];
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "")
    .split(":")
    .some(
      (directory) => directory.length > 0 && existsSync(resolve(directory, command)),
    );
}

/**
 * Ordered binary candidates. `XPI_VISUALOOP_CHROME` overrides the platform
 * defaults, which is the calibration knob for a browser in an unusual place.
 */
export function chromeCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const override = env[CHROME_BINARY_ENV]?.trim();
  if (override)
    return [
      override,
    ];
  if (platform === "darwin") return darwinCandidates();
  if (platform === "linux") return linuxCandidates();
  return [];
}

export function resolveChromeBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return chromeCandidates(env, platform).find((candidate) =>
    candidate.includes("/") ? existsSync(candidate) : onPath(candidate, env),
  );
}

/** The one profile both the documented manual launch and the automatic launch use. */
export function chromeProfileDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || homedir();
  return resolve(home, PROFILE_DIRECTORY);
}

/** True when something answers HTTP on the CDP endpoint; says nothing about CDP. */
export async function probeEndpoint(
  cdpUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(new URL("/json/version", cdpUrl), {
      signal: withDeadline(signal, CDP_CONNECT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface ReadyOptions {
  deadlineMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

/** Poll until the probe succeeds, the deadline passes, or the caller cancels. */
export async function waitUntilReady(
  probe: (signal?: AbortSignal) => Promise<boolean>,
  options: ReadyOptions = {},
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? READY_POLL_MS;
  const startedAt = Date.now();
  for (;;) {
    if (options.signal?.aborted)
      throw new Error("the visual loop was cancelled while starting the browser");
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    if (remainingMs <= 0)
      throw new Error(
        `the browser did not expose a CDP endpoint within ${deadlineMs} ms`,
      );
    // The probe carries the remaining budget, so a browser that accepts the
    // request and never answers cannot outlive the deadline above.
    if (await probe(withDeadline(options.signal, remainingMs))) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Port for the CDP endpoint. The URL itself is validated by the config parser. */
function endpointPort(cdpUrl: string): string {
  try {
    const parsed = new URL(cdpUrl);
    return parsed.port || "80";
  } catch {
    throw new Error(`the CDP endpoint is not a valid URL: ${cdpUrl}`);
  }
}

function reapOnExit(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => owned?.process.kill());
}

/**
 * Start the extension-owned browser when nothing is listening on `cdpUrl`.
 * Throws with an actionable message when no binary exists or the browser dies
 * before it exposes the endpoint.
 */
export async function ensureEndpoint(
  cdpUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  if (owned && owned.cdpUrl === cdpUrl && owned.process.exitCode === null) {
    await waitUntilReady((probeSignal) => probeEndpoint(cdpUrl, probeSignal), {
      signal,
    });
    return;
  }

  const binary = resolveChromeBinary();
  if (!binary)
    throw new Error(
      `no Chrome or Chromium binary was found; set ${CHROME_BINARY_ENV} to the browser executable, or start one yourself on ${cdpUrl}`,
    );

  const port = endpointPort(cdpUrl);
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${chromeProfileDirectory()}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    {
      detached: false,
      stdio: "ignore",
    },
  );
  owned = {
    cdpUrl,
    process: child,
  };
  reapOnExit();

  let spawnFailure: Error | undefined;
  child.once("error", (error) => {
    spawnFailure = error instanceof Error ? error : new Error(String(error));
  });

  try {
    await waitUntilReady(
      (probeSignal) => {
        if (spawnFailure) throw spawnFailure;
        if (child.exitCode !== null)
          throw new Error(
            `the browser exited with code ${child.exitCode} before exposing ${cdpUrl}`,
          );
        return probeEndpoint(cdpUrl, probeSignal);
      },
      {
        signal,
      },
    );
  } catch (error) {
    stopOwnedChrome();
    throw error;
  }
}

/** Kill only the process this module started; leaves everything else alone. */
export function stopOwnedChrome(): void {
  const child = owned?.process;
  owned = undefined;
  child?.kill();
}
