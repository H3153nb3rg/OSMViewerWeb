// Document-level editing operations. All functions are pure: they return new
// objects and never mutate their arguments (the UI relies on that for undo).
import { newId, newDoc, trackPoints } from './gpx.js';
import { simplifyPoints } from './simplify.js';
import { haversine } from './geo.js';

const clonePt = (p) => ({ ...p, ...(p.extra ? { extra: p.extra.slice() } : {}) });
const bare = (p) => { const q = { lat: p.lat, lon: p.lon }; if (Number.isFinite(p.ele)) q.ele = p.ele; return q; };

/** Merge `src` into `dst` (GPX merge). Optionally skip waypoints that already exist (same name within 1 m). */
export function mergeDocs(dst, src, { dedupeWaypoints = true } = {}) {
  const out = { ...dst, metadata: { ...src.metadata, ...dst.metadata }, ns: { ...src.ns, ...dst.ns } };
  const wpts = dst.waypoints.slice();
  for (const w of src.waypoints) {
    const dup = dedupeWaypoints && wpts.some((x) => (x.name || '') === (w.name || '') && haversine(x, w) < 1);
    if (!dup) wpts.push({ ...clonePt(w), id: newId('w') });
  }
  out.waypoints = wpts;
  out.routes = [...dst.routes, ...src.routes.map((r) => ({ ...r, id: newId('r') }))];
  out.tracks = [...dst.tracks, ...src.tracks.map((t) => ({ ...t, id: newId('t') }))];
  out.extra = [...(dst.extra || []), ...(src.extra || [])];
  return out;
}

/** New document containing only the given items (by id) — "export selection". */
export function extractItems(doc, ids) {
  const set = new Set(ids);
  const out = newDoc();
  out.metadata = { ...doc.metadata }; out.ns = { ...doc.ns };
  out.waypoints = doc.waypoints.filter((w) => set.has(w.id));
  out.routes = doc.routes.filter((r) => set.has(r.id));
  out.tracks = doc.tracks.filter((t) => set.has(t.id));
  return out;
}

export function reverseRoute(route) { return { ...route, points: route.points.slice().reverse() }; }

/** Reverse a track. Timestamps would run backwards and are therefore removed. */
export function reverseTrack(track) {
  return { ...track, segments: track.segments.slice().reverse().map((s) => ({ ...s,
    points: s.points.slice().reverse().map((p) => { const q = clonePt(p); delete q.time; return q; }) })) };
}

/** Track -> route with at most maxPoints route points (shape-preserving reduction). */
export function trackToRoute(track, maxPoints = 50) {
  const all = trackPoints(track);
  const { points } = simplifyPoints(all, { mode: 'count', value: Math.max(2, maxPoints) });
  return { id: newId('r'), name: track.name, desc: track.desc, color: track.color,
    points: points.map((p, i) => ({ ...bare(p), name: p.name || String(i + 1).padStart(3, '0') })) };
}

export function routeToTrack(route) {
  return { id: newId('t'), name: route.name, desc: route.desc, color: route.color, segments: [{ points: route.points.map(bare) }] };
}

/** Join all segments of a track into one. */
export function joinSegments(track) {
  return { ...track, segments: [{ points: track.segments.flatMap((s) => s.points) }] };
}

/** Split a segment in two at pointIndex (the point ends the first and starts the second part). */
export function splitSegmentAt(track, segIndex, pointIndex) {
  const seg = track.segments[segIndex];
  if (!seg || pointIndex <= 0 || pointIndex >= seg.points.length - 1) return track;
  const a = { ...seg, points: seg.points.slice(0, pointIndex + 1) };
  const b = { points: seg.points.slice(pointIndex).map((p, i) => (i === 0 ? clonePt(p) : p)) };
  return { ...track, segments: [...track.segments.slice(0, segIndex), a, b, ...track.segments.slice(segIndex + 1)] };
}

/** Turn every segment into a track of its own. */
export function segmentsToTracks(track) {
  return track.segments.map((s, i) => ({ ...track, id: newId('t'),
    name: `${track.name || 'Track'}${track.segments.length > 1 ? ' #' + (i + 1) : ''}`, segments: [s] }));
}

/** Concatenate several tracks into one (segments kept). */
export function mergeTracks(tracks) {
  const [first] = tracks;
  return { ...first, id: newId('t'), segments: tracks.flatMap((t) => t.segments) };
}

/** Index of the point nearest to {lat, lon}: {segIndex, pointIndex, distance}. */
export function nearestPoint(item, pos) {
  let best = { segIndex: 0, pointIndex: -1, distance: Infinity };
  const segs = item.segments ? item.segments.map((s) => s.points) : [item.points];
  segs.forEach((pts, si) => pts.forEach((p, pi) => {
    const d = haversine(p, pos);
    if (d < best.distance) best = { segIndex: si, pointIndex: pi, distance: d };
  }));
  return best;
}

const pathLen = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]); return d; };
const linePoints = (item) => (item.segments ? item.segments.flatMap((s) => s.points) : item.points);

/**
 * Does `doc` already contain something equivalent to `item`?
 * Waypoints: within 15 m (or 150 m with the same name). Routes/tracks: both ends
 * within 30 m and the length within 2 % (direction-independent).
 */
export function findEquivalent(doc, item, type) {
  if (type === 'waypoint') {
    return doc.waypoints.find((w) => { const d = haversine(w, item); return d < 15 || (d < 150 && !!w.name && w.name === item.name); }) || null;
  }
  const a = linePoints(item);
  if (!a.length) return null;
  const la = pathLen(a), a0 = a[0], a1 = a[a.length - 1];
  const same = (other) => {
    const b = linePoints(other);
    if (!b.length) return false;
    const b0 = b[0], b1 = b[b.length - 1];
    const ends = (haversine(a0, b0) < 30 && haversine(a1, b1) < 30) || (haversine(a0, b1) < 30 && haversine(a1, b0) < 30);
    return ends && Math.abs(pathLen(b) - la) <= Math.max(20, 0.02 * la);
  };
  return [...doc.routes, ...doc.tracks].find(same) || null;
}

/**
 * Copy or move items (by id) from one document to another.
 * Copies get fresh ids and — if they have none — a <src> naming the file they came from.
 * @returns {{src: object, dst: object, newIds: string[]}} new documents; arguments stay untouched
 */
export function transferItems(src, dst, ids, { move = false, sourceName = '' } = {}) {
  const set = new Set(ids), newIds = [];
  const out = { ...dst, waypoints: dst.waypoints.slice(), routes: dst.routes.slice(), tracks: dst.tracks.slice(), ns: { ...src.ns, ...dst.ns } };
  const take = (list, target, prefix) => list.filter((x) => set.has(x.id)).forEach((x) => {
    const copy = structuredClone(x);
    copy.id = newId(prefix); newIds.push(copy.id);
    if (sourceName && !copy.src) copy.src = sourceName;
    target.push(copy);
  });
  take(src.waypoints, out.waypoints, 'w'); take(src.routes, out.routes, 'r'); take(src.tracks, out.tracks, 't');
  const rest = move ? { ...src, waypoints: src.waypoints.filter((x) => !set.has(x.id)), routes: src.routes.filter((x) => !set.has(x.id)), tracks: src.tracks.filter((x) => !set.has(x.id)) } : src;
  return { src: rest, dst: out, newIds };
}
