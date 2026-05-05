#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const outDir = path.resolve(cwd, process.argv[2] || "generated-site");
const preferredPort = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  }).catch((error) => {
    if (error.code !== "EADDRINUSE") throw error;
    return listen(server, 0);
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const requestedPath = decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const resolved = path.resolve(outDir, `.${requestedPath}`);

    if (!resolved.startsWith(outDir + path.sep) && resolved !== outDir) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const fileStat = await stat(resolved).catch(() => null);
    if (!fileStat?.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(resolved).toLowerCase()] || "application/octet-stream"
    });
    createReadStream(resolved).pipe(response);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error?.stack || String(error));
  }
});

const port = await listen(server, preferredPort);
console.log(`Website: http://127.0.0.1:${port}/`);
console.log("Keep this process running while the website is open. Press Ctrl+C to stop.");
