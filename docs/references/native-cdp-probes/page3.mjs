import { createServer } from "node:http";
// Distinct 100x100 grid colors in page coordinates so every sample identifies a position.
const colors = new Map();
const tiles = [];
for (let row = 0; row < 12; row += 1)
  for (let column = 0; column < 8; column += 1) {
    const value = `rgb(${row * 20},${column * 30},${(row + column) * 10})`;
    colors.set(`${row},${column}`, value);
    tiles.push(`<div style="position:absolute;left:${column * 100}px;top:${row * 100}px;width:100px;height:100px;background:${value}"></div>`);
  }
const html = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;padding:0}body{height:1200px}</style></head><body>${tiles.join("")}</body></html>`;
const server = createServer((request, response) => {
  if (request.url === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return; }
  response.statusCode = 404; response.end();
});
server.listen(8767, "127.0.0.1", () => console.log("grid page on 8767"));
