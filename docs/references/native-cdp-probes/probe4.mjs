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
// tile color for page coordinate: rgb(floor(y/100)*20, floor(x/100)*30, (floor(y/100)+floor(x/100))*10)
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
await sleep(700);
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
  const parts = samples.map(({ at: [x, y], page }) => {
    const got = png.pixel(x, y);
    const want = tileOf(...page);
    const ok = got.join() === want.join() ? "OK  " : "MISS";
    return `${ok} out(${x},${y})=${got.join(",")} want_page(${page.join(",")})=${want.join(",")}`;
  });
  lines.push(`${name}\n  ${png.width}x${png.height} bytes=${buffer.byteLength}\n  ${parts.join("\n  ")}`);
}
await evaluate("scrollTo(0,0)"); await sleep(200);
await shot("A dpr1 scrollY0  clip(150,250,200x200) scale1", { clip: { height: 200, scale: 1, width: 200, x: 150, y: 250 } }, [
  { at: [0, 0], page: [150, 250] }, { at: [50, 50], page: [200, 300] }, { at: [199, 199], page: [349, 449] },
]);
await shot("B dpr1 scrollY0  clip(150,250,200x200) scale1 +captureBeyondViewport=false", { captureBeyondViewport: false, clip: { height: 200, scale: 1, width: 200, x: 150, y: 250 } }, [
  { at: [0, 0], page: [150, 250] }, { at: [50, 50], page: [200, 300] },
]);
await shot("C dpr1 scrollY0  clip(150,250,199.6x199.6) scale1 fractional size", { clip: { height: 199.6, scale: 1, width: 199.6, x: 150, y: 250 } }, [
  { at: [0, 0], page: [150, 250] }, { at: [50, 50], page: [200, 300] },
]);
await shot("D dpr1 scrollY0  clip(150.5,250.5,200x200) scale1 fractional origin", { clip: { height: 200, scale: 1, width: 200, x: 150.5, y: 250.5 } }, [
  { at: [0, 0], page: [150, 250] }, { at: [1, 1], page: [151, 251] }, { at: [50, 50], page: [201, 301] },
]);
await shot("E dpr1 scrollY0  clip(150,700,200x200) below viewport", { clip: { height: 200, scale: 1, width: 200, x: 150, y: 700 } }, [
  { at: [0, 0], page: [150, 700] }, { at: [50, 50], page: [200, 750] },
]);
await evaluate("scrollTo(0,250)"); await sleep(250);
await shot("F dpr1 scrollY250 clip(150,250,200x200)", { clip: { height: 200, scale: 1, width: 200, x: 150, y: 250 } }, [
  { at: [0, 0], page: [150, 250] }, { at: [50, 50], page: [200, 300] },
]);
await shot("G dpr1 scrollY250 clip(150,400,200x200)", { clip: { height: 200, scale: 1, width: 200, x: 150, y: 400 } }, [
  { at: [0, 0], page: [150, 400] }, { at: [50, 50], page: [200, 450] },
]);
await cdp.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 2, height: 600, mobile: false, width: 800 }, session);
await evaluate("scrollTo(0,0)"); await sleep(250);
await shot("H dpr2 scrollY0  clip(150,250,200x200) scale1", { clip: { height: 200, scale: 1, width: 200, x: 150, y: 250 } }, [
  { at: [0, 0], page: [150, 250] }, { at: [100, 100], page: [200, 300] }, { at: [399, 399], page: [349, 449] },
]);
await shot("I dpr2 scrollY0  clip(150,250,200x200) scale0.5", { clip: { height: 200, scale: 0.5, width: 200, x: 150, y: 250 } }, [
  { at: [0, 0], page: [150, 250] }, { at: [50, 50], page: [200, 300] }, { at: [199, 199], page: [349, 449] },
]);
console.log(lines.join("\n"));
await cdp.send("Target.closeTarget", { targetId: created.targetId });
process.exit(0);
