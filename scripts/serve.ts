// Minimal static server for the exported site (e2e tests, screenshots). BASE mounts it under a path, as on GitHub Pages.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../apps/web/out/", import.meta.url).pathname, base = process.env.BASE ?? "", port = Number(process.env.PORT ?? 8449);
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm" };
createServer(async (req, res) => {
  let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (!p.startsWith(base)) { res.writeHead(404).end(); return; }
  p = normalize(p.slice(base.length) || "/");
  if (p.includes("..")) { res.writeHead(400).end(); return; }
  let f = join(root, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, "index.html"); } catch { /* falls through to 404 */ }
  let body: Buffer;
  try { body = await readFile(f); } catch { res.writeHead(404).end("not found"); return; }
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(body);
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} at http://127.0.0.1:${port}${base}/`));
