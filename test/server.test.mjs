// Local server: persistent tile cache, archive layers and HGT elevation, against a fake upstream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, deflateRawSync } from 'node:zlib';
import { DataStore, defaultDataDir, unzipFirst } from '../server/datastore.mjs';
import { createApp } from '../serve.mjs';
import { hgtName, hgtTile, hgtElevation } from '../src/core/hgt.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

/** Minimal single-file ZIP (deflate). */
function zip(name, data) {
  const comp = deflateRawSync(data), n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + n.length, 12); eocd.writeUInt32LE(30 + n.length + comp.length, 16);
  return Buffer.concat([local, n, comp, cd, n, eocd]);
}
/** Synthetic HGT cell (n = 1201 or 3601); fn(north 0..1, east 0..1) -> metres. */
function hgt(fn, n = 1201) {
  const b = Buffer.alloc(n * n * 2);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) b.writeInt16BE(fn((n - 1 - r) / (n - 1), c / (n - 1)), (r * n + c) * 2);
  return b;
}

let root, calls, fail, store, server, base;
const fakeFetch = async (url) => {
  calls.push(url);
  if (fail) throw new TypeError('network down');
  const ok = (buf) => ({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
  if (url.includes('tile.openstreetmap.org')) return ok(PNG);
  if (url.includes('World_Imagery')) return ok(JPG);
  if (url.includes('opentopomap')) return ok(Buffer.from('<html>error page</html>'));
  if (url === 'https://tiles.openfreemap.org/planet/latest/10/544/358.pbf') return ok(Buffer.from([26, 2, 120, 2]));
  if (url === 'https://tiles.openfreemap.org/planet/latest/10/545/358.pbf') return ok(gzipSync(Buffer.from([26, 2, 120, 2])));
  if (url === 'https://tiles.openfreemap.org/planet/latest/10/546/358.pbf') return ok(Buffer.from('<html>Fehler</html>'));
  if (url === 'https://tiles.openfreemap.org/planet/latest/3/0/0.pbf') return { ok: false, status: 404 };
  if (url.endsWith('/skadi/N48/N48E016.hgt.gz')) return ok(gzipSync(hgt((n, e) => Math.round(200 + 100 * n + 50 * e), 3601)));
  return { ok: false, status: 403 };
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'osmv-'));
  calls = []; fail = false;
  store = new DataStore({ root, fetch: fakeFetch });
  server = createApp({ store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('data directory follows the Java application', () => {
  assert.equal(defaultDataDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32').replace(/\\/g, '/'), 'C:/Users/x/AppData/Roaming/JF/OSMViewer');
  assert.equal(defaultDataDir({ OSMV_DATA: '/data/x', APPDATA: 'y' }, 'win32'), '/data/x');
  assert.match(defaultDataDir({}, 'linux'), /\.osmviewer$/);
});

test('tiles: first request downloads, second is served from disk, legacy store names', async () => {
  const a = await fetch(`${base}/tiles/osm/5/17/11`);
  assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'image/png'); assert.equal(a.headers.get('x-tile-from'), 'network');
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), PNG);
  assert.deepEqual(calls, ['https://tile.openstreetmap.org/5/17/11.png']);
  assert.deepEqual(await readFile(join(root, 'MapCache', 'tiles', 'Mapnik', '5', '17', '11.png')), PNG, 'stored under the Java store name');
  const b = await fetch(`${base}/tiles/osm/5/17/11`);
  assert.equal(b.headers.get('x-tile-from'), 'cache'); assert.equal(calls.length, 1, 'no second download');
  const j = await fetch(`${base}/tiles/esri-imagery/3/2/1`);
  assert.equal(j.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(await readdir(join(root, 'MapCache', 'tiles', 'ArcGISSatellite', '3', '2')), ['1.jpg']);
  const [x, y, z] = await Promise.all([1, 2, 3].map(() => store.tile('osm', 6, 1, 1)));
  assert.ok(x && y && z); assert.equal(calls.filter((u) => u.endsWith('/6/1/1.png')).length, 1, 'concurrent requests share one download');
});

test('tiles exported from the Java cache are used without any download', async () => {
  // layout written by tools/MapCacheExport.java: <MapCache>/tiles/<store>/z/x/y.ext
  await mkdir(join(root, 'MapCache', 'tiles', 'OpenTopoMap', '12', '2200'), { recursive: true });
  await writeFile(join(root, 'MapCache', 'tiles', 'OpenTopoMap', '12', '2200', '1400.png'), PNG);
  const n = calls.length;
  const r = await fetch(`${base}/tiles/opentopo/12/2200/1400`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-tile-from'), 'cache'); assert.equal(calls.length, n);
});

test('archive layers: folders without a catalogue source, disk only', async () => {
  await mkdir(join(root, 'MapCache', 'tiles', 'My Topo', '14', '3000'), { recursive: true });
  await mkdir(join(root, 'MapCache', 'tiles', 'My Topo', '9'), { recursive: true });
  await writeFile(join(root, 'MapCache', 'tiles', 'My Topo', '14', '3000', '6000.jpg'), JPG);
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.deepEqual(info.archives, [{ store: 'My Topo', minZoom: 9, maxZoom: 14 }], 'catalogue stores (Mapnik …) are not listed');
  assert.equal(info.root, root); assert.equal(info.cache, true);
  const n = calls.length;
  const a = await fetch(`${base}/archive/${encodeURIComponent('My Topo')}/14/3000/6000`);
  assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}/archive/${encodeURIComponent('My Topo')}/14/3000/6001`)).status, 404);
  assert.equal((await fetch(`${base}/archive/Mapnik/5/17/11`)).status, 404, 'catalogue stores are not archives');
  assert.ok([403, 404].includes((await fetch(`${base}/archive/..%2F..%2F/1/0/0`)).status));
  assert.equal(calls.length, n, 'archives never download');
});

test('tiles: stale copies bridge network failures, expired ones are refreshed', async () => {
  const file = join(root, 'MapCache', 'tiles', 'Mapnik', '5', '17', '11.png');
  const old = new Date(Date.now() - 40 * 864e5); await utimes(file, old, old);
  const n = calls.length;
  assert.equal((await fetch(`${base}/tiles/osm/5/17/11`)).headers.get('x-tile-from'), 'network'); assert.equal(calls.length, n + 1);
  await utimes(file, old, old); fail = true;
  const s = await fetch(`${base}/tiles/osm/5/17/11`);
  assert.equal(s.status, 200); assert.equal(s.headers.get('x-tile-from'), 'stale');
  assert.equal((await fetch(`${base}/tiles/osm/9/1/1`)).status, 404, 'unknown tile while offline');
  fail = false;
  const off = new DataStore({ root, fetch: fakeFetch, offline: true });
  const m = calls.length; await utimes(file, old, old);
  assert.equal((await off.tile('osm', 5, 17, 11)).from, 'cache'); assert.equal(await off.tile('osm', 7, 1, 1), null); assert.equal(calls.length, m, '--offline never downloads');
  const forever = new DataStore({ root, fetch: fakeFetch, maxAgeDays: 0 });
  assert.equal((await forever.tile('osm', 5, 17, 11)).from, 'cache', '--max-age 0 keeps tiles forever like the Java app');
});

test('tiles: only catalogue sources and valid addresses — no open proxy', async () => {
  for (const p of ['/tiles/evil/1/0/0', '/tiles/osm/3/8/0', '/tiles/osm/30/0/0', '/tiles/osm/1/0', '/tiles/..%2f..%2fetc/1/0/0', '/tiles/custom-x/1/0/0']) {
    assert.ok([403, 404].includes((await fetch(base + p)).status), p);
  }
  assert.equal((await fetch(`${base}/tiles/opentopo/1/0/0`)).status, 404, 'non-image upstream answers are not cached');
  assert.equal((await fetch(`${base}/../../etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/tiles/osm/5/17/11`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'foreign web pages are refused');
  assert.equal((await fetch(`${base}/src/ui/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('hgt decoding (shared core module)', () => {
  const data = Buffer.from('hello hello hello hello');
  assert.deepEqual(unzipFirst(zip('a.txt', data)), data);
  assert.throws(() => unzipFirst(Buffer.from('not a zip at all, definitely')), /ZIP/);
  assert.equal(hgtName(47.3, 11.9), 'N47E011'); assert.equal(hgtName(-0.5, -0.5), 'S01W001'); assert.equal(hgtName(37.1, -111.5), 'N37W112');
  for (const n of [1201, 3601]) {
    const t = hgtTile(hgt((no, e) => Math.round(1000 * no + 500 * e), n), 'N47E011');
    assert.ok(Math.abs(hgtElevation(t, 47.5, 11.5) - 750) < 1); assert.ok(Math.abs(hgtElevation(t, 47.0, 11.0)) < 1);
    assert.ok(Math.abs(hgtElevation(t, 47.999, 11.999) - 1498.5) < 2); assert.ok(Number.isNaN(hgtElevation(t, 46.9, 11.5)), 'outside the cell');
  }
  const v = hgtTile(hgt(() => -32768), 'N47E011'); assert.ok(Number.isNaN(hgtElevation(v, 47.5, 11.5)));
  const holes = hgtTile(hgt((no, e) => (e > 0.5 ? -32768 : 300)), 'N47E011');
  assert.equal(Math.round(hgtElevation(holes, 47.5, 11.5)), 300, 'void corners are bridged');
  assert.throws(() => hgtTile(Buffer.alloc(1000), 'X'), /HGT-Größe/);
});

test('elevation: cells of the Java app are reused, missing ones are downloaded next to them', async () => {
  // the Java app keeps raw SRTM3 cells in MapCache/hgtCacheDirectory
  await mkdir(join(root, 'MapCache', 'hgtCacheDirectory'), { recursive: true });
  await writeFile(join(root, 'MapCache', 'hgtCacheDirectory', 'N47E011.hgt'), hgt((n, e) => Math.round(1000 * n + 500 * e)));
  // older SRTM zip download in a region folder
  await mkdir(join(root, 'SRTM', 'North_America'), { recursive: true });
  await writeFile(join(root, 'SRTM', 'North_America', 'N37W112.hgt.zip'), zip('N37W112.hgt', hgt(() => 1500)));
  const n = calls.length;
  const r = await (await fetch(`${base}/api/elevation?latitude=47.5,47.25,37.5&longitude=11.5,11.75,-111.5`)).json();
  assert.equal(r.source, 'hgt-local'); assert.ok(Math.abs(r.elevation[0] - 750) < 1); assert.ok(Math.abs(r.elevation[1] - 625) < 1);
  assert.equal(r.elevation[2], 1500);
  assert.equal(calls.length, n, 'no network needed for existing cells');
  const d = await (await fetch(`${base}/api/elevation?latitude=48.5,10.5&longitude=16.5,-30.5`)).json();
  assert.ok(Math.abs(d.elevation[0] - 275) < 1, 'downloaded cell'); assert.equal(d.elevation[1], null, 'no data over the sea');
  assert.ok(calls.includes('https://s3.amazonaws.com/elevation-tiles-prod/skadi/N48/N48E016.hgt.gz'));
  const files = await readdir(join(root, 'MapCache', 'hgtCacheDirectory'));
  assert.ok(files.includes('N48E016.hgt'), 'stored uncompressed next to the Java cells');
  assert.ok(files.includes('N10W031.none'), 'sea cell remembered');
  const fresh = new DataStore({ root, fetch: fakeFetch });
  const m = calls.length;
  await fresh.elevations([48.6, 10.5], [16.6, -30.5]); assert.equal(calls.length, m, 'after a restart nothing is fetched again');
  assert.equal((await fetch(`${base}/api/elevation?latitude=1,2&longitude=3`)).status, 400);
});

test('vector tiles for the poster: cached on disk, gzip unpacked, empty tiles remembered', async () => {
  const a = await fetch(`${base}/vector/10/544/358`);
  assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'application/x-protobuf'); assert.equal(a.headers.get('x-tile-from'), 'network');
  assert.deepEqual([...new Uint8Array(await a.arrayBuffer())], [26, 2, 120, 2]);
  assert.deepEqual([...await readFile(join(root, 'MapCache', 'tiles', 'OpenFreeMap', '10', '544', '358.pbf'))], [26, 2, 120, 2]);
  const n = calls.length;
  assert.equal((await fetch(`${base}/vector/10/544/358`)).headers.get('x-tile-from'), 'cache'); assert.equal(calls.length, n);
  const z = await fetch(`${base}/vector/10/545/358`);
  assert.deepEqual([...new Uint8Array(await z.arrayBuffer())], [26, 2, 120, 2], 'gzip unpacked before storing');
  assert.equal((await fetch(`${base}/vector/10/546/358`)).status, 404, 'error pages are not cached as tiles');
  const sea = await fetch(`${base}/vector/3/0/0`);
  assert.equal(sea.status, 200); assert.equal((await sea.arrayBuffer()).byteLength, 0, 'empty tile');
  const m = calls.length; await fetch(`${base}/vector/3/0/0`); assert.equal(calls.length, m, 'empty tile is cached too');
  assert.equal((await fetch(`${base}/vector/15/0/0`)).status, 404); assert.equal((await fetch(`${base}/vector/3/9/0`)).status, 404);
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.ok(!info.archives.some((x) => x.store === 'OpenFreeMap'), 'vector cache is not offered as a raster archive');
});

test('elevation grid for contour lines', async () => {
  // N47E011 from the earlier test: plane 1000*north + 500*east
  const g = await (await fetch(`${base}/api/elevgrid?south=47.2&west=11.2&north=47.4&east=11.6&cols=5&rows=3`)).json();
  assert.equal(g.cols, 5); assert.equal(g.rows, 3); assert.equal(g.data.length, 15); assert.equal(g.known, 15);
  assert.ok(Math.abs(g.data[0] - (400 + 100)) < 1.5, 'north-west corner first: ' + g.data[0]);
  assert.ok(Math.abs(g.data[14] - (200 + 300)) < 1.5, 'south-east corner last: ' + g.data[14]);
  assert.ok(Math.abs(g.data[7] - (300 + 200)) < 1.5, 'centre');
  const sea = await (await fetch(`${base}/api/elevgrid?south=10.2&west=-30.8&north=10.4&east=-30.6&cols=3&rows=3`)).json();
  assert.equal(sea.known, 0); assert.ok(sea.data.every((v) => v === null));
  for (const q of ['south=47&west=11&north=46&east=12&cols=5&rows=5', 'south=47&west=11&north=48&east=12&cols=5000&rows=5000', 'south=40&west=0&north=48&east=9&cols=9&rows=9', 'south=47&west=11&north=48&east=12&cols=1&rows=5']) {
    assert.equal((await fetch(`${base}/api/elevgrid?${q}`)).status, 400, q);
  }
});

test('usage endpoint walks the cache on demand', async () => {
  const u = await (await fetch(`${base}/api/usage`)).json();
  assert.ok(u.tiles.Mapnik.files >= 2 && u.tiles.Mapnik.bytes > 0); assert.ok(u.hgt.files >= 2);
  assert.ok(u.stats.tileDownloads >= 3 && u.stats.tileHits >= 1 && u.stats.hgtDownloads === 1);
});

test('real legacy export (if present): tiles written by MapCacheExport.java are served', async (t) => {
  const exported = join(process.env.HOME || '', 'scratch', 'tiles', 'Mapnik');
  const dir = await readdir(exported).catch(() => null);
  if (!dir) { t.skip('no exported legacy cache on this machine'); return; }
  const r2 = await mkdtemp(join(tmpdir(), 'osmv-legacy-'));
  await cp(exported, join(r2, 'MapCache', 'tiles', 'Mapnik'), { recursive: true });
  const z = dir.filter((d) => /^\d+$/.test(d))[0], x = (await readdir(join(exported, z)))[0], y = (await readdir(join(exported, z, x)))[0].split('.')[0];
  const s = new DataStore({ root: r2, fetch: () => { throw new Error('must not download'); } });
  const tile = await s.tile('osm', +z, +x, +y);
  assert.equal(tile.from, 'cache'); assert.equal(tile.type, 'image/png');
});
