// Task 4.1 probe: the full loop on a dedicated Chrome — prepare, capture, verify
// with the same declared state, the silent-caller rejection, and one human
// feedback round through the real Glimpse panel.
//
// The feedback step is deliberately interactive: Glimpse opens a native window
// and this script waits for you to submit or cancel it. Everything else runs
// unattended.
//
// Run:
//   node --experimental-transform-types docs/references/native-cdp-probes/verify.mjs
// (transform-types, not strip-types: the evidence store uses constructor
// parameter properties, which strip-only mode rejects.)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { CdpClient } from "../../../src/visual-loop/cdp.ts";
import { VisualLoopManager } from "../../../src/visual-loop/context.ts";
import {
  comparisonPanelInput,
  embedFeedbackImage,
  feedbackPanelInput,
  loadGlimpse,
  renderFeedbackPanel,
  validateFeedbackBridgeMessage,
  waitForFeedbackPanel,
} from "../../../src/visual-loop/feedback.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9558;
const ENDPOINT = `http://127.0.0.1:${PORT}/`;
const PAGE_PORT = 8770;
const PAGE = `http://127.0.0.1:${PAGE_PORT}/`;
const OUT = "/tmp/xpi-visualoop-probe-verify";

const STATE_LABEL = "dialog-open";

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

/**
 * One URL, two versions. The first load is the baseline; every later load is the
 * "edit". Keeping the URL stable is what makes the comparison comparable: a
 * navigation to a different path would be reported as a page URL change.
 */
function pageHtml(fill) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>verify probe</title>
<style>html,body{margin:0;padding:0;background:rgb(20,20,20)}
#target{position:absolute;left:40px;top:60px;width:120px;height:50px;background:${fill}}</style>
</head><body><div id="target">Target</div></body></html>`;
}

async function startPageServer() {
  let loads = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/") {
      response.statusCode = 404;
      response.end("nope");
      return;
    }
    loads += 1;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(pageHtml(loads === 1 ? "rgb(200, 40, 60)" : "rgb(40, 120, 220)"));
  });
  await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
  return server;
}

async function launchChrome() {
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${join(OUT, "profile")}`,
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
  const agentDir = join(OUT, "agent");
  const cwd = join(OUT, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const server = await startPageServer();
  const chrome = await launchChrome();
  const chromePid = chrome.pid;

  // The agent directory is empty, so only the project file below can configure
  // the loop — this is the 2.11 "no external runtime" stance holding.
  process.env.PI_CODING_AGENT_DIR = agentDir;
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

  const version = await fetch(new URL("/json/version", ENDPOINT)).then((r) => r.json());
  const pi = spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout?.trim();
  console.log(
    `versions  Pi=${pi || "unknown"}  Chrome=${version.Browser}  Node=${process.version}  OS=${process.platform}\n`,
  );

  try {
    const prepared = await manager.prepare(ctx, {
      stateLabel: STATE_LABEL,
      url: PAGE,
      viewport: { height: 600, width: 800 },
    });
    check(
      "1  prepare",
      prepared.result.targetId !== "" && prepared.result.page.w === 800,
      `targetId=${prepared.result.targetId} viewport=${prepared.result.page.w}x${prepared.result.page.h} stateLabel=${prepared.stateLabel}`,
    );

    const before = await manager.capture(ctx, {
      selector: "#target",
      stateLabel: STATE_LABEL,
    });
    check(
      "2  baseline capture",
      before.image.crop !== undefined && before.image.crop.width === 120,
      `captureId=${before.captureId} readiness=${before.readiness.status} crop=${before.image.crop?.width}x${before.image.crop?.height} bytes=${before.image.byteLength}`,
    );

    // A silent caller must be refused, not silently handed the baseline's claim.
    let refusal = "";
    try {
      await manager.verify(ctx, before.captureId);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check(
      "3  silent caller rejected",
      refusal.includes("pass the same stateLabel"),
      `error="${refusal}"`,
    );

    // Re-prepare: the same URL now serves the edited version.
    await manager.prepare(ctx, {
      stateLabel: STATE_LABEL,
      url: PAGE,
      viewport: { height: 600, width: 800 },
    });

    const verified = await manager.verify(ctx, before.captureId, {
      stateLabel: STATE_LABEL,
    });
    check(
      "4  verify with the same declared state",
      verified.comparison.status === "comparable" && verified.after !== undefined,
      `status=${verified.comparison.status} after=${verified.comparison.afterCaptureId} commonRegion=${JSON.stringify(verified.comparison.commonRegion?.region)}`,
    );
    check(
      "5  edit reported as an observed change",
      verified.comparison.targetChanges.status === "changed",
      `targetChanges=${verified.comparison.targetChanges.status} fields=${JSON.stringify(verified.comparison.targetChanges.changedFields)}`,
    );

    // One human feedback round through the real panel.
    // Set PROBE_SKIP_FEEDBACK=1 to validate the rest of the loop without a
    // human at the panel.
    const glimpse = process.env.PROBE_SKIP_FEEDBACK ? null : await loadGlimpse();
    if (!glimpse) {
      console.log(
        process.env.PROBE_SKIP_FEEDBACK
          ? "6  glimpse feedback round  SKIPPED  (PROBE_SKIP_FEEDBACK=1)"
          : "6  glimpse feedback round  MISS  glimpse module not found",
      );
      if (!process.env.PROBE_SKIP_FEEDBACK) failures += 1;
    } else {
      console.log(
        "\n>>> A Glimpse window opens now. Type a comment, drag a region if you\n>>> like, then click Submit. Clicking Cancel is also a valid result.\n",
      );
      const reviewed = verified.after ?? before;
      const feedback = await manager.runFeedback(
        reviewed.captureId,
        undefined,
        async (signal, registerClose) => {
          const message = await waitForFeedbackPanel(
            glimpse,
            renderFeedbackPanel(
              await embedFeedbackImage(
                verified.after
                  ? comparisonPanelInput(verified.comparison, before, verified.after)
                  : feedbackPanelInput(reviewed),
              ),
            ),
            {
              height: 840,
              timeout: 5 * 60 * 1000,
              title: verified.after ? "Visual comparison" : "Visual feedback",
              width: verified.after ? 1280 : 1000,
            },
            signal,
            registerClose,
          );
          const outcome = validateFeedbackBridgeMessage(
            message,
            reviewed.image,
            Boolean(verified.after),
          );
          if (outcome.status !== "submitted")
            return {
              comparisonId: verified.comparison.comparisonId,
              status: outcome.status,
            };
          return {
            comparisonId: verified.comparison.comparisonId,
            feedback: manager.addFeedback(
              reviewed.captureId,
              outcome.draft.comment,
              outcome.draft.region,
              verified.comparison.comparisonId,
            ),
            status: outcome.status,
          };
        },
      );
      check(
        "6  glimpse feedback round",
        feedback !== null && typeof feedback === "object" && "status" in feedback,
        `result=${JSON.stringify(feedback)}`,
      );
    }

    // Read the evidence back before the release path deletes the session directory.
    const bytes = await Promise.all([
      readFile(before.image.path).catch(() => undefined),
      readFile(verified.after?.image.path ?? before.image.path).catch(() => undefined),
    ]);

    const ownTargetId = prepared.result.targetId;
    await manager.disconnect();
    let stillOpen = true;
    try {
      await manager.capture(ctx, {});
    } catch {
      stillOpen = false;
    }
    check("7  refuses work after disconnect", !stillOpen, `status=${manager.status().state}`);

    const auditor = new CdpClient();
    await auditor.connect(ENDPOINT);
    const listed = await fetch(new URL("/json/list", ENDPOINT)).then((r) => r.json());
    await auditor.close();
    check(
      "8  own tab closed",
      !listed.some((entry) => entry.id === ownTargetId),
      `owned=${ownTargetId} openTabs=${listed.length}`,
    );
    check("9  browser process untouched", alive(chromePid), `pid=${chromePid}`);
    check("10 profile directory kept", existsSync(join(OUT, "profile")), OUT);

    check(
      "11 evidence read back while the session is live",
      bytes.every((value) => (value?.byteLength ?? 0) > 0),
      `bytes=${bytes.map((value) => value?.byteLength ?? 0).join("/")}`,
    );
  } finally {
    await manager.disconnect().catch(() => undefined);
  }

  chrome.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
