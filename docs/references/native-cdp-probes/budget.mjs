// Task 2.9 probe: verify the tightened viewport caps keep exports within the
// 2000-device-pixel budget, and that an oversized element region gets clamped
// via clip.scale. Run with the grid page (8767) and tall page (8768) up.
import { readFile } from "node:fs/promises";
import { CdpClient } from "../../../src/visual-loop/cdp.ts";
import {
  captureOwnedPage,
  OwnedTargets,
  prepareOwnedPage,
} from "../../../src/visual-loop/cdp-actions.ts";
const MAX_EXPORT_EDGE = 2000; // keep in sync with src/visual-loop/context.ts

const { decodePng } = await import(
  ".//png.mjs"
);

const ENDPOINT = "http://127.0.0.1:9556/";
const OUT = "/tmp/xpi-visualoop-probe-25";

let failures = 0;

function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${label}  ${ok ? "OK" : "MISS"}  ${detail}`);
}

/** page3.mjs encodes each 100x100 tile's own page coordinates in its color. */
function pageColor(x, y) {
  const row = Math.floor(y / 100);
  const column = Math.floor(x / 100);
  return [row * 20, column * 30, (row + column) * 10];
}

async function run(label, fn) {
  const client = await CdpClient.connect(ENDPOINT);
  const owned = new OwnedTargets();
  try {
    await fn(client, owned);
  } finally {
    await client.close();
  }
}

// A: max viewport at DPR 1 -> 2000x2000 export.
await run("A", async (client, owned) => {
  const prepared = await prepareOwnedPage(client, owned, {
    dpr: 1,
    url: "http://127.0.0.1:8767/",
    viewport: { height: 2000, width: 2000 },
  });
  const result = await captureOwnedPage(client, owned, prepared.targetId, {
    imagePath: `${OUT}/cap-A.png`,
  });
  const png = decodePng(await readFile(result.image.path));
  check(
    "A dpr1 viewport 2000x2000",
    png.width === 2000 && png.height === 2000 && result.image.byteLength <= 4 * 1024 * 1024,
    `out=${png.width}x${png.height} bytes=${result.image.byteLength}`,
  );
});

// B2: DPR 2 accepts the 1000x1000 cap and exports 2000x2000.
await run("B2", async (client, owned) => {
  const prepared = await prepareOwnedPage(client, owned, {
    dpr: 2,
    url: "http://127.0.0.1:8767/",
    viewport: { height: 1000, width: 1000 },
  });
  const result = await captureOwnedPage(client, owned, prepared.targetId, {
    imagePath: `${OUT}/cap-B2.png`,
  });
  const png = decodePng(await readFile(result.image.path));
  check(
    "B2 dpr2 viewport 1000x1000",
    png.width === 2000 && png.height === 2000 && result.image.byteLength <= 4 * 1024 * 1024,
    `out=${png.width}x${png.height} bytes=${result.image.byteLength}`,
  );
});

// C: oversized element (800x3000 at dpr1) -> clamped scale, budget kept.
await run("C", async (client, owned) => {
  const prepared = await prepareOwnedPage(client, owned, {
    dpr: 1,
    url: "http://127.0.0.1:8768/",
    viewport: { height: 800, width: 1000 },
  });
  const result = await captureOwnedPage(client, owned, prepared.targetId, {
    imagePath: `${OUT}/cap-C.png`,
    selector: "#column",
    targetImagePath: `${OUT}/cap-C-target.png`,
  });
  const png = decodePng(await readFile(result.image.crop.path));
  // Gradient 0->90: any white (255) pixel would mean blank/lost content.
  let white = 0;
  for (let y = 0; y < png.height; y += 97)
    for (let x = 0; x < png.width; x += 31) {
      const p = png.pixel(x, y);
      if (p[0] === 255 && p[1] === 255 && p[2] === 255) white += 1;
    }
  check(
    "C dpr1 element 800x3000 clamped",
    Math.max(png.width, png.height) <= MAX_EXPORT_EDGE && white === 0,
    `out=${png.width}x${png.height} bytes=${result.image.crop.byteLength} whitePx=${white} sourceRegion=${JSON.stringify(result.image.crop.sourceRegion)}`,
  );
});

// D: oversized element at DPR 2 (1000x3000 CSS -> 6000 device edge) -> clamped.
await run("D", async (client, owned) => {
  const prepared = await prepareOwnedPage(client, owned, {
    dpr: 2,
    url: "http://127.0.0.1:8768/",
    viewport: { height: 800, width: 1000 },
  });
  const result = await captureOwnedPage(client, owned, prepared.targetId, {
    imagePath: `${OUT}/cap-D.png`,
    selector: "#column",
    targetImagePath: `${OUT}/cap-D-target.png`,
  });
  const png = decodePng(await readFile(result.image.crop.path));
  check(
    "D dpr2 element 1000x3000 clamped",
    Math.max(png.width, png.height) <= MAX_EXPORT_EDGE,
    `out=${png.width}x${png.height} bytes=${result.image.crop.byteLength}`,
  );
});

// D2: clamped shots still resolve the bottom of the tall element (content, not blank).
await run("D2", async (client, owned) => {
  const prepared = await prepareOwnedPage(client, owned, {
    dpr: 2,
    url: "http://127.0.0.1:8768/",
    viewport: { height: 800, width: 1000 },
  });
  // Scroll the marker into the viewport first: outside-viewport targets are
  // refused by design, and this also re-proves scroll-independence of clip.
  await client.send(
    "Runtime.evaluate",
    { expression: "scrollTo(0, document.documentElement.scrollHeight)" },
    owned.session(prepared.targetId),
  );
  const result = await captureOwnedPage(client, owned, prepared.targetId, {
    imagePath: `${OUT}/cap-D2.png`,
    selector: "#bottom",
    targetImagePath: `${OUT}/cap-D2-target.png`,
  });
  const png = decodePng(await readFile(result.image.crop.path));
  // #bottom is 800x50 CSS -> 1600x100 device at dpr2; well under budget, no scale.
  const sizeOk = png.width === 1600 && png.height === 100;
  const pixel = png.pixel(png.width - 1, 0);
  const colorOk = pixel[0] === 200 && pixel[1] === 40 && pixel[2] === 60;
  check(
    "D2 bottom marker readable",
    sizeOk && colorOk,
    `out=${png.width}x${png.height} lastPx=(${pixel.join(",")}) want=(200,40,60) bytes=${result.image.crop.byteLength}`,
  );
});

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
