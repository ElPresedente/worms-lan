import http from 'node:http';
import path from 'node:path';
import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { build, projectRoot } from './build.mjs';

const args = process.argv.slice(2);
const preview = args.includes('--preview');
const portIndex = args.indexOf('--port');
const port = portIndex < 0 ? 4173 : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use --port <1..65535>');
const root = path.resolve(projectRoot, 'packages/client/dist');
if (!preview) build();
const clients = new Set();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!preview && url.pathname === '/__dev/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0')) { res.writeHead(400); res.end(); return; }
    let target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    const info = await stat(target);
    if (!info.isFile()) { res.writeHead(404); res.end(); return; }
    let data = await readFile(target);
    if (!preview && path.extname(target) === '.html') {
      const liveReload = '<script>const reload = new EventSource("/__dev/events");reload.onmessage=e=>{if(e.data==="reload")location.reload();};</script>';
      data = Buffer.from(data.toString('utf8').replace('</body>', liveReload + '</body>'));
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    res.writeHead(missing ? 404 : 400); res.end(missing ? 'Not found' : 'Bad request');
  }
});
const watchers = [];
let debounce;
function rebuild() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    try {
      build();
      for (const client of clients) client.write('data: reload\n\n');
    } catch (error) { console.error(String(error)); }
  }, 150);
}
if (!preview) {
  for (const source of ['packages/game-core/src', 'packages/protocol/src', 'packages/client/src', 'packages/client/public']) {
    watchers.push(watch(path.join(projectRoot, source), { recursive: true }, rebuild));
  }
  // Keep idle SSE streams alive.
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': ping\n\n'); }, 15000);
  heartbeat.unref();
}
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port ' + port + ' is busy. Use npm run dev -- --port 4174' : error);
  process.exitCode = 1;
  for (const watcher of watchers) watcher.close();
});
server.listen(port, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + port + (preview ? ' (preview)' : ' (watch + reload)')));
function close() {
  clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  for (const client of clients) client.end();
  server.close();
}
process.on('SIGINT', close); process.on('SIGTERM', close);
