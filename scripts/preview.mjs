import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../out/', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.wasm':'application/wasm', '.gz':'application/gzip', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };
createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root+sep)) { res.writeHead(403); res.end(); return; }
    const file = await readFile(path);
    res.writeHead(200, { 'Content-Type':types[extname(path)] || 'application/octet-stream', 'Cache-Control':pathname === '/sw.js' ? 'no-cache' : 'no-store', 'X-Content-Type-Options':'nosniff' }); res.end(file);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(3059,'0.0.0.0',() => console.log('SPOTLOG production preview: http://localhost:3059'));
