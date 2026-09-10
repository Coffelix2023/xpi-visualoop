import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VisualLoopConfig } from "./config.ts";

export interface HarnessRequest {
  action: "capture" | "close" | "crop" | "prepare";
  allowTargetFailure?: boolean;
  cropRegion?: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  dpr?: number;
  expectedUrl?: string;
  imagePath?: string;
  outputPath?: string;
  selector?: string;
  sourcePath?: string;
  targetId?: string;
  targetImagePath?: string;
  url?: string;
  viewport?: {
    height: number;
    width: number;
  };
}

export interface HarnessPageInfo {
  h?: number;
  ph?: number;
  pw?: number;
  sx?: number;
  sy?: number;
  title?: string;
  url: string;
  w?: number;
}

export interface HarnessDiagnosticEntry {
  kind: "console" | "network";
  message: string;
  status?: number;
  url?: string;
}

export interface HarnessDiagnosticSummary {
  entries: HarnessDiagnosticEntry[];
  observedFrom?: string;
  observedTo?: string;
  status: "observed" | "unknown";
  truncated: boolean;
}

export interface HarnessPrepareResult {
  dpr: number;
  ok: true;
  page: HarnessPageInfo;
  protocolVersion: 1;
  targetId: string;
}

export interface HarnessCaptureResult {
  diagnostics: {
    console: HarnessDiagnosticSummary;
    network: HarnessDiagnosticSummary;
  };
  dpr: number;
  endedAt: string;
  image: {
    crop?: {
      height: number;
      path: string;
      sourceRegion: {
        height: number;
        width: number;
        x: number;
        y: number;
      };
      parentOffset: {
        x: number;
        y: number;
      };
      width: number;
    };
    height: number;
    path: string;
    rawHeight: number;
    temporaryByteLength: number;
    rawWidth: number;
    width: number;
  };
  ok: true;
  pageAfter: HarnessPageInfo;
  pageBefore: HarnessPageInfo;
  protocolVersion: 1;
  readiness: {
    reasons: string[];
    status: "degraded" | "ready";
  };
  startedAt: string;
  target?: {
    accessibility: Record<string, string>;
    bounds: {
      height: number;
      width: number;
      x: number;
      y: number;
    };
    selector: string;
    styles: Record<string, string>;
    text?: string;
    visibleBounds: {
      height: number;
      width: number;
      x: number;
      y: number;
    };
  };
  targetId: string;
}

export interface HarnessCropResult {
  height: number;
  ok: true;
  path: string;
  protocolVersion: 1;
  width: number;
}

export interface PrivateHarnessDirs {
  configDir: string;
  root: string;
  runtimeDir: string;
  tmpDir: string;
  workspaceDir: string;
}

const MAX_STDERR_BYTES = 16 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const OPERATION_TIMEOUT_MS = 30_000;

function prepareScript(request: HarnessRequest): string {
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return `
import base64, json, math, os, re
from browser_harness.helpers import _send
from PIL import Image
from urllib.parse import urlsplit
from datetime import datetime, timezone

MAX_EXPORT_EDGE = 2000
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_DIAGNOSTICS = 20

def safe_url(value):
    try:
        parsed = urlsplit(str(value))
        return f'{parsed.scheme}://{parsed.hostname or ""}'
    except Exception:
        return "unknown"

def safe_message(value):
    text = str(value or "")
    text = re.sub(r'(?i)\\bBearer\\s+\\S+', 'Bearer [redacted]', text)
    text = re.sub(r'(?i)(authorization|cookie|token|password|secret|api[-_]?key)\\s*[:=]\\s*\\S+', r'\\1=[redacted]', text)
    return text[:500]

def console_message(params):
    parts = []
    for argument in params.get("args") or []:
        if not isinstance(argument, dict):
            continue
        if "value" in argument:
            value = argument["value"]
        else:
            value = argument.get("description") or argument.get("unserializableValue")
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
        if value is not None:
            parts.append(str(value)[:500])
    details = params.get("exceptionDetails") or {}
    exception = details.get("exception") or {}
    for value in (details.get("text"), exception.get("description"), exception.get("value")):
        if value is not None:
            parts.append(str(value)[:500])
    return safe_message(" ".join(parts) or "console error")

def diagnostics(events, started_at, ended_at, active_session):
    console, network = [], []
    for event in events:
        if event.get("session_id") != active_session:
            continue
        method, params = event.get("method", ""), event.get("params") or {}
        if method == "Runtime.consoleAPICalled" and params.get("type") in ("error", "assert"):
            console.append({"kind": "console", "message": console_message(params)})
        elif method == "Network.responseReceived":
            response = params.get("response") or {}
            status = response.get("status")
            if isinstance(status, (int, float)) and status >= 400:
                network.append({"kind": "network", "message": f"HTTP {int(status)}", "status": status, "url": safe_url(response.get("url"))})
        elif method == "Network.loadingFailed":
            network.append({"kind": "network", "message": safe_message(params.get("errorText") or "loading failed")})
    return {
        "console": {"entries": console[:MAX_DIAGNOSTICS], "observedFrom": started_at, "observedTo": ended_at, "status": "observed", "truncated": len(console) > MAX_DIAGNOSTICS},
        "network": {"entries": network[:MAX_DIAGNOSTICS], "observedFrom": started_at, "observedTo": ended_at, "status": "observed", "truncated": len(network) > MAX_DIAGNOSTICS},
    }

def save_bounded(image, path):
    image.thumbnail((MAX_EXPORT_EDGE, MAX_EXPORT_EDGE), Image.Resampling.LANCZOS)
    export_path = path + ".export"
    try:
        while True:
            image.save(export_path, format="PNG", optimize=True)
            size = os.path.getsize(export_path)
            if size <= MAX_IMAGE_BYTES or min(image.size) <= 1:
                os.replace(export_path, path)
                return image.size, size
            factor = math.sqrt(MAX_IMAGE_BYTES / size) * 0.95
            image = image.resize((max(1, int(image.width * factor)), max(1, int(image.height * factor))), Image.Resampling.LANCZOS)
    finally:
        if os.path.exists(export_path):
            os.remove(export_path)
request = json.loads(base64.b64decode(${JSON.stringify(payload)}))
action = request.get("action")
if action == "close":
    target_id = request.get("targetId")
    if not target_id:
        raise RuntimeError("close requires an owned target")
    switch_tab(target_id)
    if current_tab().get("url") != request.get("expectedUrl"):
        raise RuntimeError("owned target URL changed; refusing to close")
    close_tab(target_id)
    result = {
        "dpr": 1,
        "ok": True,
        "page": {"url": request["expectedUrl"]},
        "protocolVersion": 1,
        "targetId": target_id,
    }
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    raise SystemExit(0)
if action == "crop":
    source_path = request.get("sourcePath")
    output_path = request.get("outputPath")
    region = request.get("cropRegion") or {}
    if not source_path or not output_path:
        raise RuntimeError("crop requires source and output paths")
    if not all(isinstance(region.get(key), (int, float)) and math.isfinite(region[key]) for key in ("x", "y", "width", "height")):
        raise RuntimeError("crop region must be finite")
    if region["width"] <= 0 or region["height"] <= 0:
        raise RuntimeError("crop region must have positive area")
    with Image.open(source_path) as source:
        left = int(region["x"])
        top = int(region["y"])
        right = int(region["x"] + region["width"])
        bottom = int(region["y"] + region["height"])
        if left < 0 or top < 0 or right > source.width or bottom > source.height or right <= left or bottom <= top:
            raise RuntimeError("crop region is outside source image")
        size, _ = save_bounded(source.crop((left, top, right, bottom)), output_path)
    print(json.dumps({"height": size[1], "ok": True, "path": output_path, "protocolVersion": 1, "width": size[0]}, ensure_ascii=True, separators=(",", ":")))
    raise SystemExit(0)
if action == "capture":
    target_id = request.get("targetId")
    image_path = request.get("imagePath")
    if not target_id or not image_path:
        raise RuntimeError("capture requires an owned target and image path")
    switch_tab(target_id)
    started_at = datetime.now(timezone.utc).isoformat()
    page_before = page_info()
    try:
        drain_events()
        active_session = _send({"meta": "session"}).get("session_id")
        diagnostics_available = active_session is not None
    except Exception:
        diagnostics_available = False
    reasons = []
    time = __import__("time")
    readiness_deadline = time.monotonic() + 5.0
    while True:
        ready_state = js("document.readyState")
        fonts_ready = js("document.fonts ? document.fonts.status === 'loaded' : true")
        images_ready = js("Array.from(document.images).filter(i => { const r=i.getBoundingClientRect(); return r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth; }).every(i => i.complete && i.naturalWidth > 0)")
        if ready_state == "complete" and fonts_ready and images_ready:
            break
        if time.monotonic() >= readiness_deadline:
            if ready_state != "complete":
                reasons.append("document not complete")
            if not fonts_ready:
                reasons.append("fonts not ready")
            if not images_ready:
                reasons.append("visible images not ready")
            break
        time.sleep(0.1)
    target = None
    selector = request.get("selector")
    if selector is not None:
        target_result = js("""const selector = %s; const nodes = Array.from(document.querySelectorAll(selector)); if (nodes.length !== 1) return {error: nodes.length === 0 ? 'no-match' : 'multiple-matches'}; const e=nodes[0], r=e.getBoundingClientRect(), x=Math.max(0,r.left), y=Math.max(0,r.top), right=Math.min(innerWidth,r.right), bottom=Math.min(innerHeight,r.bottom); if (right <= x || bottom <= y) return {error:'outside-viewport'}; const s=getComputedStyle(e), pick={}; for (const k of ['display','position','width','height','margin','padding','gap','fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','border','borderRadius','overflow']) pick[k]=s[k]; return {accessibility:{role:e.getAttribute('role')||'',label:e.getAttribute('aria-label')||'',description:e.getAttribute('aria-description')||''},bounds:{x:r.left,y:r.top,width:r.width,height:r.height},selector,text:(e.innerText||e.textContent||'').slice(0,2000),styles:pick,visibleBounds:{x,y,width:right-x,height:bottom-y}};""" % json.dumps(selector))
        if target_result.get("error"):
            if not request.get("allowTargetFailure"):
                print(json.dumps({"ok": True, "protocolVersion": 1, "target": target_result, "targetId": target_id}, ensure_ascii=True, separators=(",", ":")))
                raise SystemExit(0)
            reasons.append(f'target resolution failed: {target_result.get("error")}')
        else:
            target = target_result
    target_before = None if target is None else target["bounds"]
    from PIL import Image
    parent_path = image_path + ".parent.png"
    completed = False
    try:
        capture_screenshot(path=parent_path, full=False)
        with Image.open(parent_path) as parent:
            raw_width, raw_height = parent.size
            scale_x = raw_width / page_before["w"]
            scale_y = raw_height / page_before["h"]
            crop = None
            if target is not None and request.get("targetImagePath"):
                visible = target["visibleBounds"]
                left = max(0, min(raw_width - 1, int(visible["x"] * scale_x)))
                top = max(0, min(raw_height - 1, int(visible["y"] * scale_y)))
                right = max(left + 1, min(raw_width, int((visible["x"] + visible["width"]) * scale_x + 0.999)))
                bottom = max(top + 1, min(raw_height, int((visible["y"] + visible["height"]) * scale_y + 0.999)))
                crop_image = parent.crop((left, top, right, bottom))
                crop_size, _ = save_bounded(crop_image, request["targetImagePath"])
                crop = {"height": crop_size[1], "path": request["targetImagePath"], "sourceRegion": {"height": visible["height"], "width": visible["width"], "x": page_before["sx"] + visible["x"], "y": page_before["sy"] + visible["y"]}, "width": crop_size[0], "x": left, "y": top}
            export_size, _ = save_bounded(parent.copy(), image_path)
        parent_bytes = os.path.getsize(parent_path)
        completed = True
    finally:
        cleanup_paths = [parent_path, image_path + ".export"]
        target_image_path = request.get("targetImagePath")
        if target_image_path:
            cleanup_paths.append(target_image_path + ".export")
        if not completed:
            cleanup_paths.append(image_path)
            if target_image_path:
                cleanup_paths.append(target_image_path)
        for cleanup_path in cleanup_paths:
            if os.path.exists(cleanup_path):
                os.remove(cleanup_path)
    page_after = page_info()
    if page_before.get("url") != page_after.get("url"):
        reasons.append("page URL changed during capture")
    if page_before.get("sx") != page_after.get("sx") or page_before.get("sy") != page_after.get("sy"):
        reasons.append("scroll changed during capture")
    if selector is not None:
        target_after = js("""const selector = %s; const nodes = Array.from(document.querySelectorAll(selector)); if (nodes.length !== 1) return null; const r=nodes[0].getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width,height:r.height};""" % json.dumps(selector))
        if target_after != target_before:
            reasons.append("target bounds changed during capture")
    ended_at = datetime.now(timezone.utc).isoformat()
    try:
        events = drain_events()
    except Exception:
        events = []
        diagnostics_available = False
    observed_diagnostics = diagnostics(events, started_at, ended_at, active_session)
    if not diagnostics_available:
        for item in observed_diagnostics.values():
            item["entries"] = []
            item["status"] = "unknown"
            item["truncated"] = False
            item.pop("observedFrom", None)
            item.pop("observedTo", None)
    result = {
        "dpr": js("window.devicePixelRatio"),
        "endedAt": ended_at,
        "diagnostics": observed_diagnostics,
        "image": {"crop": crop, "height": export_size[1], "path": image_path, "rawHeight": raw_height, "rawWidth": raw_width, "temporaryByteLength": parent_bytes, "width": export_size[0]},
        "ok": True,
        "pageAfter": page_after,
        "pageBefore": page_before,
        "protocolVersion": 1,
        "readiness": {"reasons": reasons, "status": "degraded" if reasons else "ready"},
        "startedAt": started_at,
        "target": target,
        "targetId": current_tab()["targetId"],
    }
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    raise SystemExit(0)

if action != "prepare":
    raise RuntimeError("unsupported fixed harness action")

if request.get("targetId"):
    switch_tab(request["targetId"])
else:
    new_tab("about:blank")
cdp("Emulation.setDeviceMetricsOverride", width=request["viewport"]["width"], height=request["viewport"]["height"], deviceScaleFactor=request["dpr"], mobile=False)
goto_url(request["url"])
wait_for_load(timeout=5.0)
page = page_info()
result = {
    "dpr": js("window.devicePixelRatio"),
    "ok": True,
    "page": page,
    "protocolVersion": 1,
    "targetId": current_tab()["targetId"],
}
print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
`;
}

function appendBounded(current: string, chunk: Buffer, limit: number): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") > limit)
    throw new Error("harness output exceeded the configured budget");
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResult(stdout: string): HarnessPrepareResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("harness returned invalid JSON or extra output");
  }
  if (!isRecord(value) || value.ok !== true || value.protocolVersion !== 1) {
    throw new Error("harness returned an unsupported result envelope");
  }
  if (
    typeof value.targetId !== "string" ||
    !isRecord(value.page) ||
    typeof value.page.url !== "string"
  ) {
    throw new Error("harness returned an incomplete prepare result");
  }
  if (typeof value.dpr !== "number" || !Number.isFinite(value.dpr)) {
    throw new Error("harness returned an invalid device pixel ratio");
  }
  return {
    dpr: value.dpr,
    ok: true,
    // SAFETY: the fixed protocol check above validates page is an object with a string url.
    page: value.page as unknown as HarnessPageInfo,
    protocolVersion: 1,
    targetId: value.targetId,
  };
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`harness capture ${name} is invalid`);
  return value;
}

function pageInfo(value: unknown, name: string): HarnessPageInfo {
  if (!isRecord(value) || typeof value.url !== "string")
    throw new Error(`harness capture ${name} is invalid`);
  return {
    h: finite(value.h, `${name}.h`),
    ph: finite(value.ph, `${name}.ph`),
    pw: finite(value.pw, `${name}.pw`),
    sx: finite(value.sx, `${name}.sx`),
    sy: finite(value.sy, `${name}.sy`),
    title: typeof value.title === "string" ? value.title : "",
    url: value.url,
    w: finite(value.w, `${name}.w`),
  };
}

function captureRegion(value: unknown, name: string) {
  if (!isRecord(value)) throw new Error(`harness capture ${name} is invalid`);
  return {
    height: finite(value.height, `${name}.height`),
    width: finite(value.width, `${name}.width`),
    x: finite(value.x, `${name}.x`),
    y: finite(value.y, `${name}.y`),
  };
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string"))
    throw new Error(`harness capture ${name} is invalid`);
  // SAFETY: every value was checked as a string above.
  return value as Record<string, string>;
}

function sanitizeDiagnosticMessage(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|cookie|token|password|secret|api[-_]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[redacted]",
    )
    .slice(0, 500);
}

function safeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return "unknown";
  }
}

function diagnosticSummary(value: unknown, name: string): HarnessDiagnosticSummary {
  if (!isRecord(value)) throw new Error(`harness capture ${name} is invalid`);
  if (value.status !== "observed" && value.status !== "unknown")
    throw new Error(`harness capture ${name}.status is invalid`);
  if (!Array.isArray(value.entries) || value.entries.length > 20)
    throw new Error(`harness capture ${name}.entries is invalid`);
  const entries = value.entries.map((entry, index) => {
    if (
      !isRecord(entry) ||
      (entry.kind !== "console" && entry.kind !== "network") ||
      typeof entry.message !== "string"
    )
      throw new Error(`harness capture ${name}.entries[${index}] is invalid`);
    return {
      kind: entry.kind as "console" | "network",
      message: sanitizeDiagnosticMessage(entry.message),
      ...(typeof entry.status === "number"
        ? {
            status: entry.status,
          }
        : {}),
      ...(typeof entry.url === "string"
        ? {
            url: safeDiagnosticUrl(entry.url),
          }
        : {}),
    };
  });
  return {
    entries,
    ...(typeof value.observedFrom === "string"
      ? {
          observedFrom: value.observedFrom,
        }
      : {}),
    ...(typeof value.observedTo === "string"
      ? {
          observedTo: value.observedTo,
        }
      : {}),
    status: value.status,
    truncated: value.truncated === true,
  };
}

function parseCaptureResult(
  stdout: string,
  allowTargetFailure = false,
): HarnessCaptureResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("harness returned invalid JSON or extra output");
  }
  if (!isRecord(value) || value.ok !== true || value.protocolVersion !== 1)
    throw new Error("harness returned an unsupported capture envelope");
  if (
    !allowTargetFailure &&
    isRecord(value.target) &&
    typeof value.target.error === "string"
  )
    throw new Error(`target resolution failed: ${value.target.error}`);
  if (!isRecord(value.image) || typeof value.image.path !== "string")
    throw new Error("harness capture image is invalid");
  if (
    !isRecord(value.readiness) ||
    (value.readiness.status !== "ready" && value.readiness.status !== "degraded") ||
    !Array.isArray(value.readiness.reasons) ||
    value.readiness.reasons.some((reason) => typeof reason !== "string")
  ) {
    throw new Error("harness capture readiness is invalid");
  }
  const unknownDiagnostics: HarnessDiagnosticSummary = {
    entries: [],
    status: "unknown",
    truncated: false,
  };
  let captureDiagnostics = {
    console: unknownDiagnostics,
    network: unknownDiagnostics,
  };
  if (value.diagnostics !== undefined) {
    if (!isRecord(value.diagnostics))
      throw new Error("harness capture diagnostics is invalid");
    captureDiagnostics = {
      console: diagnosticSummary(value.diagnostics.console, "diagnostics.console"),
      network: diagnosticSummary(value.diagnostics.network, "diagnostics.network"),
    };
  }
  let target: HarnessCaptureResult["target"];
  if (value.target !== undefined && value.target !== null) {
    if (!isRecord(value.target)) throw new Error("harness capture target is invalid");
    if (!allowTargetFailure && typeof value.target.error === "string")
      throw new Error(`target resolution failed: ${value.target.error}`);
    if (typeof value.target.error === "string") {
      target = undefined;
    } else if (typeof value.target.selector !== "string") {
      throw new Error("harness capture target selector is invalid");
    } else {
      target = {
        accessibility: stringRecord(value.target.accessibility, "target.accessibility"),
        bounds: captureRegion(value.target.bounds, "target.bounds"),
        selector: value.target.selector,
        styles: stringRecord(value.target.styles, "target.styles"),
        ...(typeof value.target.text === "string"
          ? {
              text: value.target.text,
            }
          : {}),
        visibleBounds: captureRegion(
          value.target.visibleBounds,
          "target.visibleBounds",
        ),
      };
    }
  }
  if (typeof value.targetId !== "string")
    throw new Error("harness capture targetId is invalid");
  return {
    diagnostics: captureDiagnostics,
    dpr: finite(value.dpr, "dpr"),
    endedAt: typeof value.endedAt === "string" ? value.endedAt : "",
    ok: true,
    pageAfter: pageInfo(value.pageAfter, "pageAfter"),
    pageBefore: pageInfo(value.pageBefore, "pageBefore"),
    protocolVersion: 1,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    image: {
      ...(isRecord(value.image.crop)
        ? {
            crop: {
              height: finite(value.image.crop.height, "image.crop.height"),
              path:
                typeof value.image.crop.path === "string" ? value.image.crop.path : "",
              sourceRegion: captureRegion(
                value.image.crop.sourceRegion,
                "image.crop.sourceRegion",
              ),
              width: finite(value.image.crop.width, "image.crop.width"),
              parentOffset: {
                x: finite(value.image.crop.x, "image.crop.x"),
                y: finite(value.image.crop.y, "image.crop.y"),
              },
            },
          }
        : {}),
      height: finite(value.image.height, "image.height"),
      path: value.image.path,
      rawHeight: finite(value.image.rawHeight ?? value.image.height, "image.rawHeight"),
      rawWidth: finite(value.image.rawWidth ?? value.image.width, "image.rawWidth"),
      temporaryByteLength: finite(
        value.image.temporaryByteLength ?? 0,
        "image.temporaryByteLength",
      ),
      width: finite(value.image.width, "image.width"),
    },
    readiness: {
      reasons: [
        ...value.readiness.reasons,
      ] as string[],
      status: value.readiness.status,
    },
    ...(target
      ? {
          target,
        }
      : {}),
    targetId: value.targetId,
  };
}

function parseCropResult(stdout: string): HarnessCropResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("harness returned invalid crop JSON or extra output");
  }
  if (!isRecord(value) || value.ok !== true || value.protocolVersion !== 1)
    throw new Error("harness returned an unsupported crop result envelope");
  if (typeof value.path !== "string") throw new Error("harness crop path is invalid");
  return {
    height: finite(value.height, "crop.height"),
    ok: true,
    path: value.path,
    protocolVersion: 1,
    width: finite(value.width, "crop.width"),
  };
}
export async function createPrivateHarnessDirs(): Promise<PrivateHarnessDirs> {
  const root = await mkdtemp(join(tmpdir(), "xpv-"));
  const dirs = {
    configDir: join(root, "c"),
    root,
    runtimeDir: join(root, "r"),
    tmpDir: join(root, "t"),
    workspaceDir: join(root, "w"),
  };
  await Promise.all(
    Object.values(dirs)
      .filter((path) => path !== root)
      .map((path) =>
        mkdir(path, {
          mode: 0o700,
        }),
      ),
  );
  await chmod(root, 0o700);
  return dirs;
}

export async function removePrivateHarnessDirs(
  dirs: PrivateHarnessDirs,
): Promise<void> {
  await rm(dirs.root, {
    force: true,
    recursive: true,
  });
}

function environment(
  config: VisualLoopConfig,
  dirs: PrivateHarnessDirs,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    BH_AGENT_WORKSPACE: dirs.workspaceDir,
    BH_CONFIG_DIR: dirs.configDir,
    BH_HOME: dirs.root,
    BH_RECORD: "0",
    BH_RUNTIME_DIR: dirs.runtimeDir,
    BH_TAB_MARKER: "0",
    BH_TELEMETRY: "0",
    BH_TMP_DIR: dirs.tmpDir,
    BU_AUTOSPAWN: "0",
    BU_CDP_URL: config.cdpUrl,
    BU_NAME: `xpi-${process.pid}`,
    HOME: undefined,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  return env;
}

function stopProcess(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 500);
  forceKill.unref();
}

async function runHarness<T>(
  config: VisualLoopConfig,
  dirs: PrivateHarnessDirs,
  request: HarnessRequest,
  signal: AbortSignal | undefined,
  parse: (stdout: string) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(config.harnessPath, [], {
        cwd: dirs.root,
        env: environment(config, dirs),
        shell: false,
        stdio: [
          "pipe",
          "pipe",
          "pipe",
        ],
      });
    } catch (error) {
      reject(
        new Error(
          `failed to start browser-harness: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      stopProcess(child);
      finish(new Error("browser-harness operation timed out"));
    }, OPERATION_TIMEOUT_MS);
    const onAbort = () => {
      stopProcess(child);
      finish(new Error("browser-harness operation cancelled"));
    };
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result as T);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, {
      once: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        stdout = appendBounded(stdout, chunk, MAX_STDOUT_BYTES);
      } catch (error) {
        stopProcess(child);
        finish(error as Error);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      try {
        stderr = appendBounded(stderr, chunk, MAX_STDERR_BYTES);
      } catch (error) {
        stopProcess(child);
        finish(error as Error);
      }
    });
    child.once("error", (error) =>
      finish(new Error(`browser-harness failed: ${error.message}`)),
    );
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().replace(/[\r\n]+/g, " ");
        finish(
          new Error(
            `browser-harness exited with ${exitSignal ?? `code ${code}`}${detail ? `: ${sanitizeDiagnosticMessage(detail)}` : ""}`,
          ),
        );
        return;
      }
      try {
        finish(undefined, parse(stdout.trim()));
      } catch (error) {
        finish(error as Error);
      }
    });

    child.stdin?.end(prepareScript(request));
  });
}

export function runPrepare(
  config: VisualLoopConfig,
  dirs: PrivateHarnessDirs,
  request: HarnessRequest,
  signal?: AbortSignal,
): Promise<HarnessPrepareResult> {
  return runHarness(config, dirs, request, signal, parseResult);
}
export async function runCapture(
  config: VisualLoopConfig,
  dirs: PrivateHarnessDirs,
  request: HarnessRequest & {
    action: "capture";
  },
  signal?: AbortSignal,
): Promise<HarnessCaptureResult> {
  const result = await runHarness(config, dirs, request, signal, (stdout) =>
    parseCaptureResult(stdout, request.allowTargetFailure),
  );
  if (result.image.path !== request.imagePath)
    throw new Error("harness capture image path does not match the requested path");
  if (
    request.selector &&
    request.targetImagePath &&
    result.image.crop?.path !== request.targetImagePath
  )
    throw new Error("harness capture crop path does not match the requested path");
  return result;
}

export async function runCrop(
  config: VisualLoopConfig,
  dirs: PrivateHarnessDirs,
  request: HarnessRequest & {
    action: "crop";
    cropRegion: {
      height: number;
      width: number;
      x: number;
      y: number;
    };
    outputPath: string;
    sourcePath: string;
  },
  signal?: AbortSignal,
): Promise<HarnessCropResult> {
  const result = await runHarness(config, dirs, request, signal, parseCropResult);
  if (result.path !== request.outputPath)
    throw new Error("harness crop path does not match the requested path");
  return result;
}

export async function reloadHarness(
  config: VisualLoopConfig,
  dirs: PrivateHarnessDirs,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      config.harnessPath,
      [
        "--reload",
      ],
      {
        cwd: dirs.root,
        env: environment(config, dirs),
        shell: false,
        stdio: [
          "ignore",
          "ignore",
          "pipe",
        ],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_STDERR_BYTES)
        stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `failed to reload browser-harness: ${sanitizeDiagnosticMessage(stderr.trim())}`,
          ),
        );
    });
  });
}
