import { createServer } from "node:http";
const html = `<!doctype html><html><head><meta charset="utf-8"><title>diag</title></head><body>
<h1>diag</h1>
<div style="width:200px;height:100px;background:rgb(10,20,30)"></div>
<script>
  setTimeout(() => { console.error("boom", {a:1,b:[2,3]}); }, 300);
  setTimeout(() => { throw new Error("uncaught tok=supersecretvalue"); }, 600);
  setTimeout(() => { fetch("/missing.json").catch(() => {}); }, 900);
  setTimeout(() => { fetch("http://127.0.0.1:9/dead").catch(() => {}); }, 1200);
  setTimeout(() => { console.log("just a log"); }, 1400);
</script>
</body></html>`;
const server = createServer((request, response) => {
  if (request.url === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return; }
  response.statusCode = 404; response.end("nope");
});
server.listen(8766, "127.0.0.1", () => console.log("diag page on 8766"));
