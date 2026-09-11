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
  const parts = samples.map(({ at: [x, y], page, label }) => {
    const got = png.pixel(x, y);
    const want = tileOf(...page);
    const ok = got.join() === want.join() ? "OK  " : "MISS";
    return `${ok} ${label ?? ""} out(${x},${y})=${got.join(",")} want_page(${page.join(",")})=${want.join(",")}`;
  });
  lines.push(`${name}\n  ${png.width}x${png.height} bytes=${buffer.byteLength}\n  ${parts.join("\n  ")}`);
}
await evaluate("scrollTo(0,250)"); await sleep(250);
// viewport-truth reference: no clip
await shot("no-clip @scrollY250 (truth: viewport = page 0,250..800,850)", {}, [
  { at: [0, 0], page: [0, 250], label: "top-left" },
  { at: [799, 599], page: [799, 849], label: "bottom-right" },
]);
await shot("clip(0,250,800x600) scale1 @scrollY250", { clip: { height: 600, scale: 1, width: 800, x: 0, y: 250 } }, [
  { at: [0, 0], page: [0, 250], label: "top-left" }, { at: [799, 599], page: [799, 849], label: "bottom-right" },
]);
await shot("clip(0,250,800x600) scale1 +captureBeyondViewport=false @scrollY250", { captureBeyondViewport: false, clip: { height: 600, scale: 1, width: 800, x: 0, y: 250 } }, [
  { at: [0, 0], page: [0, 250], label: "top-left" }, { at: [799, 599], page: [799, 849], label: "bottom-right" },
]);
await shot("clip(150,700,200x200) +captureBeyondViewport=true @scrollY250 (below fold)", { captureBeyondViewport: true, clip: { height: 200, scale: 1, width: 200, x: 150, y: 700 } }, [
  { at: [0, 0], page: [150, 700], label: "p(150,700)" }, { at: [199, 199], page: [349, 899], label: "p(349,899)" },
]);
await shot("clip(150,700,200x200) +captureBeyondViewport=true, then re-check viewport", { clip: { height: 600, scale: 1, width: 800, x: 0, y: 250 } }, [
  { at: [0, 0], page: [0, 250], label: "top-left after beyond-viewport capture" },
]);
await shot("clip(0,0,800x600) scale1 while scrolled (document origin region)", { clip: { height: 600, scale: 1, width: 800, x: 0, y: 0 } }, [
  { at: [0, 0], page: [0, 0], label: "document origin" },
]);
console.log(lines.join("\n"));
await cdp.send("Target.closeTarget", { targetId: created.targetId });
process.exit(0);
