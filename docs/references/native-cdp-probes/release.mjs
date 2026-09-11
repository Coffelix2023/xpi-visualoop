// Task 2.10 / 2.11 probe: prove the release path and the four-action end-to-end
// path need no external runtime. Launches its own Chrome on a private profile,
// configures ONLY cdpUrl (no harnessPath), then drives VisualLoopManager.
// Run: node --experimental-strip-types docs/references/native-cdp-probes/release.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

import { join } from "node:path";
import { CdpClient } from "../../../src/visual-loop/cdp.ts";
import { VisualLoopManager } from "../../../src/visual-loop/context.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9557;
const ENDPOINT = `http://127.0.0.1:${PORT}/`;
const PAGE_PORT = 8769;
const PAGE = `http://127.0.0.1:${PAGE_PORT}/`;
const OUT = "/tmp/xpi-visualoop-probe-release";

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${label}  ${ok ? "OK" : "MISS"}  ${detail}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startPageServer() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>release probe</title>
<style>html,body{margin:0;padding:0}body{height:3000px;background:rgb(20,20,20)}
#target{position:absolute;left:40px;top:60px;width:120px;height:50px;background:rgb(200,40,60)}</style>
</head><body><div id="target"></div></body></html>`;
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
      return;
    }
    response.statusCode = 404;
    response.end("nope");
  });
  await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
  return server;
}

async function launchChrome(profileDir) {
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-sync",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    try {
      const response = await fetch(new URL("/json/version", ENDPOINT));
      if (response.ok) return child;
    } catch {
      // Not listening yet.
    }
  }
  throw new Error("dedicated Chrome did not open its debugging port");
}

async function main() {
  await rm(OUT, { force: true, recursive: true });
  await mkdir(OUT, { recursive: true });
  const profileDir = join(OUT, "profile");
  const agentDir = join(OUT, "agent");
  const cwd = join(OUT, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const server = await startPageServer();
  const chrome = await launchChrome(profileDir);
  const chromePid = chrome.pid;

  // The user configuration file must not be consulted: point the agent dir at an
  // empty one, so only the project file below can configure the loop.
  process.env.PI_CODING_AGENT_DIR = agentDir;

  let bystanderId = "";
  const inspection = new CdpClient();
  await inspection.connect(ENDPOINT);
  try {
    // A tab this session must never close. It stands in for the user's own tabs.
    const bystander = await inspection.send("Target.createTarget", {
      background: true,
      url: "about:blank",
    });
    bystanderId = bystander.targetId;

    // 2.11: the only configured key is cdpUrl. No harnessPath, no Python, no
    // browser automation CLI.
    await writeFile(
      join(cwd, ".pi", "xpi-visualoop.json"),
      JSON.stringify({ cdpUrl: ENDPOINT }),
    );

    const manager = new VisualLoopManager();
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      signal: new AbortController().signal,
    };

    const prepared = await manager.prepare(ctx, {
      dpr: 1,
      url: PAGE,
      viewport: { height: 600, width: 800 },
    });
    const ownedId = prepared.result.targetId;
    check(
      "1 prepare without harnessPath",
      ownedId !== "" && prepared.result.page.w === 800,
      `targetId=${ownedId} viewport=${prepared.result.page.w}x${prepared.result.page.h} dpr=${prepared.result.dpr}`,
    );

    const viewport = await manager.capture(ctx, {});
    check(
      "2 capture viewport",
      viewport.image.width === 800 && viewport.image.height === 600,
      `out=${viewport.image.width}x${viewport.image.height} region=${JSON.stringify(viewport.image.sourceRegion)} bytes=${viewport.image.byteLength}`,
    );

    const region = await manager.capture(ctx, { selector: "#target" });
    const crop = region.image.crop;
    check(
      "3 capture region (in-process crop)",
      crop !== undefined &&
        crop.sourceRegion.x === 40 &&
        crop.sourceRegion.y === 60 &&
        crop.width === 120 &&
        crop.height === 50,
      `crop=${crop?.width}x${crop?.height} sourceRegion=${JSON.stringify(crop?.sourceRegion)}`,
    );

    await manager.disconnect();

    // 2.10: reload-style semantics — the same manager refuses work after release.
    let refused = "";
    try {
      await manager.capture(ctx, {});
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    check(
      "4 rejects capture after disconnect",
      refused.includes("not prepared"),
      `error="${refused}"`,
    );

    // 2.10: only the page this session opened was closed.
    const auditor = new CdpClient();
    await auditor.connect(ENDPOINT);
    let bystanderSurvived = false;
    try {
      const info = await auditor.send("Target.getTargetInfo", {
        targetId: bystanderId,
      });
      bystanderSurvived = info?.targetInfo?.targetId === bystanderId;
    } catch {
      bystanderSurvived = false;
    }
    const listed = await fetch(new URL("/json/list", ENDPOINT)).then((response) =>
      response.json(),
    );
    const ownedGone = !listed.some((entry) => entry.id === ownedId);
    check(
      "5 bystander tab still open",
      bystanderSurvived,
      `bystander=${bystanderId} survived=${bystanderSurvived}`,
    );
    check(
      "6 own tab closed",
      ownedGone,
      `owned=${ownedId} gone=${ownedGone} openTabs=${listed.length}`,
    );
    await auditor.close();
  } finally {
    await inspection.close().catch(() => undefined);
  }

  // 2.10: the browser process and its profile directory are left alone.
  check(
    "7 browser process untouched",
    alive(chromePid),
    `pid=${chromePid} alive=${alive(chromePid)}`,
  );
  check(
    "8 profile directory kept",
    existsSync(profileDir),
    `profile=${profileDir} exists=${existsSync(profileDir)}`,
  );

  chrome.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
