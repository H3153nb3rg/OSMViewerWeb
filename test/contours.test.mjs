import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contourLines, contourInterval, geoContours } from '../src/core/contours.js';

const grid = (cols, rows, fn) => ({ cols, rows, data: Array.from({ length: cols * rows }, (_, i) => fn(i % cols, Math.floor(i / cols))) });

test('contours: a cone gives closed circles at the right radius', () => {
  const n = 81, c = 40;
  const g = grid(n, n, (x, y) => 1000 - 20 * Math.hypot(x - c, y - c)); // 20 m per cell
  const res = contourLines(g, [400, 600, 800]);
  assert.equal(res.length, 3);
  for (const { level, lines } of res) {
    assert.equal(lines.length, 1, 'one ring per level');
    const ring = lines[0], r = (1000 - level) / 20;
    assert.deepEqual(ring[0], ring.at(-1), 'closed');
    for (const [x, y] of ring) assert.ok(Math.abs(Math.hypot(x - c, y - c) - r) < 0.12, `level ${level}: radius ${Math.hypot(x - c, y - c)} vs ${r}`);
    assert.ok(ring.length > 6 * r, 'continuous');
  }
});

test('contours: plane, open lines, no-data, saddle, values on the level', () => {
  const plane = grid(11, 6, (x) => x * 10); // rises to the east
  const [c] = contourLines(plane, [35]);
  assert.equal(c.lines.length, 1); assert.equal(c.lines[0].length, 6, 'one point per row');
  assert.ok(c.lines[0].every(([x]) => Math.abs(x - 3.5) < 1e-9)); assert.deepEqual(c.lines[0].map((p) => p[1]).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.equal(contourLines(plane, [30])[0].lines[0].every(([x]) => Math.abs(x - 3) < 1e-9), true, 'level exactly on grid values');
  assert.deepEqual(contourLines(plane, [500, -5]), [], 'levels outside the relief');
  const holes = grid(11, 6, (x, y) => (y === 2 || y === 3 ? null : x * 10));
  const h = contourLines(holes, [35])[0];
  assert.equal(h.lines.length, 2, 'line is interrupted by missing data'); assert.ok(h.lines.every((l) => l.every(([x, y]) => Math.abs(x - 3.5) < 1e-9 && (y <= 1 || y >= 4))));
  const saddle = { cols: 2, rows: 2, data: [10, 0, 0, 10] };
  assert.equal(contourLines(saddle, [4])[0].lines.length, 2); assert.equal(contourLines(saddle, [6])[0].lines.length, 2);
  // two hills: two separate rings at a high level, one enclosing line lower down
  const two = grid(61, 31, (x, y) => Math.max(100 - 5 * Math.hypot(x - 15, y - 15), 100 - 5 * Math.hypot(x - 45, y - 15)));
  assert.equal(contourLines(two, [60])[0].lines.length, 2); assert.ok(contourLines(two, [60])[0].lines.every((l) => l[0][0] === l.at(-1)[0] && l[0][1] === l.at(-1)[1]));
});

test('contours: interval choice and geographic output', () => {
  assert.equal(contourInterval(500, 2400), 200); assert.equal(contourInterval(200, 420), 20); assert.equal(contourInterval(0, 9000), 1000); assert.equal(contourInterval(100, 130), 5);
  const g = { ...grid(41, 41, (x, y) => 2000 - 40 * Math.hypot(x - 20, y - 20)), south: 47, north: 47.4, west: 11, east: 11.4 };
  const r = geoContours(g);
  assert.equal(r.interval, 100); assert.ok(r.contours.length >= 8);
  assert.ok(r.contours.some((c) => c.index) && r.contours.some((c) => !c.index)); assert.ok(r.contours.filter((c) => c.index).every((c) => c.level % 500 === 0));
  for (const c of r.contours) for (const line of c.lines) for (const p of line) {
    assert.ok(p.lat >= 47 && p.lat <= 47.4 && p.lon >= 11 && p.lon <= 11.4);
    const cells = Math.hypot((p.lon - 11.2) / 0.01, (47.2 - p.lat) / 0.01);
    assert.ok(Math.abs(2000 - 40 * cells - c.level) < 6, 'point lies on its level');
  }
  assert.deepEqual(geoContours({ ...grid(3, 3, () => 5), south: 0, north: 1, west: 0, east: 1 }).contours, [], 'flat land has no contours');
  assert.equal(geoContours(g, { interval: 500 }).interval, 500);
});
