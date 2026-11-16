import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, cornerLabels } from '../src/core/grid.js';
import { latLonToUtm } from '../src/core/coords.js';

const tirol = { minLat: 47.20, maxLat: 47.32, minLon: 11.30, maxLon: 11.50 };

test('graticule: nice steps, lines inside the view, labels per format', () => {
  const g = buildGrid(tirol, 'dd', 1000, 130);
  assert.equal(g.kind, 'graticule'); assert.equal(g.step, 0.05);
  const xs = g.lines.filter((l) => l.axis === 'x'), ys = g.lines.filter((l) => l.axis === 'y');
  assert.deepEqual(xs.map((l) => l.label), ['11.30° E', '11.35° E', '11.40° E', '11.45° E', '11.50° E']);
  assert.deepEqual(ys.map((l) => l.label), ['47.20° N', '47.25° N', '47.30° N']);
  for (const l of xs) assert.ok(l.points[0].lon === l.points[1].lon && l.points[0].lat === tirol.minLat && l.points[1].lat === tirol.maxLat);
  const m = buildGrid(tirol, 'dmm', 1000, 130);
  assert.equal(m.step, 2 / 60, 'sexagesimal formats use minute steps');
  assert.ok(m.lines.some((l) => l.label === "11° 20' E") && m.lines.some((l) => l.label === "47° 14' N"));
  const s = buildGrid({ minLat: 47.2, maxLat: 47.21, minLon: 11.3, maxLon: 11.32 }, 'dms', 1000, 130);
  assert.ok(s.step < 1 / 60 && s.lines.every((l) => /^\d+° \d{2}' \d{2}" [NE]$/.test(l.label)), s.lines[0].label);
  const w = buildGrid({ minLat: -1, maxLat: 1, minLon: -1, maxLon: 1 }, 'dd', 400, 100);
  assert.ok(w.lines.some((l) => l.label === '0.0° E' || l.label === '0° E') && w.lines.some((l) => / W$/.test(l.label)) && w.lines.some((l) => / S$/.test(l.label)));
  const world = buildGrid({ minLat: -80, maxLat: 80, minLon: -180, maxLon: 180 }, 'dms', 800, 100);
  assert.ok(world.lines.length < 40 && world.lines.length > 4, 'coarse views stay legible: ' + world.lines.length);
  assert.equal(buildGrid(tirol, 'maidenhead', 1000).kind, 'graticule');
});

test('utm grid: lines carry round UTM values and really lie on them', () => {
  const g = buildGrid(tirol, 'utm', 1000, 130);
  assert.equal(g.kind, 'utm'); assert.equal(g.step, 2000);
  const xs = g.lines.filter((l) => l.axis === 'x'), ys = g.lines.filter((l) => l.axis === 'y');
  assert.ok(xs.length >= 5 && ys.length >= 5);
  for (const l of xs) {
    assert.match(l.label, /^E \d+ km$/);
    const km = +l.label.match(/\d+/)[0];
    for (const p of l.points) assert.ok(Math.abs(latLonToUtm(p.lat, p.lon, 32).easting - km * 1000) < 0.05, 'point on the easting line');
    assert.ok(l.points[0].lat <= tirol.minLat + 0.02 && l.points.at(-1).lat >= tirol.maxLat - 0.02, 'line spans the view');
  }
  for (const l of ys) {
    const km = +l.label.match(/\d+/)[0];
    for (const p of l.points) assert.ok(Math.abs(latLonToUtm(p.lat, p.lon, 32).northing - km * 1000) < 0.05, 'point on the northing line');
  }
  const fine = buildGrid({ minLat: 47.26, maxLat: 47.27, minLon: 11.39, maxLon: 11.41 }, 'mgrs', 1000, 130);
  assert.equal(fine.step, 200); assert.ok(fine.lines.every((l) => / m$/.test(l.label)));
});

test('utm grid: zone boundary, southern hemisphere, fallback', () => {
  const two = buildGrid({ minLat: 47, maxLat: 47.5, minLon: 11.5, maxLon: 12.5 }, 'utm', 1000, 130); // zones 32 | 33 meet at 12° E
  assert.ok(two.lines.some((l) => l.label.startsWith('32: ')) && two.lines.some((l) => l.label.startsWith('33: ')));
  for (const l of two.lines) {
    const west = l.label.startsWith('32');
    for (const p of l.points) assert.ok(west ? p.lon <= 12 + 1e-6 : p.lon >= 12 - 1e-6, 'lines stop at the zone boundary');
  }
  const south = buildGrid({ minLat: -33.95, maxLat: -33.75, minLon: 151.1, maxLon: 151.4 }, 'utm', 1000, 130);
  const n = south.lines.find((l) => l.axis === 'y');
  assert.match(n.label, /^N 62\d\d km$/, 'false northing of 10 000 km applied: ' + n.label);
  assert.ok(n.points.every((p) => p.lat < -33.7 && p.lat > -34));
  const eq = buildGrid({ minLat: -0.1, maxLat: 0.1, minLon: 9.9, maxLon: 10.1 }, 'utm', 800, 130);
  assert.ok(eq.lines.some((l) => /^N 0 km$/.test(l.label)) && eq.lines.some((l) => /^N 99\d\d km$/.test(l.label)), 'continuous across the equator');
  assert.equal(buildGrid({ minLat: 40, maxLat: 55, minLon: 0, maxLon: 30 }, 'utm', 1000).kind, 'graticule', 'too many zones -> degrees');
  assert.equal(buildGrid({ minLat: 80, maxLat: 88, minLon: 0, maxLon: 5 }, 'utm', 1000).kind, 'graticule', 'outside UTM');
});

test('corner labels in every format', () => {
  const c = cornerLabels(tirol, 'dd');
  assert.equal(c.nw, '47.320000, 11.300000'); assert.equal(c.se, '47.200000, 11.500000');
  assert.match(cornerLabels(tirol, 'utm').sw, /^32T \d{6} \d{7}$/);
  assert.match(cornerLabels(tirol, 'dms').ne, /^N 47° 19' 12\.0" E 011° 30' 00\.0"$/);
});
