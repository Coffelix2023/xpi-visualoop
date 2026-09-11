import { resolveCdp } from "./cdp-helper.mjs";
import { decodePng } from "./png.mjs";

const ENDPOINT = "http://127.0.0.1:9556/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error("ws error")));
    });
    this.ws.addEventListener("message", (event) => {
      const value = JSON.parse(typeof event.data === "string" ? event.data : "");
      if (typeof value.id !== "number") return;
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      if (value.error) pending.reject(new Error(JSON.stringify(value.error)));
      else pending.resolve(value.result);
    });
  }
  send(method, params, sessionId) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const cdp = new Cdp(await resolveCdp(ENDPOINT));
await cdp.connect();
const version = await cdp.send("Browser.getVersion");
const created = await cdp.send("Target.createTarget", { background: true, url: "about:blank" });
const attached = await cdp.send("Target.attachToTarget", { flatten: true, targetId: created.targetId });
const session = attached.sessionId;
await cdp.send("Page.enable", {}, session);
await cdp.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 600, mobile: false, width: 800 }, session);
await cdp.send("Page.navigate", { url: "http://127.0.0.1:8765/" }, session);
await sleep(800);

async function evaluate(expression) {
  const payload = await cdp.send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true }, session);
  if (payload.exceptionDetails) throw new Error(payload.exceptionDetails.text);
  return payload.result.value;
}

const lines = [];
function report(name, png, byteLength, picks) {
  const sample = picks.map(([label, x, y]) => `${label}=${png.pixel(x, y).join(",")}@${x},${y}`).join(" ");
  lines.push(`${name.padEnd(46)} ${String(png.width).padStart(5)}x${String(png.height).padEnd(5)} bytes=${String(byteLength).padStart(6)}  ${sample}`);
}
async function shot(name, params, picks) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", ...params }, session);
  const buffer = Buffer.from(result.data, "base64");
  report(name, decodePng(buffer), buffer.byteLength, picks);
}
async function metrics(dpr) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: dpr, height: 600, mobile: false, width: 800 }, session);
  await evaluate("scrollTo(0,0)");
  await sleep(200);
}
// Page layout: bands y0-100 black(0,0,0), y100-200 red(255,0,0), y200-300 green, y300-400 blue, y400-500 white,
// then gray body (128). Columns: y600-700 x200-300 = 60, x300-400 = 120, x400-500 = 180.

await metrics(1);
await shot("dpr1 viewport @scrollY0", {}, [["band0", 10, 50], ["band1", 10, 150], ["band4", 10, 450], ["gray", 10, 550]]);
await shot("dpr1 clip(200,600,300x100,scale1)", { clip: { height: 100, scale: 1, width: 300, x: 200, y: 600 } }, [["p250", 50, 50], ["p350", 150, 50], ["p450", 250, 50]]);
await shot("dpr1 clip(200,600,300x100,scale1) +captureBeyondViewport", { captureBeyondViewport: true, clip: { height: 100, scale: 1, width: 300, x: 200, y: 600 } }, [["p250", 50, 50], ["p350", 150, 50], ["p450", 250, 50]]);
await shot("dpr1 clip frac(100.4,100.4,99.2x99.2,scale1)", { clip: { height: 99.2, scale: 1, width: 99.2, x: 100.4, y: 100.4 } }, [["p150", 50, 50]]);
await evaluate("scrollTo(0,250)");
await sleep(200);
await shot("dpr1 viewport @scrollY250", {}, [["y250", 10, 10], ["y350", 10, 110]]);
await shot("dpr1 clip(200,600,300x100,scale1) @scrollY250", { clip: { height: 100, scale: 1, width: 300, x: 200, y: 600 } }, [["p250", 50, 50], ["p350", 150, 50]]);
await shot("dpr1 viewport-clip(0,0,800x600,scale1) @scrollY250", { clip: { height: 600, scale: 1, width: 800, x: 0, y: 0 } }, [["p250", 50, 50]]);

await metrics(2);
await shot("dpr2 viewport @scrollY0", {}, [["band0", 10, 50], ["band1", 10, 250], ["band2", 10, 450]]);
await shot("dpr2 clip(200,600,300x100,scale1)", { clip: { height: 100, scale: 1, width: 300, x: 200, y: 600 } }, [["p250", 50, 50], ["p350", 150, 50], ["p450", 250, 50]]);
await shot("dpr2 clip(200,600,300x100,scale0.5)", { clip: { height: 100, scale: 0.5, width: 300, x: 200, y: 600 } }, [["p250", 25, 25], ["p350", 75, 25], ["p450", 125, 25]]);
await shot("dpr2 clip(0,0,800x600,scale1)", { clip: { height: 600, scale: 1, width: 800, x: 0, y: 0 } }, [["band0", 10, 50], ["band1", 10, 250]]);

await metrics(1);
await shot("dpr1 clip(0,0,800x600,scale1)", { clip: { height: 600, scale: 1, width: 800, x: 0, y: 0 } }, [["band0", 10, 50], ["band1", 10, 150]]);
await shot("dpr1 clip(0,0,6000x4000,scale1)", { clip: { height: 4000, scale: 1, width: 6000, x: 0, y: 0 } }, [["band0", 10, 50]]);
await shot("dpr1 viewport 800x600 (no clip) after big clip", {}, [["band0", 10, 50], ["band1", 10, 150]]);

console.log(lines.join("\n"));
console.log(JSON.stringify({ chrome: version.product }));
await cdp.send("Target.closeTarget", { targetId: created.targetId });
process.exit(0);
