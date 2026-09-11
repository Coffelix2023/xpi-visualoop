import { createServer } from "node:http";
// One tall column: a document 3000 CSS px tall so an element (the body child)
// can exceed the 1000px viewport at DPR 2 and exercise the clamp-scale path.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>tall</title>
<style>html,body{margin:0;padding:0}</style></head><body>
<div id="column" style="position:absolute;left:0;top:0;width:800px;height:3000px;
background:linear-gradient(rgb(0,0,0), rgb(90,90,90))"></div>
<div id="bottom" style="position:absolute;left:0;top:2950px;width:800px;height:50px;background:rgb(200,40,60)"></div>
</body></html>`;
const server = createServer((request, response) => {
  if (request.url === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return; }
  response.statusCode = 404; response.end();
});
server.listen(8768, "127.0.0.1", () => console.log("tall page on 8768"));
