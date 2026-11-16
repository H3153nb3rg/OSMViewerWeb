import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGpx, trackPoints, pointCount } from '../src/core/gpx.js';
import { rdpWeights, simplifyPoints, simplifyTrack, medianStep, minPointCount, LEVEL_MULTIPLIERS } from '../src/core/simplify.js';
import { splitByGaps, splitByMode, mergeShortRuns, removeDuplicates, speedsKmh } from '../src/core/repair.js';
import { haversine, bearing, rad, EARTH_RADIUS, destination } from '../src/core/geo.js';
import * as C from '../src/core/coords.js';
import * as P from '../src/core/printlayout.js';
import { buildOsrmUrl, parseOsrmResponse } from '../src/services/osrm.js';
import { parseSearchResponse } from '../src/services/nominatim.js';
import { buildElevationUrl } from '../src/services/elevation.js';
import { tileUrl, customSource, TILE_SOURCES, OVERLAY_SOURCES } from '../src/core/tilesources.js';

const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

// Independent reference: spherical distance from p to the great-circle segment a-b.
function sphericalSegDist(p, a, b) {
  const dab = haversine(a, b);
  if (dab < 1e-3) return haversine(p, a);
  const d13 = haversine(a, p) / EARTH_RADIUS, t13 = rad(bearing(a, p)), t12 = rad(bearing(a, b));
  const xt = Math.asin(Math.sin(d13) * Math.sin(t13 - t12));
  const at = Math.acos(Math.min(1, Math.cos(d13) / Math.cos(xt))) * EARTH_RADIUS * Math.sign(Math.cos(t13 - t12));
  if (at < 0) return haversine(p, a);
  if (at > dab) return haversine(p, b);
  return Math.abs(xt) * EARTH_RADIUS;
}
function maxDeviation(original, kept) {
  let worst = 0, k = 0;
  for (const p of original) {
    while (k + 1 < kept.length - 1 && kept[k + 1] !== p && original.indexOf(kept[k + 1]) < original.indexOf(p)) k++;
  }
  // straightforward O(n) walk: every original point lies between two consecutive kept points
  let seg = 0;
  for (const p of original) {
    if (p === kept[seg + 1] && seg + 1 < kept.length - 1) { seg++; continue; }
    if (p === kept[seg] || p === kept[seg + 1]) continue;
    worst = Math.max(worst, sphericalSegDist(p, kept[seg], kept[seg + 1]));
  }
  return worst;
}

const realTrack = () => {
  const docs = ['sample.gpx', 'Kauritatahi.gpx', 'utah.gpx'].map((n) => parseGpx(fx(n)));
  return docs.flatMap((d) => d.tracks).sort((a, b) => pointCount(b) - pointCount(a))[0];
};

test('simplify: RDP guarantee holds on a real legacy track (independent spherical check)', () => {
  const pts = trackPoints(realTrack());
  assert.ok(pts.length > 100, 'fixture track has ' + pts.length + ' points');
  for (const eps of [2, 10, 50, 250]) {
    const r = simplifyPoints(pts, { mode: 'tolerance', value: eps });
    assert.equal(r.points[0], pts[0]); assert.equal(r.points.at(-1), pts.at(-1));
    assert.ok(r.after <= r.before);
    const dev = maxDeviation(pts, r.points);
    assert.ok(dev <= eps * 1.02 + 0.05, `eps ${eps}: max deviation ${dev.toFixed(2)} m, kept ${r.after}/${r.before}`);
  }
});

test('simplify: weights are monotone, count/percent targets are exact', () => {
  const pts = trackPoints(realTrack());
  const w = rdpWeights(pts);
  assert.equal(w[0], Infinity); assert.equal(w.at(-1), Infinity);
  const keptAt = (e) => new Set(pts.filter((_, i) => w[i] > e));
  const a = keptAt(5), b = keptAt(40);
  for (const p of b) assert.ok(a.has(p), 'coarser result is a subset of the finer one');
  for (const n of [2, 3, 17, 100, pts.length]) assert.equal(simplifyPoints(pts, { mode: 'count', value: n }).after, Math.min(n, pts.length));
  assert.equal(simplifyPoints(pts, { mode: 'count', value: 1 }).after, 2, 'never fewer than both ends');
  assert.equal(simplifyPoints(pts, { mode: 'percent', value: 25 }).after, Math.max(2, Math.round(pts.length * 0.25)));
  assert.equal(simplifyPoints(pts, { mode: 'percent', value: 100 }).after, pts.length);
  // levels are ordered: higher level never keeps more points
  let prev = Infinity;
  for (let l = 1; l <= 10; l++) { const n = simplifyPoints(pts, { mode: 'level', value: l }).after; assert.ok(n <= prev); prev = n; }
  near(simplifyPoints(pts, { mode: 'level', value: 5 }).epsilon, LEVEL_MULTIPLIERS[5] * medianStep(pts), 1e-9);
});

test('simplify: degenerate input and performance', () => {
  assert.equal(simplifyPoints([], {}).after, 0);
  assert.equal(simplifyPoints([{ lat: 1, lon: 1 }], {}).after, 1);
  const line = Array.from({ length: 200000 }, (_, i) => ({ lat: 47, lon: 10 + i * 1e-5 }));
  const t0 = Date.now();
  assert.equal(simplifyPoints(line, { mode: 'tolerance', value: 1 }).after, 2, 'collinear points collapse');
  const noisy = line.map((p, i) => ({ lat: p.lat + Math.sin(i / 50) * 1e-3 + ((i * 7919) % 13) * 1e-6, lon: p.lon }));
  const r = simplifyPoints(noisy, { mode: 'percent', value: 5 });
  assert.equal(r.after, 10000);
  assert.ok(Date.now() - t0 < 5000, 'fast enough: ' + (Date.now() - t0) + ' ms');
  const dup = simplifyPoints([{ lat: 1, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 2 }], { mode: 'tolerance', value: 1 });
  assert.equal(dup.after, 2);
});

test('simplify: whole track, per segment and global count', () => {
  const seg = (lon0, n) => ({ points: Array.from({ length: n }, (_, i) => ({ lat: 47 + Math.sin(i / 3) * 0.001, lon: lon0 + i * 0.0002 })) });
  const track = { id: 't', name: 'x', segments: [seg(10, 300), seg(11, 100), { points: [{ lat: 1, lon: 1 }] }] };
  assert.equal(minPointCount(track), 5);
  const r = simplifyTrack(track, { mode: 'count', value: 50 });
  assert.equal(r.after, 50); assert.equal(r.before, 401); assert.equal(r.track.segments.length, 3);
  assert.equal(r.track.segments[2].points.length, 1);
  assert.equal(simplifyTrack(track, { mode: 'count', value: 0 }).after, 5);
  assert.equal(track.segments[0].points.length, 300, 'input untouched');
  const p = simplifyTrack(track, { mode: 'percent', value: 10 });
  assert.deepEqual(p.stats.map((s) => s.after), [30, 10, 1]);
});

test('repair: gap split, duplicates, means of transport', () => {
  const t0 = Date.parse('2024-06-01T08:00:00Z');
  const mk = (i, sec, lon) => ({ lat: 47, lon, time: new Date(t0 + sec * 1000).toISOString() });
  // 30 points every 5 s, then a 20 min pause, then 30 more
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push(mk(i, i * 5, 11 + i * 0.0001));
  for (let i = 0; i < 30; i++) pts.push(mk(i, 1200 + 150 + i * 5, 11.01 + i * 0.0001));
  const parts = splitByGaps(pts);
  assert.deepEqual(parts.map((p) => p.length), [30, 30]);
  assert.equal(splitByGaps(pts.map(({ time, ...p }) => p)).length, 1, 'no timestamps -> no split');
  assert.equal(removeDuplicates([pts[0], { ...pts[0] }, pts[1]]).length, 2);
  // walk 4 km/h for 60 points, drive 60 km/h for 60 points, walk again
  const seq = []; let lon = 11, sec = 0;
  const leg = (kmh, n) => { for (let i = 0; i < n; i++) { lon += (kmh / 3.6 * 5) / (111320 * Math.cos(rad(47))); sec += 5; seq.push(mk(0, sec, lon)); } };
  leg(4, 60); leg(60, 60); leg(4, 60);
  const modes = splitByMode(seq);
  assert.deepEqual(modes.map((m) => m.mode), ['walk', 'fast', 'walk']);
  near(modes[1].avgKmh, 60, 3); near(modes[0].points.length, 60, 4);
  assert.equal(modes.reduce((n, m) => n + m.points.length, 0), seq.length);
  near(speedsKmh(seq)[100], 60, 1);
  assert.deepEqual(mergeShortRuns(['a', 'a', 'a', 'b', 'a', 'a', 'a'], 2), new Array(7).fill('a'));
  assert.deepEqual(mergeShortRuns(['b', 'a', 'a', 'a'], 2), ['a', 'a', 'a', 'a']);
});

test('coords: UTM against published reference values', () => {
  // CN Tower, Toronto: 17T 630084 4833438 (Wikipedia "Universal Transverse Mercator coordinate system")
  const u = C.latLonToUtm(43.642566, -79.387139);
  assert.equal(u.zone, 17); assert.equal(u.band, 'T'); near(u.easting, 630084, 1.5); near(u.northing, 4833438, 1.5);
  // Statue of Liberty lies in MGRS 100 km square 18T WL
  assert.match(C.latLonToMgrs(40.689247, -74.044502).replace(/\s/g, ''), /^18TWL\d{10}$/);
  // equator / central meridian identities
  const e = C.latLonToUtm(0, 15); near(e.easting, 500000, 1e-6); near(e.northing, 0, 1e-6); assert.equal(e.zone, 33);
  const sh = C.latLonToUtm(-0.000001, 15); near(sh.northing, 10000000, 1);
  assert.equal(C.utmZone(60, 5), 32, 'Norway exception'); assert.equal(C.utmZone(78, 15), 33, 'Svalbard exception');
  // 1 degree of latitude on the central meridian = 110574.4 m (WGS84) * k0
  near(C.latLonToUtm(1, 15).northing, 110574.39 * 0.9996, 0.5);
});

test('coords: round trips over the globe (UTM, MGRS, Maidenhead, OLC)', () => {
  let n = 0;
  for (let lat = -79.5; lat <= 83.5; lat += 3.7) for (let lon = -179.3; lon <= 179.9; lon += 7.3) {
    const u = C.latLonToUtm(lat, lon), b = C.utmToLatLon(u.zone, u.easting, u.northing, u.north);
    // series accuracy: < 0.1 m even in the widened Norway/Svalbard zones
    near(b.lat, lat, 1e-6, `utm lat @${lat},${lon}`); near(b.lon, lon, 1e-6, `utm lon @${lat},${lon}`);
    const m = C.mgrsToLatLon(C.latLonToMgrs(lat, lon));
    assert.ok(m, `mgrs parse @${lat},${lon}: ${C.latLonToMgrs(lat, lon)}`);
    assert.ok(haversine(m, { lat, lon }) < 1.5, `mgrs @${lat},${lon}: ${haversine(m, { lat, lon })}`);
    const mh = C.maidenheadToLatLon(C.latLonToMaidenhead(lat, lon, 4));
    assert.ok(haversine(mh, { lat, lon }) < 700, 'maidenhead');
    const o = C.olcToLatLon(C.latLonToOlc(lat, lon));
    assert.ok(haversine(o, { lat, lon }) < 15, `olc @${lat},${lon}`);
    n++;
  }
  assert.ok(n > 2000);
  assert.equal(C.latLonToMaidenhead(48.2082, 16.3738), 'JN88ee', 'Wien (Stephansplatz)');
  assert.equal(C.latLonToOlc(47.365590, 8.524997), '8FVC9G8F+6X', 'reference code from the OLC specification');
  const z = C.olcToLatLon('8FVC9G8F+6X'); near(z.lat, 47.365562, 1e-4); near(z.lon, 8.524968, 1e-4);
});

test('coords: free-form input parsing', () => {
  const cases = [
    ['48.2082, 16.3738', 48.2082, 16.3738], ['48.2082 16.3738', 48.2082, 16.3738], ['-33.8568 151.2153', -33.8568, 151.2153],
    ['48,2082; 16,3738', 48.2082, 16.3738], ['48,2082 16,3738', 48.2082, 16.3738],
    ['N 48° 12.492\' E 016° 22.428\'', 48.2082, 16.3738], ['48°12.492\'N 16°22.428\'E', 48.2082, 16.3738],
    ['N48 12.492 E16 22.428', 48.2082, 16.3738],
    ['48°12\'29.5"N 16°22\'25.7"E', 48.208194, 16.373806], ['48 12 29.5 N, 16 22 25.7 O', 48.208194, 16.373806],
    ['S 33° 51\' 24.5" E 151° 12\' 55.1"', -33.856806, 151.215306], ['37.1283 N 111.4951 W', 37.1283, -111.4951],
    ['W 111.4951 N 37.1283', 37.1283, -111.4951], ['E16.3738 N48.2082', 48.2082, 16.3738],
    ['lat 48.2082 lon 16.3738', 48.2082, 16.3738], ['Breite: 48.2082 Länge: 16.3738', 48.2082, 16.3738],
    ['geo:48.2082,16.3738?z=15', 48.2082, 16.3738], ['48.2082 Nord 16.3738 Ost', 48.2082, 16.3738],
    ['17T 630084 4833438', 43.642566, -79.387139], ['17 T 630084 4833438', 43.642566, -79.387139], ['17T 630084mE 4833438mN', 43.642566, -79.387139],
    ['JN88ee', 48.2082, 16.3738, 0.05], ['8FVC9G8F+6X', 47.36556, 8.52497, 7e-5],
  ];
  for (const [text, lat, lon, tol = 2e-5] of cases) {
    const p = C.parseCoordinate(text);
    assert.ok(p, 'parses: ' + text);
    near(p.lat, lat, tol, text + ' lat'); near(p.lon, lon, tol, text + ' lon');
  }
  const wien = C.parseCoordinate(C.formatCoordinate(48.2082, 16.3738, 'mgrs'));
  assert.equal(wien.format, 'mgrs'); assert.ok(haversine(wien, { lat: 48.2082, lon: 16.3738 }) < 1.5);
  for (const bad of ['', 'Wien', '91 10', '48.2', '48 61 0 N 16 0 0 E', 'N 48 N 16', '-48 S 16 E', '1 2 3', '33U 60 5340376', 'Hauptstraße 12', '10 Downing Street']) {
    assert.equal(C.parseCoordinate(bad), null, 'rejects: ' + bad);
  }
  // every formatter output parses back to (nearly) the same place
  for (const fmt of Object.keys(C.COORD_FORMATS)) for (const [lat, lon] of [[48.2082, 16.3738], [-33.8568, 151.2153], [37.1283, -111.4951], [-0.5, -0.25], [59.99999, 9.99999]]) {
    const txt = C.formatCoordinate(lat, lon, fmt), p = C.parseCoordinate(txt);
    assert.ok(p, `${fmt}: "${txt}" parses`);
    assert.ok(haversine(p, { lat, lon }) < (fmt === 'maidenhead' ? 6000 : fmt === 'olc' ? 15 : 2), `${fmt}: "${txt}" -> ${p.lat},${p.lon}`);
  }
});

test('print: single page fit keeps everything on the page and picks the orientation', () => {
  const wide = [{ lat: 47.0, lon: 11.0 }, { lat: 47.05, lon: 11.6 }], tall = [{ lat: 47.0, lon: 11.0 }, { lat: 47.6, lon: 11.05 }];
  const pw = P.fitPage(wide, { paper: 'A4' }), pt = P.fitPage(tall, { paper: 'A4' });
  assert.equal(pw.orientation, 'landscape'); assert.equal(pt.orientation, 'portrait');
  for (const [pts, page] of [[wide, pw], [tall, pt]]) {
    const b = P.pageBounds(page);
    for (const p of pts) assert.ok(p.lat > b.minLat && p.lat < b.maxLat && p.lon > b.minLon && p.lon < b.maxLon, 'point on page');
    // tight: the padded geometry touches the printable area in at least one dimension
    const padDeg = (8 / 25.4 * 150) * 2;
    const spanX = (pts[1].lon - pts[0].lon) / (b.maxLon - b.minLon) * page.widthPx + padDeg;
    const mercSpanY = page.heightPx * (pts[1].lat - pts[0].lat) / (b.maxLat - b.minLat) + padDeg;
    assert.ok(Math.max(spanX / page.widthPx, mercSpanY / page.heightPx) > 0.97, 'fills the page');
  }
  const g = P.pageGeometry({ paper: 'A4', orientation: 'landscape', marginMm: 10, headerMm: 8, dpi: 150 });
  assert.equal(g.widthPx, Math.round(277 / 25.4 * 150)); assert.equal(g.heightPx, Math.round(182 / 25.4 * 150));
  assert.equal(P.fitPage(wide, { orientation: 'portrait' }).orientation, 'portrait');
  assert.ok(P.fitPage([{ lat: 47, lon: 11 }], { maxZoom: 17 }).zoom <= 17.5, 'single point is clamped to max zoom');
  assert.equal(P.fitPage([], {}), null);
  const r = P.fitPage(wide, { roundScale: true });
  assert.ok(P.COMMON_SCALES.some((s) => Math.abs(s - r.scale) < 1), 'nice scale: ' + r.scale); assert.ok(r.zoom <= pw.zoom);
});

test('print: scale maths', () => {
  // 1:50 000 -> 1 mm on paper = 50 m on the ground
  const z = P.zoomForScale(47, 50000, 150);
  near(P.scaleAt(47, z, 150), 50000, 1e-6);
  const page = { ...P.pageGeometry({ paper: 'A4', orientation: 'portrait', dpi: 150 }), center: { lat: 47, lon: 11 }, zoom: z };
  const b = P.pageBounds(page);
  const groundWidth = haversine({ lat: 47, lon: b.minLon }, { lat: 47, lon: b.maxLon });
  near(groundWidth, 190 * 50, 190 * 50 * 0.003, 'printable width 190 mm = 9.5 km');
  const sb = P.scaleBar(47, z, 150); assert.ok([1, 2, 5].includes(+String(sb.metres)[0])); assert.ok(sb.px <= 150 && sb.px > 50);
});

test('print: multi page layout along a path', () => {
  // ~120 km path heading north-east with a wiggle
  const path = []; let p = { lat: 47, lon: 11 };
  for (let i = 0; i < 600; i++) { path.push(p); p = destination(p, 45 + 40 * Math.sin(i / 40), 200); }
  const pages = P.layoutPages(path, { scale: 50000, paper: 'A4' });
  assert.ok(pages.length >= 4 && pages.length <= 12, 'pages: ' + pages.length);
  assert.equal(pages[0].fromIndex, 0); assert.equal(pages.at(-1).toIndex, path.length - 1);
  pages.forEach((pg, k) => {
    if (k) assert.equal(pg.fromIndex, pages[k - 1].toIndex, 'pages are contiguous');
    const b = P.pageBounds(pg);
    for (let i = pg.fromIndex; i <= pg.toIndex; i++) {
      const q = path[i];
      assert.ok(q.lat >= b.minLat && q.lat <= b.maxLat && q.lon >= b.minLon && q.lon <= b.maxLon, `point ${i} on page ${k}`);
    }
    near(pg.scale, 50000, 600);
  });
  assert.equal(P.layoutPages(path.slice(0, 5), { scale: 50000 }).length, 1);
  assert.ok(P.layoutPages(path, { scale: 25000 }).length > pages.length);
  assert.ok(P.layoutPages(path, { scale: 50000, orientation: 'portrait' }).every((g) => g.orientation === 'portrait'));
});

test('services: request building and response parsing', () => {
  const url = buildOsrmUrl([{ lat: 48.2082, lon: 16.3738 }, { lat: 47.8095, lon: 13.055 }], 'foot');
  assert.equal(url, 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/16.373800,48.208200;13.055000,47.809500?overview=full&geometries=geojson&steps=false&alternatives=false');
  const r = parseOsrmResponse({ code: 'Ok', routes: [{ distance: 1234.5, duration: 99, geometry: { type: 'LineString', coordinates: [[16.37, 48.2], [16.38, 48.21]] } }],
    waypoints: [{ location: [16.37, 48.2], name: 'Ring' }, { location: [16.38, 48.21], name: '' }] });
  assert.deepEqual(r.points, [{ lat: 48.2, lon: 16.37 }, { lat: 48.21, lon: 16.38 }]); assert.equal(r.distance, 1234.5);
  assert.throws(() => parseOsrmResponse({ code: 'NoRoute', message: 'Impossible route' }), /Impossible route/);
  const s = parseSearchResponse([{ lat: '48.2', lon: '16.3', display_name: 'Wien, Österreich', name: 'Wien', boundingbox: ['48.1', '48.3', '16.1', '16.5'] }, { lat: 'x', lon: '1' }]);
  assert.equal(s.length, 1); assert.equal(s[0].bbox.maxLon, 16.5);
  assert.equal(buildElevationUrl([{ lat: 47.1, lon: 11.2 }, { lat: 47.3, lon: 11.4 }]), 'https://api.open-meteo.com/v1/elevation?latitude=47.10000,47.30000&longitude=11.20000,11.40000');
});

test('tile sources: URL templates', () => {
  const osm = TILE_SOURCES.find((s) => s.id === 'osm');
  assert.equal(tileUrl(osm, 3, 9, 2), 'https://tile.openstreetmap.org/3/1/2.png', 'x wraps');
  assert.match(tileUrl(TILE_SOURCES.find((s) => s.id === 'opentopo'), 5, 3, 4), /^https:\/\/[abc]\.tile\.opentopomap\.org\/5\/3\/4\.png$/);
  assert.equal(tileUrl(TILE_SOURCES.find((s) => s.id === 'usgs-topo'), 5, 3, 4).split('/tile/')[1], '5/4/3', 'ArcGIS order z/y/x');
  assert.equal(tileUrl({ url: 'http://x/{z}/{x}/{-y}.png' }, 2, 1, 0), 'http://x/2/1/3.png');
  for (const s of [...TILE_SOURCES, ...OVERLAY_SOURCES]) { assert.ok(s.url.startsWith('https://') && s.attribution && s.maxZoom, s.id); }
  assert.equal(new Set([...TILE_SOURCES, ...OVERLAY_SOURCES].map((s) => s.id)).size, TILE_SOURCES.length + OVERLAY_SOURCES.length);
  assert.throws(() => customSource('x', 'ftp://a/{z}/{x}/{y}'), /URL-Vorlage/);
  assert.equal(customSource('Mein Server', 'https://t/{z}/{x}/{y}.png').id, 'custom-mein-server');
});
