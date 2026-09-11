import { resolveCdp } from "./cdp-helper.mjs";
const ENDPOINT = "http://127.0.0.1:9556/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.events = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.addEventListener("open", () => res()); this.ws.addEventListener("error", () => rej(new Error("ws error"))); });
    this.ws.addEventListener("message", (event) => {
      const value = JSON.parse(typeof event.data === "string" ? event.data : "");
      if (typeof value.id !== "number") { this.events.push(value); return; }
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
const cdp = new Cdp(await resolveCdp(ENDPOINT));
await cdp.connect();

async function run(label, enableRuntime) {
  const created = await cdp.send("Target.createTarget", { background: true, url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { flatten: true, targetId: created.targetId });
  const session = attached.sessionId;
  await cdp.send("Page.enable", {}, session);
  await cdp.send("Log.enable", {}, session);
  await cdp.send("Network.enable", {}, session);
  if (enableRuntime) await cdp.send("Runtime.enable", {}, session);
  cdp.events.length = 0;
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:8766/" }, session);
  await sleep(3000);
  const out = {
    consoleApi: cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled").map((e) => ({ args: (e.params.args || []).map((a) => a.value ?? a.description ?? a.unserializableValue), type: e.params.type })),
    consoleApiException: cdp.events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => ({ text: e.params.exceptionDetails.text, description: e.params.exceptionDetails.exception?.description })),
    log: cdp.events.filter((e) => e.method === "Log.entryAdded").map((e) => ({ level: e.params.entry.level, source: e.params.entry.source, text: e.params.entry.text.slice(0, 120) })),
  };
  console.log(label, JSON.stringify(out, null, 2));
  await cdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
}
await run("A: Runtime.enable OFF", false);
await run("B: Runtime.enable ON", true);
process.exit(0);
