import { createServer } from "node:http";

// Solid document-coordinate bands so a decoded pixel identifies a page coordinate.
const COLORS = [
  [0, 0, 0],        // y 0..100
  [255, 0, 0],      // y 100..200
  [0, 255, 0],      // y 200..300
  [0, 0, 255],      // y 300..400
  [255, 255, 255],  // y 400..500
];
const bands = COLORS.map(
  ([r, g, b], index) =>
    `<div style="position:absolute;left:0;top:${index * 100}px;width:100%;height:100px;background:rgb(${r},${g},${b})"></div>`,
).join("");
const columns = [200, 300, 400]
  .map(
    (x, index) =>
      `<div style="position:absolute;left:${x}px;top:600px;width:100px;height:100px;background:rgb(${(index + 1) * 60},${(index + 1) * 60},${(index + 1) * 60})"></div>`,
  )
  .join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>probe25</title>
<style>html,body{margin:0;padding:0}body{height:4000px;background:rgb(128,128,128)}</style>
</head><body>${bands}${columns}</body></html>`;

const server = createServer((request, response) => {
  if (request.url === "/") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
    return;
  }
  response.statusCode = 404;
  response.end("nope");
});

server.listen(8765, "127.0.0.1", () => console.log("page server on 8765"));
