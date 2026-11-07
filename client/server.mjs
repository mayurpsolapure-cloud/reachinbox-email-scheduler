import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("./dist", import.meta.url)));
const port = Number(process.env.PORT) || 4173;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendFile(response, path, method) {
  const extension = extname(path);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (method === "HEAD") {
    response.end();
  } else {
    createReadStream(path).pipe(response);
  }
}

createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  if (pathname === "/health/live" || pathname === "/health/ready") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ready" }));
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const requested = resolve(root, `.${pathname}`);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
    response.writeHead(400);
    response.end();
    return;
  }

  let filePath = requested;
  try {
    if (statSync(filePath).isDirectory()) filePath = resolve(filePath, "index.html");
    if (statSync(filePath).isFile()) {
      if (request.method === "HEAD") {
        response.writeHead(200, {
          "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
        });
        response.end();
      } else {
        sendFile(response, filePath, request.method);
      }
      return;
    }
  } catch {
    if (extname(pathname)) {
      response.writeHead(404);
      response.end();
      return;
    }
  }

  sendFile(response, resolve(root, "index.html"), request.method);
}).listen(port, "0.0.0.0", () => {
  console.log(`Frontend listening on port ${port}`);
});
