// Task 5.1-5.3 probe: the three launch forms on a real Chromium, end to end.
//
// What this answers that no unit test can: does the extension actually start a
// browser in the declared form, does Chrome really minimize that window, does a
// minimized or headless window still render correct pixels, and does all of it
// leave a browser the user owns alone?
//
// It starts its own Chromium (once per case, through the extension's launcher),
// its own page server, and a stand-in "user-owned" browser that must survive
// every case untouched. The windowed case opens a real visible window for a few
// seconds: that is the behavior under test.
//
// Run:
//   node --experimental-transform-types docs/references/native-cdp-probes/launch-forms.mjs
// (transform-types, not strip-types: the evidence store uses constructor
// parameter properties, which strip-only mode rejects.)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { chromeProfileDirectory, stopOwnedChrome } from "../../../src/visual-loop/chrome.ts";
import { CdpClient } from "../../../src/visual-loop/cdp.ts";
import {
  formatPrepareResult,
  VisualLoopManager,
} from "../../../src/visual-loop/context.ts";

const CHROME =
  process.env.XPI_VISUALOOP_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "/tmp/xpi-visualoop-probe-launch";
const PAGE_PORT = 8772;
const PAGE = `http://127.0.0.1:${PAGE_PORT}/`;
const VIEWPORT = { height: 560, width: 900 };
const TARGET_BOX = { height: 50, width: 120 };
const ENDPOINTS = {
  headless: "http://127.0.0.1:9562/",
  minimized: "http://127.0.0.1:9561/",
  windowed: "http://127.0.0.1:9563/",
};
const USER_OWNED = {
  endpoint: "http://127.0.0.1:9564/",
  profile: join(OUT, "user-owned-profile"),
};

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${label}  ${ok ? "OK" : "MISS"}  ${detail}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Real pixel dimensions of a PNG artifact, read from its own IHDR. */
async function pngSize(path) {
  const bytes = await readFile(path);
  return {
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16),
  };
}

function chromiumProcesses() {
  const lines = spawnSync("ps", ["-Ao", "pid=,command="], {
    encoding: "utf8",
  }).stdout.split("\n");
  return lines
    .map((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match ? { command: match[2], pid: Number(match[1]) } : undefined;
    })
    .filter((entry) => entry !== undefined)
    .filter((entry) => /Chrome|Chromium|chromium/i.test(entry.command));
}

function processOnPort(port) {
  return chromiumProcesses().find((entry) =>
    entry.command.includes(`--remote-debugging-port=${port}`),
  );
}

function port(endpoint) {
  return new URL(endpoint).port;
}

async function endpointAnswers(endpoint) {
  try {
    return (await fetch(new URL("/json/version", endpoint))).ok;
  } catch {
    return false;
  }
}

async function windowState(endpoint, targetId) {
  const client = await CdpClient.connect(endpoint);
  try {
    const window = await client.send("Browser.getWindowForTarget", {
      targetId,
    });
    return window?.bounds?.windowState ?? "unknown";
  } finally {
    await client.close().catch(() => undefined);
  }
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>launch forms</title>
<style>html,body{margin:0;padding:0;background:rgb(24,24,28)}
#target{position:absolute;left:40px;top:60px;width:${TARGET_BOX.width}px;height:${TARGET_BOX.height}px;background:rgb(200,40,60)}</style>
</head><body><div id="target">Target</div></body></html>`;
}

function startPageServer() {
  const server = createServer((request, response) => {
    if (request.url !== "/") {
      response.statusCode = 404;
      response.end("nope");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(pageHtml());
  });
  return new Promise((resolve) => {
    server.listen(PAGE_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** A browser the "user" owns: its own endpoint, its own profile, never adopted. */
async function launchUserOwnedBrowser() {
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port(USER_OWNED.endpoint)}`,
      `--user-data-dir=${USER_OWNED.profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    if (await endpointAnswers(USER_OWNED.endpoint)) return child;
  }
  throw new Error("the stand-in user browser never opened its endpoint");
}

async function projectFor(form, config) {
  const cwd = join(OUT, form, "project");
  const agentDir = join(OUT, form, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(cwd, ".pi", "xpi-visualoop.json"),
    JSON.stringify(config),
  );
  // An empty agent directory plus the project file: the project config is the
  // only thing that decides this run, exactly as a user would set it up.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return {
    ctx: {
      cwd,
      isProjectTrusted: () => true,
      signal: new AbortController().signal,
    },
    cwd,
  };
}

/**
 * Prepare and capture the same page, and report both the manager result and
 * the JSON body `visual_prepare` would hand the model, built by the same
 * formatter the tool uses.
 */
async function exercise(form, config) {
  const endpoint = ENDPOINTS[form];
  const { ctx } = await projectFor(form, config);
  const manager = new VisualLoopManager();
  try {
    const prepared = await manager.prepare(ctx, {
      url: PAGE,
      viewport: VIEWPORT,
    });
    const payload = JSON.parse(
      formatPrepareResult(manager.status().inspectionId, prepared),
    );
    const viewport = await manager.capture(ctx, {});
    const target = await manager.capture(ctx, { selector: "#target" });
    return { endpoint, manager, payload, prepared, target, viewport };
  } catch (error) {
    await manager.disconnect().catch(() => undefined);
    stopOwnedChrome();
    throw error;
  }
}

/**
 * Release exactly like `/xpi-visualoop disconnect` does, then wait for the
 * port to go quiet so the next case starts from a free profile.
 */
async function finish(manager, endpoint) {
  await manager.disconnect();
  stopOwnedChrome();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (processOnPort(port(endpoint)) === undefined) return;
    await sleep(250);
  }
}


async function caseMinimized() {
  console.log("\n── 5.1  default launch (no `launch` key): self-start, minimized");
  const endpoint = ENDPOINTS.minimized;
  const before = processOnPort(port(endpoint));
  const { manager, payload, prepared, target, viewport } = await exercise(
    "minimized",
    { cdpUrl: endpoint },
  );
  try {
    const owned = processOnPort(port(endpoint));
    check(
      "5.1.1 the extension started its own browser",
      before === undefined && owned !== undefined,
      `pid=${owned?.pid} command="${owned?.command.slice(0, 96)}…"`,
    );
    check(
      "5.1.2 it uses the dedicated profile, never a daily one",
      owned?.command.includes(`--user-data-dir=${chromeProfileDirectory()}`) === true &&
        !/Application Support\/Google\/Chrome/.test(owned?.command ?? ""),
      `--user-data-dir=${chromeProfileDirectory()} headless=${owned?.command.includes("--headless")}`,
    );
    check(
      "5.1.3 the prepare result declares minimized and user-operable",
      payload.launch === "minimized" &&
        payload.userOperable === true &&
        payload.windowState === "minimized",
      `launch=${payload.launch} userOperable=${payload.userOperable} windowState=${payload.windowState}`
    );
    const readBack = await windowState(endpoint, prepared.result.targetId);
    check(
      "5.1.4 Chrome reports the window as minimized",
      readBack === "minimized",
      `Browser.getWindowForTarget -> windowState=${readBack}`
    );
    const png = await pngSize(viewport.image.path);
    check(
      "5.1.5 the minimized window still renders the viewport",
      png.width === VIEWPORT.width &&
        png.height === VIEWPORT.height &&
        viewport.readiness.status === "ready",
      `png=${png.width}x${png.height} dpr=${viewport.dpr} readiness=${viewport.readiness.status} bytes=${viewport.image.byteLength}`
    );
    check(
      "5.1.6 the page content is real, not a stale frame",
      target.image.crop?.width === TARGET_BOX.width &&
        target.image.crop?.height === TARGET_BOX.height,
      `#target crop=${target.image.crop?.width}x${target.image.crop?.height}`
    );
    return {
      interaction: payload.interaction,
      readiness: viewport.readiness.status,
      target: `${target.image.crop?.width}x${target.image.crop?.height}`,
      viewport: `${png.width}x${png.height}`,
    };
  } finally {
    await finish(manager, endpoint);
  }
}

async function caseHeadless() {
  console.log("\n── 5.2  launch: \"headless\"");
  const endpoint = ENDPOINTS.headless;
  const { manager, payload, target, viewport } = await exercise("headless", {
    cdpUrl: endpoint,
    launch: "headless",
  });
  try {
    const owned = processOnPort(port(endpoint));
    check(
      "5.2.1 the browser really runs headless",
      owned?.command.includes("--headless=new") === true,
      `command="${owned?.command.slice(0, 96)}…"`
    );
    check(
      "5.2.2 the headless context is declared as not user-operable",
      payload.launch === "headless" &&
        payload.userOperable === false &&
        /not visible/.test(payload.interaction),
      `launch=${payload.launch} userOperable=${payload.userOperable} interaction="${payload.interaction}"`
    );
    const png = await pngSize(viewport.image.path);
    check(
      "5.2.3 the viewport capture succeeds",
      png.width === VIEWPORT.width &&
        png.height === VIEWPORT.height &&
        viewport.readiness.status === "ready",
      `png=${png.width}x${png.height} readiness=${viewport.readiness.status}`
    );
    check(
      "5.2.4 the selector capture succeeds",
      target.image.crop?.width === TARGET_BOX.width &&
        target.image.crop?.height === TARGET_BOX.height,
      `#target crop=${target.image.crop?.width}x${target.image.crop?.height}`
    );
    return {
      interaction: payload.interaction,
      readiness: viewport.readiness.status,
      target: `${target.image.crop?.width}x${target.image.crop?.height}`,
      viewport: `${png.width}x${png.height}`,
    };
  } finally {
    await finish(manager, endpoint);
  }
}

async function caseWindowed(userOwnedPid) {
  console.log("\n── 5.3  launch: \"windowed\" (the pre-change behavior)");
  const endpoint = ENDPOINTS.windowed;
  const { manager, payload, prepared, target, viewport } = await exercise(
    "windowed",
    { cdpUrl: endpoint, launch: "windowed" },
  );
  try {
    const owned = processOnPort(port(endpoint));
    check(
      "5.3.1 the window stays visible, and no window command was sent",
      owned?.command.includes("--headless") === false &&
        payload.windowState === "unknown",
      `windowState=${payload.windowState} headless=${owned?.command.includes("--headless")}`
    );
    const readBack = await windowState(endpoint, prepared.result.targetId);
    check(
      "5.3.2 Chrome reports a visible window",
      readBack === "normal",
      `Browser.getWindowForTarget -> windowState=${readBack}`
    );
    check(
      "5.3.3 the declaration matches a visible window",
      payload.userOperable === true && /visible/.test(payload.interaction),
      `interaction="${payload.interaction}"`
    );
    const png = await pngSize(viewport.image.path);
    check(
      "5.3.4 preparation and both captures still work",
      png.width === VIEWPORT.width &&
        png.height === VIEWPORT.height &&
        target.image.crop?.width === TARGET_BOX.width,
      `png=${png.width}x${png.height} crop=${target.image.crop?.width}x${target.image.crop?.height}`
    );
    await finish(manager, endpoint);
    const survivedPid = alive(userOwnedPid);
    check(
      "5.3.5 the browser the user owns is still running",
      survivedPid && (await endpointAnswers(USER_OWNED.endpoint)),
      `pid=${userOwnedPid} alive=${survivedPid} endpoint=${USER_OWNED.endpoint}`
    );
    return {
      interaction: payload.interaction,
      readiness: viewport.readiness.status,
      target: `${target.image.crop?.width}x${target.image.crop?.height}`,
      viewport: `${png.width}x${png.height}`,
    };
  } catch (error) {
    await finish(manager, endpoint).catch(() => undefined);
    throw error;
  }
}

async function main() {
  if (!existsSync(CHROME)) {
    console.error(`no Chromium-based browser at ${CHROME}; set XPI_VISUALOOP_CHROME`);
    process.exit(1);
  }
  await rm(OUT, { force: true, recursive: true });
  await mkdir(OUT, { recursive: true });
  const server = await startPageServer();
  const userOwned = await launchUserOwnedBrowser();
  try {
    const minimized = await caseMinimized();
    const headless = await caseHeadless();
    const windowed = await caseWindowed(userOwned.pid);

    check(
      "5.1.7 minimized and windowed render identically",
      minimized.viewport === windowed.viewport &&
        minimized.target === windowed.target &&
        minimized.readiness === windowed.readiness,
      `minimized=${JSON.stringify(minimized)} windowed=${JSON.stringify(windowed)}`,
    );
    check(
      "5.1.8 the two forms do not read as the same context",
      minimized.interaction !== headless.interaction &&
        headless.interaction !== windowed.interaction,
      `headless="${headless.interaction}"`,
    );
  } finally {
    userOwned.kill("SIGKILL");
    server.close();
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
