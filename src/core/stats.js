// Statistics and elevation profile data for point sequences.
import { haversine } from './geo.js';
import { timeMs } from './time.js';

/** Cumulative distance (metres) per point. */
export function cumulativeDistance(points) {
  const d = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) d[i] = d[i - 1] + haversine(points[i - 1], points[i]);
  return d;
}

/**
 * Ascent/descent with hysteresis: elevation changes only count once they exceed
 * `threshold` metres from the last accepted level (suppresses GPS/DEM noise).
 */
export function ascentDescent(points, threshold = 5) {
  let up = 0, down = 0, ref;
  for (const p of points) {
    if (!Number.isFinite(p.ele)) continue;
    if (ref === undefined) { ref = p.ele; continue; }
    const d = p.ele - ref;
    if (d >= threshold) { up += d; ref = p.ele; }
    else if (d <= -threshold) { down -= d; ref = p.ele; }
  }
  return { ascent: up, descent: down };
}

/** Statistics for one or more segments (arrays of points). Gaps between segments are not counted. */
export function computeStats(segments, { movingKmh = 1 } = {}) {
  let distance = 0, count = 0, minEle = Infinity, maxEle = -Infinity, ascent = 0, descent = 0;
  let start, end, movingMs = 0, hasEle = false;
  for (const pts of segments) {
    count += pts.length;
    const ad = ascentDescent(pts); ascent += ad.ascent; descent += ad.descent;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (Number.isFinite(p.ele)) { hasEle = true; if (p.ele < minEle) minEle = p.ele; if (p.ele > maxEle) maxEle = p.ele; }
      const t = timeMs(p);
      if (Number.isFinite(t)) { if (start === undefined || t < start) start = t; if (end === undefined || t > end) end = t; }
      if (i > 0) {
        const d = haversine(pts[i - 1], p);
        distance += d;
        const t0 = timeMs(pts[i - 1]);
        const dt = t - t0;
        if (Number.isFinite(dt) && dt > 0 && (d / dt) * 3600 >= movingKmh) movingMs += dt;
      }
    }
  }
  const durationMs = start !== undefined ? end - start : undefined;
  return {
    count, distance,
    ...(hasEle ? { minEle, maxEle, ascent, descent } : {}),
    ...(durationMs !== undefined ? { start, end, durationMs, movingMs,
      avgKmh: durationMs > 0 ? (distance / durationMs) * 3600 : undefined,
      movingKmh: movingMs > 0 ? (distance / movingMs) * 3600 : undefined } : {}),
  };
}

export function formatDistance(m) {
  if (!Number.isFinite(m)) return '–';
  return m >= 1000 ? (m / 1000).toFixed(m >= 100000 ? 0 : m >= 10000 ? 1 : 2).replace('.', ',') + ' km' : Math.round(m) + ' m';
}
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(s % 60).padStart(2, '0')} s`;
}
