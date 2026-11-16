import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGpx, newDoc, serializeGpx } from '../src/core/gpx.js';
import { compareDocs, summarize, resample } from '../src/core/compare.js';
import { transferItems } from '../src/core/ops.js';
import { destination, haversine, pathLength } from '../src/core/geo.js';
import { lookupElevations } from '../src/services/elevation.js';
import { requestUrl, archiveSource, TILE_SOURCES, customSource, storeName } from '../src/core/tilesources.js';

const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const line = (start, bearing, n, step = 50) => { const pts = [start]; for (let i = 1; i < n; i++) pts.push(destination(pts[i - 1], bearing, step)); return pts; };

test('compare: identical, contained, partial, new — lines and waypoints', () => {
  const base = { lat: 47.3, lon: 11.4 };
  const a = line(base, 90, 200);                       // 10 km eastwards
  const target = newDoc();
  target.tracks.push({ id: 'T1', segments: [{ points: a }] });
  target.waypoints.push({ id: 'W1', lat: 47.31, lon: 11.41, name: 'Hütte', ele: 1200 });
  const doc = newDoc();
  doc.tracks.push({ id: 'same', segments: [{ points: a.map((p) => ({ ...p })) }] });
  // every 3rd point, shifted 8 m north: same way, different recording
  doc.tracks.push({ id: 'inside', segments: [{ points: a.filter((_, i) => i % 3 === 0).map((p) => destination(p, 0, 8)) }] });
  // first half on the same way, then turning north
  const half = a.slice(0, 100); const partial = [...half, ...line(half.at(-1), 0, 100).slice(1)];
  doc.routes.push({ id: 'partial', points: partial });
  doc.tracks.push({ id: 'new', segments: [{ points: line({ lat: 47.5, lon: 11.4 }, 45, 50) }] });
  doc.waypoints.push({ id: 'w-same', lat: 47.31, lon: 11.41, name: 'Hütte', ele: 1200.2 });
  doc.waypoints.push({ id: 'w-near', ...destination({ lat: 47.31, lon: 11.41 }, 90, 12), name: 'Hütte (alt)' });
  doc.waypoints.push({ id: 'w-new', lat: 47.4, lon: 11.5, name: 'Gipfel' });
  const r = compareDocs(doc, target);
  assert.equal(r.get('same').status, 'identisch'); assert.equal(r.get('same').match, 'T1');
  assert.equal(r.get('inside').status, 'enthalten'); assert.ok(r.get('inside').coverage > 0.95); assert.equal(r.get('inside').match, 'T1');
  assert.equal(r.get('partial').status, 'teilweise');
  const expected = pathLength(half) / pathLength(partial);
  assert.ok(Math.abs(r.get('partial').coverage - expected) < 0.03, `coverage ${r.get('partial').coverage} vs ${expected}`);
  assert.equal(r.get('new').status, 'neu'); assert.equal(r.get('new').coverage, 0);
  assert.equal(r.get('w-same').status, 'identisch'); assert.equal(r.get('w-same').match, 'W1');
  assert.equal(r.get('w-near').status, 'enthalten');
  assert.equal(r.get('w-new').status, 'neu');
  assert.deepEqual(summarize(r), { neu: 2, teilweise: 1, enthalten: 2, identisch: 2 });
  // tolerance matters: 8 m offset is outside a 5 m tolerance
  assert.notEqual(compareDocs(doc, target, { tolerance: 5 }).get('inside').status, 'enthalten');
});

test('compare: legacy files against each other, and performance', () => {
  const utah = parseGpx(fx('utah.gpx'));
  const self = compareDocs(utah, parseGpx(fx('utah.gpx')));
  assert.ok([...self.values()].every((x) => x.status === 'identisch'), 'a file is identical to itself');
  const other = compareDocs(parseGpx(fx('sample.gpx')), utah);
  assert.ok([...other.values()].every((x) => x.status === 'neu'), 'different regions share nothing');
  const big = newDoc(); big.tracks.push({ id: 'b', segments: [{ points: line({ lat: 47, lon: 11 }, 60, 20000, 10) }] }); // 200 km
  const t0 = Date.now();
  const r = compareDocs(big, big);
  assert.equal(r.get('b').status, 'identisch');
  const shifted = newDoc(); shifted.tracks.push({ id: 's', segments: [{ points: big.tracks[0].segments[0].points.map((p) => destination(p, 150, 10)) }] });
  assert.equal(compareDocs(shifted, big).get('s').status, 'enthalten');
  assert.ok(Date.now() - t0 < 6000, 'fast enough: ' + (Date.now() - t0) + ' ms');
  const rs = resample([{ lat: 47, lon: 11 }, destination({ lat: 47, lon: 11 }, 90, 100)], 15);
  assert.equal(rs.length, 8); assert.ok(rs.every((p, i) => !i || haversine(rs[i - 1], p) <= 15.001));
});

test('transferItems: copies with new ids and source, move removes, inputs untouched', () => {
  const src = parseGpx(fx('utah.gpx')), dst = parseGpx(fx('sample.gpx'));
  src.waypoints.push({ id: 'wx', lat: 37.1, lon: -111.5, ele: 1300, name: 'Camp', time: '2020-01-01T00:00:00Z' });
  const ids = [src.routes[0].id, src.waypoints[0].id];
  const before = JSON.stringify([src.routes.length, dst.routes.length, src.waypoints.length]);
  const c = transferItems(src, dst, ids, { sourceName: 'utah.gpx' });
  assert.equal(c.dst.routes.length, dst.routes.length + 1); assert.equal(c.src, src, 'copy leaves the source');
  assert.equal(c.newIds.length, 2); assert.ok(!c.newIds.includes(ids[0]));
  assert.equal(c.dst.routes.at(-1).src, 'utah.gpx'); assert.equal(c.dst.waypoints.at(-1).src, 'utah.gpx');
  assert.notEqual(c.dst.routes.at(-1), src.routes[0], 'deep copy');
  const m = transferItems(src, dst, ids, { move: true, sourceName: 'utah.gpx' });
  assert.equal(m.src.routes.length, src.routes.length - 1); assert.equal(m.src.waypoints.length, src.waypoints.length - 1);
  assert.equal(JSON.stringify([src.routes.length, dst.routes.length, src.waypoints.length]), before, 'inputs untouched');
  // the source survives saving as GPX <src>
  const back = parseGpx(serializeGpx(c.dst));
  assert.equal(back.routes.at(-1).src, 'utah.gpx'); assert.equal(back.waypoints.at(-1).src, 'utah.gpx');
  assert.match(serializeGpx(c.dst), /<wpt [^>]*>\s*(<ele>[^<]*<\/ele>\s*)?(<time>[^<]*<\/time>\s*)?<name>[^<]*<\/name>[\s\S]*?<src>utah\.gpx<\/src>/);
});

test('elevation: local HGT first, online only for the gaps', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url, 'http://localhost');
    const lats = u.searchParams.get('latitude').split(',');
    const body = u.pathname === '/api/elevation' ? { elevation: lats.map((l) => (+l > 47 ? 1000 : null)) } : { elevation: lats.map(() => 42) };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const pts = [{ lat: 47.5, lon: 11 }, { lat: 46.5, lon: 11 }, { lat: 47.6, lon: 11 }];
    const r = await lookupElevations(pts, { local: true });
    assert.deepEqual(r.elevations, [1000, 42, 1000]); assert.equal(r.local, 2); assert.equal(r.online, 1);
    assert.equal(calls.length, 2); assert.match(calls[0], /^\/api\/elevation\?/); assert.match(calls[1], /open-meteo.*latitude=46\.50000&/);
    calls.length = 0;
    const o = await lookupElevations(pts, {});
    assert.deepEqual(o.elevations, [42, 42, 42]); assert.equal(calls.length, 1, 'without local server: online only');
  } finally { globalThis.fetch = orig; }
});

test('tile request URLs: local cache, archive, custom sources, hosted mode', () => {
  const osm = TILE_SOURCES.find((s) => s.id === 'osm');
  assert.equal(requestUrl(osm, 3, 9, 2, true), '/tiles/osm/3/1/2');
  assert.equal(requestUrl(osm, 3, 1, 2, false), 'https://tile.openstreetmap.org/3/1/2.png');
  const arch = archiveSource('My Topo', 16);
  assert.equal(requestUrl(arch, 14, 3000, 6000, true), '/archive/My%20Topo/14/3000/6000');
  assert.equal(requestUrl(arch, 14, 3000, 6000, false), null, 'archives need the local server');
  const c = customSource('Eigen', 'https://t.example/{z}/{x}/{y}.png');
  assert.equal(requestUrl(c, 1, 0, 1, true), 'https://t.example/1/0/1.png', 'custom sources go direct');
  assert.equal(storeName(osm), 'Mapnik'); assert.equal(storeName(TILE_SOURCES.find((s) => s.id === 'cyclosm')), 'cyclosm');
});
