// Track optimisation (point reduction) with Ramer-Douglas-Peucker.
//
// Instead of running RDP once per tolerance, every point gets a *weight*: the
// largest epsilon (metres) at which RDP still keeps it. One O(n log n) pass
// then answers every question — "tolerance 15 m", "keep 30 %", "exactly 500
// points" (the slider of the old Java TrackOptimizerDialog) — by thresholding.
//
// Modes mirror tools/gpx_optimizer_relative.py of the legacy project:
//   level       1..10, epsilon = LEVEL_MULTIPLIERS[level] * median step of the segment
//   multiplier  epsilon = value * median step
//   tolerance   absolute epsilon in metres
//   percent     keep value % of the points of each segment
//   count       keep value points in total (distributed by importance over all segments)

import { haversine, rad, EARTH_RADIUS } from './geo.js';

export const LEVEL_MULTIPLIERS = { 1: 0.5, 2: 1.0, 3: 1.5, 4: 2.5, 5: 4.0, 6: 7.0, 7: 12.0, 8: 18.0, 9: 24.0, 10: 30.0 };
export const DEFAULT_LEVEL = 3;

/** Local equirectangular projection (metres) around the segment's mean latitude. */
function toLocalXY(points) {
  const n = points.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  let lat0 = 0, lon0 = points[0].lon;
  for (const p of points) lat0 += p.lat;
  lat0 /= n;
  const kx = EARTH_RADIUS * Math.cos(rad(lat0)) * Math.PI / 180, ky = EARTH_RADIUS * Math.PI / 180;
  for (let i = 0; i < n; i++) {
    let dl = points[i].lon - lon0;
    if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    xs[i] = dl * kx; ys[i] = (points[i].lat - lat0) * ky;
  }
  return { xs, ys };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * RDP importance per point: point i survives RDP(epsilon) iff weights[i] > epsilon.
 * First and last point get Infinity.
 */
export function rdpWeights(points) {
  const n = points.length;
  const w = new Float64Array(n);
  if (n === 0) return w;
  w[0] = Infinity; w[n - 1] = Infinity;
  if (n < 3) return w;
  const { xs, ys } = toLocalXY(points);
  const stack = [[0, n - 1, Infinity]];
  while (stack.length) {
    const [s, e, parent] = stack.pop();
    if (e - s < 2) continue;
    let maxD = -1, idx = -1;
    const mid = (s + e) / 2;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(xs[i], ys[i], xs[s], ys[s], xs[e], ys[e]);
      // on ties prefer the most central point -> balanced recursion on straight lines
      if (d > maxD || (d === maxD && Math.abs(i - mid) < Math.abs(idx - mid))) { maxD = d; idx = i; }
    }
    if (maxD <= 1e-9) continue; // everything in between is collinear: weight 0
    const weight = Math.min(maxD, parent);
    w[idx] = weight;
    stack.push([s, idx, weight], [idx, e, weight]);
  }
  return w;
}

/** Median point-to-point distance (metres) = recording resolution; floor 1 m. */
export function medianStep(points) {
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);
    if (d > 0.001) steps.push(d);
  }
  if (!steps.length) return 1;
  steps.sort((a, b) => a - b);
  const m = steps.length >> 1;
  return Math.max(1, steps.length % 2 ? steps[m] : (steps[m - 1] + steps[m]) / 2);
}

/** Smallest threshold such that exactly `count` points (incl. both ends) remain. */
function maskForCount(weights, count) {
  const n = weights.length;
  const keep = new Array(n).fill(false);
  const order = [];
  for (let i = 0; i < n; i++) { if (weights[i] === Infinity) keep[i] = true; else order.push(i); }
  let free = Math.max(0, count - (n - order.length));
  order.sort((a, b) => weights[b] - weights[a] || a - b);
  for (let k = 0; k < order.length && free > 0; k++, free--) keep[order[k]] = true;
  return keep;
}

function epsilonFor(points, mode, value) {
  switch (mode) {
    case 'tolerance': return Math.max(0, value);
    case 'multiplier': return Math.max(0, value) * medianStep(points);
    case 'level': default: {
      const lvl = Math.min(10, Math.max(1, Math.round(value ?? DEFAULT_LEVEL)));
      return LEVEL_MULTIPLIERS[lvl] * medianStep(points);
    }
  }
}

/**
 * Simplify one segment's point array.
 * @returns {{points: object[], epsilon: number|null, before: number, after: number}}
 */
export function simplifyPoints(points, { mode = 'level', value = DEFAULT_LEVEL } = {}, weights = null) {
  const n = points.length;
  if (n < 3) return { points: points.slice(), epsilon: null, before: n, after: n };
  const w = weights || rdpWeights(points);
  let keep, epsilon = null;
  if (mode === 'percent' || mode === 'count') {
    const target = mode === 'percent' ? Math.max(2, Math.round((n * Math.min(100, Math.max(0, value))) / 100)) : Math.max(2, Math.round(value));
    keep = maskForCount(w, target);
  } else {
    epsilon = epsilonFor(points, mode, value);
    keep = Array.from(w, (x) => x > epsilon);
  }
  const out = points.filter((_, i) => keep[i]);
  return { points: out, epsilon, before: n, after: out.length };
}

/** Pre-compute weights for all segments of a track (for live slider previews). */
export const trackWeights = (track) => track.segments.map((s) => rdpWeights(s.points));

/**
 * Simplify a whole track (per segment). Returns a new track object; points are shared, not copied.
 * For mode 'count' the budget is distributed over all segments by importance.
 */
export function simplifyTrack(track, opts = {}, weights = null) {
  const ws = weights || trackWeights(track);
  const stats = [];
  let segments;
  if (opts.mode === 'count') {
    const flat = [];
    track.segments.forEach((s, si) => s.points.forEach((_, pi) => flat.push(ws[si][pi])));
    const keep = maskForCount(flat, Math.max(0, Math.round(opts.value)));
    let k = 0;
    segments = track.segments.map((s) => {
      const points = s.points.filter(() => keep[k++]);
      stats.push({ before: s.points.length, after: points.length, epsilon: null });
      return { ...s, points };
    });
  } else {
    segments = track.segments.map((s, i) => {
      const r = simplifyPoints(s.points, opts, ws[i]);
      stats.push({ before: r.before, after: r.after, epsilon: r.epsilon });
      return { ...s, points: r.points };
    });
  }
  const before = stats.reduce((a, s) => a + s.before, 0), after = stats.reduce((a, s) => a + s.after, 0);
  return { track: { ...track, segments }, stats, before, after };
}

/** Minimum number of points a track can be reduced to (two per non-trivial segment). */
export const minPointCount = (track) => track.segments.reduce((n, s) => n + Math.min(2, s.points.length), 0);
