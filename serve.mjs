#!/usr/bin/env node
// Local server for OSMViewer Web: static files + persistent download cache.
//
//   node serve.mjs [port] [--data <dir>] [--offline] [--max-age <days>] [--hgt-url <template>] [--vector-url <template>]
//
// Binds to localhost only. Routes:
//   /tiles/<source>/<z>/<x>/<y>       tile of a catalogue source via the disk cache (not an open proxy)
//   /vector/<z>/<x>/<y>               vector tile (OpenMapTiles schema) for the poster export, via the disk cache
//   /archive/<store>/<z>/<x>/<y>      tile from a local archive folder (disk only)
//   /api/elevation?latitude=..&longitude=..   elevations from local HGT cells (downloaded on demand)
//   /api/elevgrid?south&west&north&east&cols&rows   elevation grid for contour lines
//   /api/info                         capabilities, data folder, archive layers (fast)
//   /api/usage                        cache size per store (walks the disk, slow for big caches)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataStore, defaultDataDir } from './server/datastore.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.gpx': 'application/gpx+xml', '.kml': 'application/vnd.google-earth.kml+xml',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };

export function createApp({ root = fileURLToPath(new URL('.', import.meta.url)), store }) {
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const image = (res, tile) => {
    if (!tile) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': tile.type, 'Cache-Control': 'max-age=86400', 'X-Tile-From': tile.from });
    res.end(tile.data);
  };
  return createServer(async (req, res) => {
    try {
      // pages on other sites must not use the local server (the browser sends this header)
      if (req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end('Forbidden'); return; }
      const url = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      let m = /^\/tiles\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
      if (m) { image(res, await store.tile(m[1], +m[2], +m[3], +m[4])); return; }
      m = /^\/vector\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
      if (m) { image(res, await store.vectorTile(+m[1], +m[2], +m[3])); return; }
      m = /^\/archive\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
      if (m) { image(res, await store.archiveTile(m[1], +m[2], +m[3], +m[4])); return; }
      if (path === '/api/info') { json(res, 200, { app: 'osmviewer-web', cache: true, ...(await store.info()) }); return; }
      if (path === '/api/usage') { json(res, 200, await store.usage()); return; }
      if (path === '/api/elevation') {
        const nums = (k) => (url.searchParams.get(k) || '').split(',').filter(Boolean).map(Number);
        const lats = nums('latitude'), lons = nums('longitude');
        if (!lats.length || lats.length !== lons.length || lats.length > 1000) { json(res, 400, { error: true, reason: 'latitude/longitude ungültig' }); return; }
        json(res, 200, { elevation: await store.elevations(lats, lons), source: 'hgt-local' }); return;
      }
      if (path === '/api/elevgrid') {
        const q = (k) => Number(url.searchParams.get(k));
        const [s, w, n, e, cols, rows] = ['south', 'west', 'north', 'east', 'cols', 'rows'].map(q);
        const ok = [s, w, n, e].every(Number.isFinite) && n > s && e > w && s >= -89 && n <= 89 && w >= -180 && e <= 180
          && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 2 && cols * rows <= 250000;
        if (!ok) { json(res, 400, { error: true, reason: 'Parameter ungültig' }); return; }
        try { json(res, 200, await store.elevationGrid(s, w, n, e, cols, rows)); } catch (err) { json(res, 400, { error: true, reason: err.message }); }
        return;
      }
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end('Forbidden'); return; }
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const port = /^\d+$/.test(args[0] || '') ? Number(args[0]) : 8137;
  const maxAge = opt('--max-age');
  const store = new DataStore({ root: opt('--data') || defaultDataDir(), offline: args.includes('--offline'),
    maxAgeDays: maxAge !== undefined ? Number(maxAge) : 30, ...(opt('--vector-url') ? { vectorUrl: opt('--vector-url') } : {}), ...(opt('--hgt-url') ? { hgtUrl: opt('--hgt-url') } : {}), log: (msg) => console.log(msg) });
  createApp({ store }).listen(port, '127.0.0.1', () => {
    console.log(`OSMViewer Web: http://localhost:${port}/  (Strg+C beendet)`);
    console.log(`Datenverzeichnis: ${store.root}${store.offline ? '  [offline]' : ''}`);
  });
}
