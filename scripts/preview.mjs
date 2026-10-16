import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../out/', import.meta.url));
const port = Number(process.env.PREVIEW_PORT || 3059);
const host = process.env.PREVIEW_HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PREVIEW_PORT: ${String(process.env.PREVIEW_PORT)}`);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.wasm':'application/wasm', '.gz':'application/gzip', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };
createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root+sep)) { res.writeHead(403); res.end(); return; }
    const candidates = pathname === '/' || extname(path) ? [path] : [path, `${path}.html`, resolve(path, 'index.html')];
    let file;
    let servedPath;
    for (const candidate of candidates) {
      try { file = await readFile(candidate); servedPath = candidate; break; } catch { /* Try the next static-export form. */ }
    }
    if (!file || !servedPath) throw new Error('Static file not found');
    res.writeHead(200, { 'Content-Type':types[extname(servedPath)] || 'application/octet-stream', 'Cache-Control':pathname === '/sw.js' ? 'no-cache' : 'no-store', 'X-Content-Type-Options':'nosniff' }); res.end(file);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port,host,() => console.log(`Production preview listening on http://${host}:${port}`));
