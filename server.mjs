import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};
http
  .createServer(async (req, res) => {
    try {
      const route = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      const relative = route === "/" ? "index.html" : route.slice(1);
      const file = path.resolve(root, relative);
      if (
        !file.startsWith(root + path.sep) ||
        relative.split(/[\\/]/).some((p) => p.startsWith(".")) ||
        /(?:^|[\\/])(?:node_modules|tests)(?:[\\/]|$)/.test(relative)
      ) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(file);
      res
        .writeHead(200, {
          "Content-Type":
            types[path.extname(file)] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        })
        .end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`Autostereogram studio: http://127.0.0.1:${port}`),
  );
