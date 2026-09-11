import { resolveCdp } from "./cdp-helper.mjs";
const ENDPOINT = "http://127.0.0.1:9556/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.events = []; this.listeners = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error("ws error")));
    });
    this.ws.addEventListener("message", (event) => {
      const value = JSON.parse(typeof event.data === "string" ? event.data : "");
      if (typeof value.id !== "number") {
        this.events.push(value);
        return;
      }
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
const created = await cdp.send("Target.createTarget", { background: true, url: "about:blank" });
const attached = await cdp.send("Target.attachToTarget", { flatten: true, targetId: created.targetId });
const session = attached.sessionId;

const results = {};
// Case A: enable before navigate (the designed flow)
await cdp.send("Page.enable", {}, session);
await cdp.send("Log.enable", {}, session);
await cdp.send("Network.enable", {}, session);
await cdp.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 600, mobile: false, width: 800 }, session);
cdp.events.length = 0;
await cdp.send("Page.navigate", { url: "http://127.0.0.1:8766/" }, session);
await sleep(3000);
const afterNavigate = cdp.events.map((e) => e.method);
results.enabledBeforeNavigate = {
  counts: afterNavigate.reduce((acc, m) => ({ ...acc, [m]: (acc[m] ?? 0) + 1 }), {}),
  consoleEntries: cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled").map((e) => e.params.type),
  logEntries: cdp.events.filter((e) => e.method === "Log.entryAdded").map((e) => ({ level: e.params.entry.level, source: e.params.entry.source, text: e.params.entry.text })),
  networkFailed: cdp.events.filter((e) => e.method === "Network.loadingFailed").map((e) => ({ errorText: e.params.errorText, type: e.params.type, canceled: e.params.canceled })),
  networkReceived4xx: cdp.events.filter((e) => e.method === "Network.responseReceived" && e.params.response.status >= 400).map((e) => ({ status: e.params.response.status, url: e.params.response.url })),
  otherMethods: [...new Set(afterNavigate)].filter((m) => !m.startsWith("Network.") && !m.startsWith("Runtime.") && !m.startsWith("Log.")),
};

// Case B: no Log.enable -> does Runtime.consoleAPICalled still arrive?
await cdp.send("Target.closeTarget", { targetId: created.targetId });
const created2 = await cdp.send("Target.createTarget", { background: true, url: "about:blank" });
const attached2 = await cdp.send("Target.attachToTarget", { flatten: true, targetId: created2.targetId });
const session2 = attached2.sessionId;
cdp.events.length = 0;
await cdp.send("Page.navigate", { url: "http://127.0.0.1:8766/" }, session2);
await sleep(2500);
results.withoutAnyEnable = {
  consoleEntries: cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled").length,
  logEntries: cdp.events.filter((e) => e.method === "Log.entryAdded").length,
};
await cdp.send("Log.enable", {}, session2);
await cdp.send("Network.enable", {}, session2);
cdp.events.length = 0;
await sleep(100);
await cdp.send("Page.navigate", { url: "http://127.0.0.1:8766/?second" }, session2);
await sleep(2500);
results.enableAfterFirstNavigate = {
  consoleEntries: cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled").map((e) => e.params.type),
  logEntries: cdp.events.filter((e) => e.method === "Log.entryAdded").map((e) => ({ text: e.params.entry.text, level: e.params.entry.level })),
  networkFailed: cdp.events.filter((e) => e.method === "Network.loadingFailed").map((e) => e.params.errorText),
  network4xx: cdp.events.filter((e) => e.method === "Network.responseReceived" && e.params.response.status >= 400).map((e) => e.params.response.status),
};

// Case C: response bodies / buffer of Log events before enable
results.bufferedLogAfterEnable = cdp.events.filter((e) => e.method === "Log.entryAdded").length;

console.log(JSON.stringify(results, null, 2));
for (const target of [created.targetId, created2.targetId]) await cdp.send("Target.closeTarget", { targetId: target }).catch(() => {});
process.exit(0);
