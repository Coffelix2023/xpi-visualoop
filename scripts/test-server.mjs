#!/usr/bin/env node
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Test Page</title>
</head>
<body>
  <h1>Settings Panel</h1>
  <p>Path: ${req.url}</p>
  <p>This is a test fixture for xpi-visualoop trigger evaluation.</p>
</body>
</html>`);
});

server.listen(3000, "0.0.0.0", () => {
  console.log("Test server listening on http://0.0.0.0:3000");
});
