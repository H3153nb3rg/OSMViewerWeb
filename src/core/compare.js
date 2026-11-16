// Compare a document (e.g. a file opened "zum Vergleich") against the working
// document: which waypoints, routes and tracks are new, partly covered,
// already contained, or identical? Used to judge whether adopting data is
// worthwhile before anything is changed.
//
// Lines are compared geometrically: both sides are resampled every tol/2
// metres; a sample counts as covered when the other geometry lies within
// `tolerance` metres. Coverage is the covered share of the item's length.

import { haversine, rad } from './geo.js';
import { itemPoints } from './gpx.js';

const M_PER_DEG = 111320;

/** Spatial hash of points (cell size = tolerance). */
class PointGrid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(cx, cy) { return cx * 1e7 + cy; }
  coords(p) { return [Math.floor((p.lon * M_PER_DEG * Math.cos(rad(p.lat))) / this.cell), Math.floor((p.lat * M_PER_DEG) / this.cell)]; }
  add(p) { const [cx, cy] = this.coords(p); const k = this.key(cx, cy); const b = this.map.get(k); if (b) b.push(p); else this.map.set(k, [p]); }
  /** Nearest stored point within maxDist, or null. */
  nearest(p, maxDist) {
    const [cx, cy] = this.coords(p);
    const r = Math.ceil(maxDist / this.cell);
    let best = null, bestD = maxDist;
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      const b = this.map.get(this.key(cx + dx, cy + dy));
      if (!b) continue;
      for (const q of b) { const d = haversine(p, q); if (d <= bestD) { bestD = d; best = q; } }
    }
    return best;
  }
}

/** Points along a polyline every `step` metres (vertices included). */
export function resample(points, step) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = haversine(a, b);
    const n = Math.floor(d / step);
    for (let k = 1; k <= n; k++) {
      const t = (k * step) / d;
      if (t < 1) out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
    out.push(b);
  }
  return out;
}

const segmentsOf = (item) => (item.segments ? item.segments.map((s) => s.points) : [item.points]);

function sameGeometry(a, b) {
  const pa = itemPoints(a), pb = itemPoints(b);
  if (pa.length !== pb.length || !pa.length) return false;
  return pa.every((p, i) => Math.abs(p.lat - pb[i].lat) < 1e-7 && Math.abs(p.lon - pb[i].lon) < 1e-7);
}

/**
 * @param {object} doc     document to judge (source of a possible transfer)
 * @param {object} target  working document
 * @param {object} [opts]  tolerance (m, lines), waypointTolerance (m)
 * @returns {Map<string, {status: 'neu'|'teilweise'|'enthalten'|'identisch', coverage?: number, match?: string}>}
 *          keyed by item id; `match` is the id of the corresponding target item where known
 */
export function compareDocs(doc, target, { tolerance = 30, waypointTolerance = 25 } = {}) {
  const result = new Map();
  const step = tolerance / 2;

  // target geometry: all line samples plus all waypoints
  const lineGrid = new PointGrid(tolerance), wptGrid = new PointGrid(waypointTolerance);
  const owner = new Map();
  for (const item of [...target.routes, ...target.tracks]) {
    for (const seg of segmentsOf(item)) for (const p of resample(seg, step)) { lineGrid.add(p); owner.set(p, item.id); }
  }
  for (const w of target.waypoints) wptGrid.add(w);
  const wptById = new Map(target.waypoints.map((w) => [w, w.id]));

  for (const w of doc.waypoints) {
    const near = wptGrid.nearest(w, waypointTolerance);
    if (!near) { result.set(w.id, { status: 'neu' }); continue; }
    const same = haversine(near, w) < 1 && (near.name || '') === (w.name || '') && (Number.isFinite(near.ele) ? Math.round(near.ele) : null) === (Number.isFinite(w.ele) ? Math.round(w.ele) : null);
    result.set(w.id, { status: same ? 'identisch' : 'enthalten', match: wptById.get(near) });
  }

  const targetLines = [...target.routes, ...target.tracks];
  for (const item of [...doc.routes, ...doc.tracks]) {
    const twin = targetLines.find((t) => sameGeometry(item, t));
    if (twin) { result.set(item.id, { status: 'identisch', coverage: 1, match: twin.id }); continue; }
    let total = 0, covered = 0;
    const votes = new Map();
    for (const seg of segmentsOf(item)) {
      const samples = resample(seg, step);
      for (let i = 0; i < samples.length; i++) {
        // weight each sample with the length it represents
        const w = (i > 0 ? haversine(samples[i - 1], samples[i]) / 2 : 0) + (i < samples.length - 1 ? haversine(samples[i], samples[i + 1]) / 2 : 0);
        total += w;
        const hit = lineGrid.nearest(samples[i], tolerance);
        if (hit) { covered += w; const id = owner.get(hit); votes.set(id, (votes.get(id) || 0) + w); }
      }
    }
    if (total === 0) { // single point line
      const p = itemPoints(item)[0];
      const hit = p && lineGrid.nearest(p, tolerance);
      result.set(item.id, hit ? { status: 'enthalten', coverage: 1, match: owner.get(hit) } : { status: 'neu', coverage: 0 });
      continue;
    }
    const coverage = covered / total;
    const match = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    result.set(item.id, { status: coverage >= 0.95 ? 'enthalten' : coverage >= 0.05 ? 'teilweise' : 'neu', coverage, ...(match ? { match: match[0] } : {}) });
  }
  return result;
}

/** Counts per status, for a one-line summary. */
export function summarize(results) {
  const s = { neu: 0, teilweise: 0, enthalten: 0, identisch: 0 };
  for (const r of results.values()) s[r.status]++;
  return s;
}

