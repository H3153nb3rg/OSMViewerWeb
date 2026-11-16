// Track repair: split at recording gaps and by means of transport.
// Port of tools/gpx_repair.py of the legacy project, operating on point arrays.

import { haversine } from './geo.js';
import { timeMs } from './time.js';

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const stdev = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Drop consecutive points with identical position. */
export function removeDuplicates(points) {
  return points.filter((p, i) => i === 0 || p.lat !== points[i - 1].lat || p.lon !== points[i - 1].lon);
}

/**
 * Split where the time gap exceeds mean + sigmaFactor * stdev of all gaps.
 * Points without timestamps never trigger a split (unlike the Python tool, which
 * split at every unknown gap — that shredded tracks with partially missing times).
 */
export function splitByGaps(points, { sigmaFactor = 3, minPoints = 2 } = {}) {
  if (points.length < 2) return [points];
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push((timeMs(points[i]) - timeMs(points[i - 1])) / 1000);
  const known = gaps.filter((g) => Number.isFinite(g) && g >= 0);
  if (known.length < 2) return [points];
  const cutoff = mean(known) + sigmaFactor * stdev(known);
  const segments = [];
  let start = 0;
  gaps.forEach((g, i) => {
    if (Number.isFinite(g) && g > cutoff) {
      const seg = points.slice(start, i + 1);
      if (seg.length >= minPoints) segments.push(seg);
      start = i + 1;
    }
  });
  const last = points.slice(start);
  if (last.length >= minPoints) segments.push(last);
  return segments.length ? segments : [points];
}

/** Speed (km/h) arriving at each point; first point copies the second. */
export function speedsKmh(points) {
  const n = points.length, v = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = (timeMs(points[i]) - timeMs(points[i - 1])) / 1000;
    if (Number.isFinite(dt) && dt > 0) v[i] = (haversine(points[i - 1], points[i]) / dt) * 3.6;
  }
  if (n > 1) v[0] = v[1];
  return v;
}

export function smoothMedian(values, window = 5) {
  const half = Math.floor(window / 2);
  return values.map((_, i) => median(values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1))));
}

/** Merge runs shorter than minPoints into their neighbour (traffic lights, GPS noise). */
export function mergeShortRuns(labels, minPoints) {
  let runs = [];
  for (let i = 0; i < labels.length;) {
    let j = i + 1;
    while (j < labels.length && labels[j] === labels[i]) j++;
    runs.push([labels[i], i, j]);
    i = j;
  }
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (let idx = 0; idx < runs.length; idx++) {
      const [lbl, start, end] = runs[idx];
      if (end - start < minPoints && runs.length > 1) {
        if (next.length) next[next.length - 1][2] = end;
        else if (idx + 1 < runs.length) { runs[idx + 1][1] = start; continue; }
        changed = true;
      } else if (next.length && next[next.length - 1][0] === lbl) next[next.length - 1][2] = end; // coalesce equal neighbours
      else next.push([lbl, start, end]);
    }
    runs = next;
  }
  const out = new Array(labels.length);
  for (const [lbl, s, e] of runs) for (let k = s; k < e; k++) out[k] = lbl;
  return out;
}

/**
 * Split by means of transport (speed below threshold = "walk", above = "fast").
 * @returns {{mode: 'walk'|'fast', points: object[], avgKmh: number}[]}
 */
export function splitByMode(points, { walkKmh = 15, smoothWindow = 5, minPoints = 10 } = {}) {
  if (points.length < 2) return [{ mode: 'fast', points, avgKmh: 0 }];
  const raw = speedsKmh(points);
  const labels = mergeShortRuns(smoothMedian(raw, smoothWindow).map((s) => (s < walkKmh ? 'walk' : 'fast')), minPoints);
  const out = [];
  for (let i = 0; i < points.length;) {
    let j = i + 1;
    while (j < points.length && labels[j] === labels[i]) j++;
    out.push({ mode: labels[i], points: points.slice(i, j), avgKmh: mean(raw.slice(i, j)) });
    i = j;
  }
  return out;
}
