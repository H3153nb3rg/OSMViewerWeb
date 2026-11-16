// Map interaction: selecting, moving, inserting and deleting points; drawing
// waypoints and routes. Works on the store; the map view only reports gestures.
import { state, mutate, changed, select, setTool, findItem, fileById, workFile } from './store.js';
import { transferSelected, zoomToSelection, setNavPoint, clearMarker } from './actions.js';
import { newId, pointCount } from '../core/gpx.js';
import { formatCoordinate } from '../core/coords.js';
import { splitSegmentAt } from '../core/ops.js';
import { timeMs, isoTime } from '../core/time.js';
import { haversine } from '../core/geo.js';
import { formatDistance } from '../core/stats.js';
import { contextMenu, toast } from './dom.js';

const VERTEX_R = 9, WPT_R = 13, LINE_R = 7;
let drag = null;

const segsOf = (item) => (item.segments ? item.segments.map((s) => s.points) : [item.points]);

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

/** What is under screen position (x, y)? Vertex of the selected line > waypoint > line. */
export function hitTest(tf, x, y, { lines = true } = {}) {
  const doc = state.doc, sel = state.selection, hidden = state.hidden;
  const vis = state.active.visible !== false;
  if (sel && sel.type !== 'waypoint' && vis) {
    const f = findItem(sel);
    if (f && !hidden.has(f.item.id)) {
      let best = null;
      segsOf(f.item).forEach((pts, si) => pts.forEach((p, pi) => {
        const d = Math.hypot(tf.x(p.lon) - x, tf.y(p.lat) - y);
        if (d < VERTEX_R && (!best || d < best.d)) best = { kind: 'vertex', type: sel.type, id: sel.id, segIndex: si, pointIndex: pi, d };
      }));
      if (best) return best;
    }
  }
  const own = vis ? scanDoc(tf, x, y, doc, { lines, sel }) : null;
  if (own) return own;
  // nothing in the active file: other open files that are shown for comparison
  for (const f of state.files) {
    if (f.id === state.activeId || !f.visible) continue;
    const hit = scanDoc(tf, x, y, f.doc, { lines, sel: null });
    if (hit) return { ...hit, fileId: f.id };
  }
  return null;
}

function scanDoc(tf, x, y, doc, { lines, sel }) {
  const hidden = state.hidden;
  let bestW = null;
  for (const w of doc.waypoints) {
    if (hidden.has(w.id)) continue;
    const wx = tf.x(w.lon), wy = tf.y(w.lat);
    const d = Math.min(Math.hypot(wx - x, wy - 13 - y), Math.hypot(wx - x, wy - y) + 4);
    if (d < WPT_R && (!bestW || d < bestW.d)) bestW = { kind: 'waypoint', type: 'waypoint', id: w.id, d };
  }
  if (bestW) return bestW;
  if (!lines) return null;
  let best = null;
  const scan = (type, items) => items.forEach((item) => {
    if (hidden.has(item.id)) return;
    segsOf(item).forEach((pts, si) => {
      let ax = NaN, ay = NaN;
      for (let i = 0; i < pts.length; i++) {
        const bx = tf.x(pts[i].lon), by = tf.y(pts[i].lat);
        if (i > 0 && !((ax < x - LINE_R && bx < x - LINE_R) || (ax > x + LINE_R && bx > x + LINE_R) || (ay < y - LINE_R && by < y - LINE_R) || (ay > y + LINE_R && by > y + LINE_R))) {
          const r = distToSeg(x, y, ax, ay, bx, by);
          const bonus = sel && sel.id === item.id ? 2 : 0; // prefer the already selected line
          if (r.d < LINE_R && (!best || r.d - bonus < best.d)) best = { kind: 'line', type, id: item.id, segIndex: si, afterIndex: i - 1, t: r.t, d: r.d - bonus };
        }
        ax = bx; ay = by;
      }
    });
  });
  scan('route', doc.routes); scan('track', doc.tracks);
  return best;
}

const totalPoints = () => state.doc.tracks.reduce((n, t) => n + pointCount(t), 0) + state.doc.routes.reduce((n, r) => n + r.points.length, 0);

export function pointerDown(map, e, x, y) {
  if (state.tool !== 'select') return false;
  const hit = hitTest(map.transform, x, y, { lines: false });
  if (!hit) return false;
  if (hit.fileId) { select({ type: 'waypoint', id: hit.id }, hit.fileId); drag = null; return true; } // other file: select only
  if (hit.kind === 'vertex') select({ type: hit.type, id: hit.id, segIndex: hit.segIndex, pointIndex: hit.pointIndex });
  else select({ type: 'waypoint', id: hit.id });
  drag = { hit, started: false };
  return true;
}

function dragTarget() {
  const f = findItem();
  if (!f) return null;
  if (drag.hit.kind === 'waypoint') return f.item;
  return segsOf(f.item)[drag.hit.segIndex][drag.hit.pointIndex];
}

export function pointerMove(map, e, x, y) {
  if (!drag) return;
  if (!drag.started) { mutate(drag.hit.kind === 'waypoint' ? 'Wegpunkt verschieben' : 'Punkt verschieben', () => {}); drag.started = true; }
  const target = dragTarget();
  if (!target) return;
  const pos = map.transform.toLatLon(x, y);
  target.lat = pos.lat; target.lon = pos.lon;
  map.requestRender();
}

export function pointerUp() {
  if (drag && drag.started) changed();
  drag = null;
}

function addWaypoint(pos, name) {
  const id = newId('w');
  mutate('Wegpunkt hinzufügen', (doc) => doc.waypoints.push({ id, lat: pos.lat, lon: pos.lon, name: name || `WP${String(doc.waypoints.length + 1).padStart(3, '0')}` }));
  select({ type: 'waypoint', id });
}
export { addWaypoint };

/**
 * Called when the route tool is switched on: continue the selected route, or
 * create a new (still empty) one right away so it shows up in the list.
 */
export function startRoute() {
  if (state.selection && state.selection.type === 'route' && findItem()) return findItem();
  const id = newId('r');
  mutate('Route anlegen', (doc) => doc.routes.push({ id, name: `Route ${doc.routes.length + 1}`, points: [] }));
  select({ type: 'route', id });
  return findItem();
}

/** Called when the route tool is left: routes that never got a point disappear again. */
export function discardEmptyRoutes() {
  const doc = state.doc, empty = doc.routes.filter((r) => !r.points.length);
  if (!empty.length) return;
  doc.routes = doc.routes.filter((r) => r.points.length);
  const top = state.undoStack[state.undoStack.length - 1];
  if (top && top.label === 'Route anlegen') state.undoStack.pop(); // creating and discarding cancel out
  if (state.selection && empty.some((r) => r.id === state.selection.id)) select(null);
  changed(false);
}

/** What the next click would create — drawn by the overlay while a tool is active. */
export function ghost() {
  if (state.tool === 'select' || !state.cursor) return null;
  if (state.tool === 'waypoint') return { kind: 'waypoint', cursor: state.cursor };
  const f = state.selection && state.selection.type === 'route' ? findItem() : null;
  const pts = f ? f.item.points : [];
  const from = pts[pts.length - 1];
  return { kind: 'route', cursor: state.cursor, from, label: from ? formatDistance(haversine(from, state.cursor)) : 'Startpunkt setzen' };
}

function appendRoutePoint(pos) {
  const f = startRoute();
  mutate('Routenpunkt hinzufügen', () => f.item.points.push({ lat: pos.lat, lon: pos.lon }));
  // re-resolve: mutate() does not replace objects, the item reference stays valid
  select({ type: 'route', id: f.item.id, pointIndex: f.item.points.length - 1 });
}

/** Is (x, y) on the search marker's pin? */
export function markerHit(tf, x, y) {
  const m = state.marker; if (!m) return false;
  const mx = tf.x(m.lon), my = tf.y(m.lat);
  return Math.min(Math.hypot(mx - x, my - 13 - y), Math.hypot(mx - x, my - y) + 4) < WPT_R;
}

/** Entries for the search marker: it is a temporary mark, so it can be adopted, used or removed. */
function markerItems() {
  const m = state.marker, point = { lat: m.lat, lon: m.lon, name: m.label };
  return [
    { label: 'Suchmarker entfernen', action: clearMarker },
    { label: 'Als Wegpunkt übernehmen', action: () => { addWaypoint(point, m.label); clearMarker(); } },
    '-',
    { label: 'Route von hier (Start)', action: () => setNavPoint('start', point) },
    { label: 'Route hierher (Ziel)', action: () => setNavPoint('end', point) },
  ];
}

export function click(map, e, x, y, captured) {
  const pos = map.transform.toLatLon(x, y);
  if (state.tool === 'waypoint') { addWaypoint(pos); return; }
  if (state.tool === 'route') { appendRoutePoint(pos); return; }
  if (captured) return; // vertex/waypoint was selected on pointer down
  if (markerHit(map.transform, x, y)) { contextMenu(e.clientX, e.clientY, markerItems()); return; }
  const hit = hitTest(map.transform, x, y);
  if (hit && hit.kind === 'line') select({ type: hit.type, id: hit.id, segIndex: hit.segIndex }, hit.fileId);
  else if (!hit) select(null);
}

function interpolate(a, b, t, pos) {
  const p = { lat: pos.lat, lon: pos.lon };
  if (Number.isFinite(a.ele) && Number.isFinite(b.ele)) p.ele = a.ele + (b.ele - a.ele) * t;
  const ta = timeMs(a), tb = timeMs(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) p.time = isoTime(ta + (tb - ta) * t);
  return p;
}

export function insertPoint(hit, pos) {
  const f = findItem({ type: hit.type, id: hit.id });
  if (!f) return;
  mutate('Punkt einfügen', () => {
    const pts = segsOf(f.item)[hit.segIndex];
    pts.splice(hit.afterIndex + 1, 0, interpolate(pts[hit.afterIndex], pts[hit.afterIndex + 1], hit.t, pos));
  });
  select({ type: hit.type, id: hit.id, segIndex: hit.segIndex, pointIndex: hit.afterIndex + 1 });
}

export function dblClick(map, e, x, y) {
  if (state.tool === 'route') { // the two clicks of the double click added the same spot twice
    const f = findItem();
    if (f && f.type === 'route' && f.item.points.length > 1) {
      const pts = f.item.points, a = pts[pts.length - 1], b = pts[pts.length - 2], tf = map.transform;
      if (Math.hypot(tf.x(a.lon) - tf.x(b.lon), tf.y(a.lat) - tf.y(b.lat)) < 6) { pts.pop(); state.undoStack.pop(); changed(); }
    }
    setTool('select');
    return true;
  }
  if (state.tool !== 'select') return true;
  const hit = hitTest(map.transform, x, y);
  if (hit && !hit.fileId && hit.kind === 'line' && state.selection && state.selection.id === hit.id) { insertPoint(hit, map.transform.toLatLon(x, y)); return true; }
  return false;
}

/** Delete the selected vertex, or the whole selected item when no vertex is selected. */
export function deleteSelection() {
  const sel = state.selection, f = findItem();
  if (!f) return;
  if (sel.type !== 'waypoint' && Number.isInteger(sel.pointIndex)) {
    mutate('Punkt löschen', (doc) => {
      if (sel.type === 'route') {
        f.item.points.splice(sel.pointIndex, 1);
        if (!f.item.points.length) doc.routes.splice(f.index, 1);
      } else {
        const seg = f.item.segments[sel.segIndex || 0];
        seg.points.splice(sel.pointIndex, 1);
        if (!seg.points.length) f.item.segments.splice(sel.segIndex || 0, 1);
        if (!f.item.segments.length) doc.tracks.splice(f.index, 1);
      }
    });
    const still = findItem();
    const pts = still && (sel.type === 'route' ? still.item.points : (still.item.segments[sel.segIndex || 0] || {}).points);
    select(still && pts && pts.length ? { ...sel, pointIndex: Math.min(sel.pointIndex, pts.length - 1) } : still ? { type: sel.type, id: sel.id } : null);
    return;
  }
  mutate('Löschen', () => f.list.splice(f.index, 1));
  select(null);
}

export function showContextMenu(map, e, x, y) {
  const tf = map.transform, pos = tf.toLatLon(x, y);
  if (markerHit(tf, x, y)) { contextMenu(e.clientX, e.clientY, markerItems()); return; }
  const hit = hitTest(tf, x, y);
  const items = [];
  let navPoint = { lat: pos.lat, lon: pos.lon };
  if (hit && hit.kind === 'waypoint') { const w = (hit.fileId ? fileById(hit.fileId).doc : state.doc).waypoints.find((p) => p.id === hit.id); if (w) navPoint = { lat: w.lat, lon: w.lon, name: w.name }; }
  if (hit && hit.fileId) { // item of another open file
    const file = fileById(hit.fileId), target = workFile();
    select({ type: hit.type, id: hit.id }, hit.fileId);
    if (target && target.id !== hit.fileId) items.push({ label: `Nach „${target.name}“ übernehmen`, action: () => transferSelected(target.id) });
    items.push({ label: `Zeigen (in „${file.name}“)`, action: zoomToSelection }, '-');
  } else if (hit && hit.kind === 'vertex') {
    select({ type: hit.type, id: hit.id, segIndex: hit.segIndex, pointIndex: hit.pointIndex });
    items.push({ label: 'Punkt löschen', action: deleteSelection });
    if (hit.type === 'track') items.push({ label: 'Track hier teilen', action: () => {
      const f = findItem();
      mutate('Track teilen', (doc) => { doc.tracks[f.index] = splitSegmentAt(f.item, hit.segIndex, hit.pointIndex); });
      select({ type: 'track', id: hit.id });
    } });
    items.push('-');
  } else if (hit && hit.kind === 'line') {
    select({ type: hit.type, id: hit.id, segIndex: hit.segIndex });
    items.push({ label: 'Punkt hier einfügen', action: () => insertPoint(hit, pos) }, '-');
  } else if (hit && hit.kind === 'waypoint') {
    select({ type: 'waypoint', id: hit.id });
    items.push({ label: 'Wegpunkt löschen', action: deleteSelection }, '-');
  }
  items.push(
    { label: 'Route von hier (Start)', action: () => setNavPoint('start', navPoint) },
    { label: 'Route hierher (Ziel)', action: () => setNavPoint('end', navPoint) },
    '-',
    { label: 'Wegpunkt hier setzen', action: () => addWaypoint(pos) },
    { label: 'Koordinaten kopieren', action: async () => {
      const text = formatCoordinate(pos.lat, pos.lon, state.settings.coordFormat);
      try { await navigator.clipboard.writeText(text); toast('Kopiert: ' + text); } catch { toast(text, 'info', 8000); }
    } },
    { label: 'Karte hier zentrieren', action: () => map.setView(pos) },
  );
  contextMenu(e.clientX, e.clientY, items);
}

/** Cursor feedback; line hit tests are skipped for very large documents. */
export function hoverCursor(map, x, y) {
  if (state.tool !== 'select') return 'crosshair';
  if (markerHit(map.transform, x, y)) return 'pointer';
  const hit = hitTest(map.transform, x, y, { lines: totalPoints() < 60000 });
  return !hit ? 'grab' : hit.kind === 'line' ? 'pointer' : 'move';
}
