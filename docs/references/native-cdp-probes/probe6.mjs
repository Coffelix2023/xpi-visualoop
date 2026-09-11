import { resolveCdp } from "./cdp-helper.mjs";
import { decodePng } from "./png.mjs";
const ENDPOINT = "http://127.0.0.1:9556/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.addEventListener("open", () => res()); this.ws.addEventListener("error", () => rej(new Error("ws error"))); });
    this.ws.addEventListener("message", (event) => {
      const value = JSON.parse(typeof event.data === "string" ? event.data : "");
      if (typeof value.id !== "number") return;
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      if (value.error) pending.reject(new Error(JSON.stringify(value.error))); else pending.resolve(value.result);
    });
  }
  send(method, params, sessionId) {
    const id = this.id++;
    return new Promise((resolve, reject) => { this.pending.set(id, { reject, resolve }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
}
function tileOf(pageX, pageY) {
  const row = Math.floor(pageY / 100);
  const column = Math.floor(pageX / 100);
  return [row * 20, column * 30, (row + column) * 10];
}
const cdp = new Cdp(await resolveCdp(ENDPOINT));
await cdp.connect();
const created = await cdp.send("Target.createTarget", { background: true, url: "about:blank" });
const attached = await cdp.send("Target.attachToTarget", { flatten: true, targetId: created.targetId });
const session = attached.sessionId;
await cdp.send("Page.enable", {}, session);
await cdp.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 600, mobile: false, width: 800 }, session);
await cdp.send("Page.navigate", { url: "http://127.0.0.1:8767/" }, session);
await sleep(800);
async function evaluate(expression) {
  const payload = await cdp.send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true }, session);
  if (payload.exceptionDetails) throw new Error(payload.exceptionDetails.text);
  return payload.result.value;
}
const lines = [];
async function shot(name, params, samples) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", ...params }, session);
  const buffer = Buffer.from(result.data, "base64");
  const png = decodePng(buffer);
  const parts = samples.map(([label, x, y, pageX, pageY]) => {
    const got = png.pixel(x, y);
    const want = tileOf(pageX, pageY);
    return `${got.join() === want.join() ? "OK  " : "MISS"} ${label} out(${x},${y})=${got.join(",")} want_page(${pageX},${pageY})=${want.join(",")}`;
  });
  lines.push(`${name}\n  ${png.width}x${png.height} bytes=${buffer.byteLength}\n  ${parts.join("\n  ")}`);
}
await evaluate("scrollTo(0,0)"); await sleep(200);
for (const dpr of [1, 2]) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: dpr, height: 600, mobile: false, width: 800 }, session);
  await evaluate("scrollTo(0,0)"); await sleep(250);
  for (const scale of [1, 0.75, 0.5]) {
    await shot(`dpr${dpr} clip(150,250,400x400) scale${scale} +beyondViewport`, { captureBeyondViewport: true, clip: { height: 400, scale, width: 400, x: 150, y: 250 } }, [
      ["top-left", 0, 0, 150, 250],
    ]);
  }
  const scaled = await cdp.send("Page.captureScreenshot", { captureBeyondViewport: true, clip: { height: 400, scale: 0.5, width: 400, x: 150, y: 250 }, format: "png" }, session);
  const png = decodePng(Buffer.from(scaled.data, "base64"));
  // At scale 0.5 a 400x400 dip region becomes 200 CSS px wide; the tile at page (349,449) should land at the last pixel.
  lines.push(`dpr${dpr} scale0.5 corner check: ${png.width}x${png.height} out(last)=${png.pixel(png.width - 1, png.height - 1).join(",")} want_page(349,449)=${tileOf(349, 449).join(",")}`);
}
console.log(lines.join("\n"));
await cdp.send("Target.closeTarget", { targetId: created.targetId });
process.exit(0);
