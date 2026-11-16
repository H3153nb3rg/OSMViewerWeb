// High-level commands shared by toolbar, sidebar and keyboard shortcuts.
import { state, mutate, select, findItem, saveSettings, emit, transfer, workFile, fileById, fileOfItem } from './store.js';
import { h, toast, openDialog, field, select as selectEl, download, confirmDialog } from './dom.js';
import { newId, itemPoints, pointCount, serializeGpx } from '../core/gpx.js';
import { bboxOf } from '../core/geo.js';
import * as ops from '../core/ops.js';
import { simplifyTrack, trackWeights, minPointCount, LEVEL_MULTIPLIERS, medianStep } from '../core/simplify.js';
import { splitByGaps, splitByMode, removeDuplicates } from '../core/repair.js';
import { formatDistance } from '../core/stats.js';
import { route as osrmRoute, PROFILES } from '../services/osrm.js';
import { lookupElevations } from '../services/elevation.js';
import { DEFAULT_SERVICES } from '../services/config.js';
import { COORD_FORMATS, parseCoordinate, formatCoordinate } from '../core/coords.js';
import { customSource } from '../core/tilesources.js';

let map = null;
export function initActions(mapView) { map = mapView; }

export function docBounds(doc = state.doc) {
  const pts = [...doc.waypoints, ...doc.routes.flatMap((r) => r.points), ...doc.tracks.flatMap((t) => itemPoints(t))];
  return bboxOf(pts);
}
export function zoomToAll() { const b = docBounds(); if (b) map.fitBounds(b); }
/** Overview of the whole selected route/track — regardless of a selected point. */
export function zoomToItem() {
  const f = findItem();
  if (!f) return zoomToAll();
  if (f.type === 'waypoint') return map.setView(f.item, Math.max(map.zoom, 14));
  const pts = itemPoints(f.item);
  if (pts.length === 1) return map.setView(pts[0], Math.max(map.zoom, 14));
  return map.fitBounds(bboxOf(pts));
}

/** The most specific thing selected: the point if one is selected, else the whole item. */
export function zoomToSelection() {
  const f = findItem();
  if (!f) return zoomToAll();
  if (f.type === 'waypoint') return map.setView(f.item, Math.max(map.zoom, 14));
  const sel = state.selection;
  if (Number.isInteger(sel.pointIndex)) {
    const pts = f.type === 'route' ? f.item.points : f.item.segments[sel.segIndex || 0].points;
    if (pts[sel.pointIndex]) return map.setView(pts[sel.pointIndex], Math.max(map.zoom, 15));
  }
  return map.fitBounds(bboxOf(itemPoints(f.item)));
}

const replaceItem = (label, fn) => { const f = findItem(); if (!f) return; mutate(label, () => { f.list[f.index] = fn(f.item); }); select({ type: f.type, id: f.item.id }); };

export function reverseSelected() {
  const f = findItem(); if (!f || f.type === 'waypoint') return;
  replaceItem('Richtung umkehren', (it) => (f.type === 'route' ? ops.reverseRoute(it) : ops.reverseTrack(it)));
  if (f.type === 'track') toast('Richtung umgekehrt – Zeitstempel wurden entfernt');
}
export function duplicateSelected() {
  const f = findItem(); if (!f) return;
  const copy = structuredClone(f.item);
  copy.id = newId(f.type[0]); copy.name = (copy.name || '') + ' (Kopie)';
  mutate('Duplizieren', () => f.list.splice(f.index + 1, 0, copy));
  select({ type: f.type, id: copy.id });
}
export function joinSelectedSegments() { replaceItem('Segmente verbinden', ops.joinSegments); }
export function segmentsToTracks() {
  const f = findItem(); if (!f || f.type !== 'track') return;
  const parts = ops.segmentsToTracks(f.item);
  mutate('Segmente trennen', () => f.list.splice(f.index, 1, ...parts));
  select({ type: 'track', id: parts[0].id });
}
export function routeToTrackSelected() {
  const f = findItem(); if (!f || f.type !== 'route') return;
  const t = ops.routeToTrack(f.item);
  mutate('Route → Track', (doc) => doc.tracks.push(t));
  select({ type: 'track', id: t.id });
}
export function trackToRouteDialog() {
  const f = findItem(); if (!f || f.type !== 'track') return;
  const input = h('input', { type: 'number', min: 2, max: 500, value: 50 });
  openDialog({ title: 'Track in Route umwandeln',
    body: [h('p', {}, 'Die Route folgt dem Track mit den formbestimmenden Punkten.'), field('Maximale Anzahl Routenpunkte', input)],
    buttons: [{ label: 'Abbrechen' }, { label: 'Umwandeln', primary: true, action: () => {
      const r = ops.trackToRoute(f.item, +input.value || 50);
      mutate('Track → Route', (doc) => doc.routes.push(r));
      select({ type: 'route', id: r.id });
    } }] });
}
export function mergeAllTracks() {
  if (state.doc.tracks.length < 2) return;
  const merged = ops.mergeTracks(state.doc.tracks);
  mutate('Tracks zusammenführen', (doc) => { doc.tracks = [merged]; });
  select({ type: 'track', id: merged.id });
}

// --- transfer between open files ---------------------------------------------------
/** Copy (or move) the selected item into another open file. */
export function transferSelected(toId, move = false) {
  const f = findItem(), target = fileById(toId);
  if (!f || !target) return;
  const from = state.active;
  const [newId] = transfer([f.item.id], from.id, toId, { move });
  toast(`${f.item.name || 'Element'} ${move ? 'verschoben' : 'kopiert'} nach ${target.name}`);
  return newId;
}

/** Take items of a file over into the working file; onlyNew skips what is already there (see core/compare.js). */
export function adoptFile(fromId, ids) {
  const from = fileById(fromId), to = workFile();
  if (!from || !to || from === to || !ids.length) return;
  transfer(ids, from.id, to.id);
  toast(`${ids.length} Element(e) aus ${from.name} nach ${to.name} übernommen`);
}

/** Select the corresponding item in the file it lives in. */
export function showItem(itemId) {
  const file = fileOfItem(itemId); if (!file) return;
  const d = file.doc;
  const type = d.waypoints.some((x) => x.id === itemId) ? 'waypoint' : d.routes.some((x) => x.id === itemId) ? 'route' : 'track';
  select({ type, id: itemId }, file.id);
  zoomToSelection();
}

export function exportSelection() {
  const f = findItem(); if (!f) return;
  const doc = ops.extractItems(state.doc, [f.item.id]);
  const name = (f.item.name || f.type).replace(/[\\/:*?"<>|]+/g, '_');
  download(name + '.gpx', serializeGpx(doc));
}

// --- route points by coordinate input ----------------------------------------------
/**
 * Add route points from typed coordinates (one per line, any supported notation).
 * Inserted after the selected route point, otherwise appended. All or nothing:
 * if a line is not understood, nothing is added.
 * @returns {{added: number, errors: string[]}}
 */
export function addRoutePointsFromText(text, name = '') {
  const f = findItem();
  if (!f || f.type !== 'route') return { added: 0, errors: ['Keine Route gewählt'] };
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const points = [], errors = [];
  for (const line of lines) {
    const p = parseCoordinate(line);
    if (p) points.push({ lat: p.lat, lon: p.lon }); else errors.push(line);
  }
  if (errors.length || !points.length) return { added: 0, errors };
  if (name.trim() && points.length === 1) points[0].name = name.trim();
  const sel = state.selection;
  const at = Number.isInteger(sel.pointIndex) ? sel.pointIndex + 1 : f.item.points.length;
  mutate(points.length === 1 ? 'Routenpunkt per Koordinate' : `${points.length} Routenpunkte per Koordinate`, () => f.item.points.splice(at, 0, ...points));
  select({ type: 'route', id: f.item.id, pointIndex: at + points.length - 1 });
  // bring the new point into view if it lies outside the map
  const last = points[points.length - 1], tf = map.transform, x = tf.x(last.lon), y = tf.y(last.lat);
  if (x < 20 || y < 20 || x > map.width - 20 || y > map.height - 20) {
    if (f.item.points.length > 1) map.fitBounds(bboxOf(f.item.points)); else map.setView(last, Math.max(map.zoom, 13));
  }
  return { added: points.length, errors: [] };
}

// --- search marker -------------------------------------------------------------------
export function clearMarker() {
  if (!state.marker) return;
  state.marker = null; emit('marker'); map.requestRender();
}

// --- navigation between any two points -------------------------------------------------
const navName = (p) => p.name || formatCoordinate(p.lat, p.lon, state.settings.coordFormat);

/**
 * Pick start or destination for a navigation route: any map position, waypoint,
 * search marker or search result. As soon as both are known, a route with these
 * two points is created and computed (it can then be refined with via points).
 */
export async function setNavPoint(kind, point) {
  state.nav[kind] = { lat: point.lat, lon: point.lon, name: point.name || '' };
  emit('nav'); map.requestRender();
  const { start, end } = state.nav;
  if (!start || !end) return;
  const id = newId('r');
  const route = { id, name: `${navName(start)} → ${navName(end)}`, points: [
    { lat: start.lat, lon: start.lon, name: start.name || 'Start' }, { lat: end.lat, lon: end.lon, name: end.name || 'Ziel' }] };
  mutate('Navigationsroute', (doc) => doc.routes.push(route));
  select({ type: 'route', id });
  cancelNav();
  map.fitBounds(bboxOf(route.points), 80);
  await calcRouteForSelected();
}
export function cancelNav() {
  if (!state.nav.start && !state.nav.end) return;
  state.nav = { start: null, end: null }; emit('nav'); map.requestRender();
}

// --- routing -------------------------------------------------------------------
export async function calcRouteForSelected(profile = state.settings.routingProfile) {
  const f = findItem(); if (!f || f.type !== 'route') return;
  if (f.item.points.length < 2) { toast('Die Route braucht mindestens zwei Punkte', 'error'); return; }
  state.settings.routingProfile = profile; saveSettings();
  toast('Route wird berechnet …', 'info', 0);
  try {
    const r = await osrmRoute(f.item.points, { profile, base: state.settings.services.osrm });
    const t = { id: newId('t'), name: `${f.item.name || 'Route'} (${PROFILES[profile]})`, color: f.item.color,
      desc: `${formatDistance(r.distance)}, ${Math.round(r.duration / 60)} min (OSRM)`, segments: [{ points: r.points }] };
    mutate('Route berechnen', (doc) => doc.tracks.push(t));
    select({ type: 'track', id: t.id });
    toast(`Berechnet: ${formatDistance(r.distance)}, ca. ${Math.floor(r.duration / 3600)} h ${Math.round((r.duration % 3600) / 60)} min`);
  } catch (e) { toast('Routing: ' + e.message, 'error', 7000); }
}

// --- elevation -----------------------------------------------------------------
export async function fetchElevationForSelected() {
  const f = findItem(); if (!f) return;
  const all = f.type === 'waypoint' ? [f.item] : itemPoints(f.item);
  const missing = all.filter((p) => !Number.isFinite(p.ele));
  let targets = missing;
  if (!missing.length || missing.length < all.length) {
    const overwrite = await confirmDialog('Höhen laden', missing.length
      ? `${all.length - missing.length} von ${all.length} Punkten haben bereits eine Höhe. Auch diese mit Geländehöhen überschreiben?`
      : 'Alle Punkte haben bereits eine Höhe. Mit Geländehöhen aus dem Höhenmodell überschreiben?', 'Überschreiben');
    if (overwrite) targets = all; else if (!missing.length) return;
  }
  const id = f.item.id, type = f.type;
  try {
    const r = await lookupElevations(targets, { base: state.settings.services.elevation, local: !!state.localServer,
      onProgress: (d, n) => toast(`Höhen laden … ${d} / ${n}`, 'info', 0) });
    if (!findItem({ type, id })) return; // deleted meanwhile
    mutate('Höhen laden', () => targets.forEach((p, i) => { if (Number.isFinite(r.elevations[i])) p.ele = r.elevations[i]; }));
    const missing = targets.length - r.local - r.online;
    toast(`${r.local + r.online} Höhenwerte übernommen` + (r.local && r.online ? ` (${r.local} lokal, ${r.online} online)` : r.local ? ' (lokale Höhendaten)' : '')
      + (missing ? ` – ${missing} ohne Wert` : ''));
  } catch (e) { toast('Höhendienst: ' + e.message, 'error', 7000); }
}

// --- optimizer (live preview, floating panel) ------------------------------------
export function openOptimizer() {
  const f = findItem(); if (!f || f.type !== 'track') return;
  const track = f.item, total = pointCount(track), weights = trackWeights(track), minPts = minPointCount(track);
  const step = Math.max(...track.segments.map((s) => medianStep(s.points)));
  const modes = {
    level: { label: 'Stufe (relativ zur Aufzeichnungsdichte)', min: 1, max: 10, step: 1, value: 3, unit: '' },
    tolerance: { label: 'Toleranz in Metern', min: 0.5, max: 300, step: 0.5, value: 10, unit: 'm' },
    percent: { label: 'Anteil der Punkte behalten', min: 1, max: 100, step: 1, value: 30, unit: '%' },
    count: { label: 'Anzahl Punkte', min: minPts, max: total, step: 1, value: Math.max(minPts, Math.round(total / 4)), unit: '' },
  };
  let mode = 'level', result = null;
  const slider = h('input', { type: 'range' }), number = h('input', { type: 'number', class: 'narrow' });
  const info = h('p', { class: 'result' }), hint = h('small', {});
  const apply = () => {
    const value = +number.value;
    result = simplifyTrack(track, { mode, value }, weights);
    state.preview = { segments: result.track.segments.map((s) => s.points), color: '#e6007e' };
    info.textContent = `${total.toLocaleString('de')} → ${result.after.toLocaleString('de')} Punkte (${(result.after / total * 100).toFixed(1).replace('.', ',')} %)`;
    hint.textContent = mode === 'level' ? `Toleranz = ${LEVEL_MULTIPLIERS[value] ?? '?'} × mittlerer Punktabstand (${step.toFixed(1).replace('.', ',')} m)` : '';
    map.requestRender();
  };
  const setMode = (m) => {
    mode = m; const c = modes[m];
    for (const el of [slider, number]) { el.min = c.min; el.max = c.max; el.step = c.step; el.value = c.value; }
    apply();
  };
  slider.addEventListener('input', () => { number.value = slider.value; apply(); });
  number.addEventListener('input', () => { slider.value = number.value; apply(); });
  const commit = (asCopy) => {
    if (!result) return;
    const cur = findItem({ type: 'track', id: track.id }); if (!cur) return;
    if (asCopy) {
      const copy = { ...structuredClone(result.track), id: newId('t'), name: (track.name || 'Track') + ' (optimiert)' };
      mutate('Track optimieren (Kopie)', (doc) => doc.tracks.splice(cur.index + 1, 0, copy));
      select({ type: 'track', id: copy.id });
    } else {
      mutate('Track optimieren', (doc) => { doc.tracks[cur.index] = result.track; });
      select({ type: 'track', id: track.id });
    }
    toast(`Track optimiert: ${result.before} → ${result.after} Punkte`);
  };
  openDialog({ title: 'Track optimieren', modal: false,
    body: [
      h('p', {}, h('b', {}, track.name || 'Track'), ` – Vorschau in Magenta auf der Karte.`),
      field('Verfahren', selectEl(Object.entries(modes).map(([k, v]) => [k, v.label]), mode, setMode)),
      h('div', { class: 'row' }, slider, number), hint, info,
    ],
    buttons: [{ label: 'Abbrechen' }, { label: 'Als Kopie', action: () => commit(true) }, { label: 'Übernehmen', primary: true, action: () => commit(false) }],
    onClose: () => { state.preview = null; map.requestRender(); } });
  setMode('level');
}

// --- repair --------------------------------------------------------------------
export function openRepair() {
  const f = findItem(); if (!f || f.type !== 'track') return;
  const track = f.item;
  const hasTime = itemPoints(track).some((p) => p.time);
  const cb = (checked, disabled) => h('input', { type: 'checkbox', checked, disabled });
  const num = (v, min, max, step = 1) => h('input', { type: 'number', class: 'narrow', value: v, min, max, step });
  const dedupe = cb(true), gaps = cb(hasTime, !hasTime), modeSplit = cb(false, !hasTime);
  const sigma = num(3, 1, 10, 0.5), walk = num(15, 1, 60), smooth = num(5, 1, 31, 2), minPts = num(10, 2, 500);
  openDialog({ title: 'Track reparieren / aufteilen',
    body: [
      hasTime ? null : h('p', { class: 'warn' }, 'Der Track enthält keine Zeitstempel – Lücken- und Verkehrsmittelerkennung sind nicht möglich.'),
      h('label', { class: 'check' }, dedupe, 'Doppelte Punkte (gleiche Position hintereinander) entfernen'),
      h('label', { class: 'check' }, gaps, 'An Aufzeichnungslücken in Segmente teilen'),
      field('Lückenschwelle: Mittelwert + σ ×', sigma),
      h('label', { class: 'check' }, modeSplit, 'Nach Verkehrsmittel in eigene Tracks trennen (zu Fuß / Fahrzeug)'),
      h('div', { class: 'grid3' }, field('Gehgrenze km/h', walk), field('Glättung (Punkte)', smooth), field('Mindestpunkte', minPts)),
    ],
    buttons: [{ label: 'Abbrechen' }, { label: 'Anwenden', primary: true, action: () => {
      const cur = findItem({ type: 'track', id: track.id }); if (!cur) return;
      let segs = track.segments.map((s) => s.points);
      const before = pointCount(track);
      if (dedupe.checked) segs = segs.map(removeDuplicates);
      if (gaps.checked) segs = segs.flatMap((s) => splitByGaps(s, { sigmaFactor: +sigma.value || 3 }));
      if (!modeSplit.checked) {
        const t = { ...track, segments: segs.filter((s) => s.length).map((points) => ({ points })) };
        mutate('Track reparieren', (doc) => { doc.tracks[cur.index] = t; });
        select({ type: 'track', id: track.id });
        toast(`${t.segments.length} Segment(e), ${before - pointCount(t)} Punkte entfernt`);
        return;
      }
      const counter = { walk: 0, fast: 0 }, labels = { walk: 'Zu Fuß', fast: 'Fahrzeug' };
      const tracks = segs.flatMap((s) => splitByMode(s, { walkKmh: +walk.value || 15, smoothWindow: +smooth.value || 5, minPoints: +minPts.value || 10 }))
        .filter((r) => r.points.length > 1)
        .map((r) => ({ id: newId('t'), name: `${track.name || 'Track'} – ${labels[r.mode]} ${++counter[r.mode]}`,
          desc: `Ø ${r.avgKmh.toFixed(1).replace('.', ',')} km/h`, color: r.mode === 'walk' ? '#2ca02c' : '#d62728', segments: [{ points: r.points }] }));
      if (!tracks.length) { toast('Keine Abschnitte erkannt', 'error'); return false; }
      mutate('Nach Verkehrsmittel trennen', (doc) => doc.tracks.splice(cur.index, 1, ...tracks));
      select({ type: 'track', id: tracks[0].id });
      toast(`${tracks.length} Tracks erzeugt (${counter.walk} zu Fuß, ${counter.fast} Fahrzeug)`);
      return undefined;
    } }] });
}

// --- settings ------------------------------------------------------------------
export function openSettings() {
  const s = state.settings;
  const svc = Object.fromEntries(Object.keys(DEFAULT_SERVICES).map((k) => [k, h('input', { type: 'url', value: s.services[k] })]));
  const fmt = selectEl(Object.entries(COORD_FORMATS), s.coordFormat);
  const labels = h('input', { type: 'checkbox', checked: s.showLabels });
  const list = h('ul', { class: 'plain' });
  let custom = s.customSources.slice();
  const renderList = () => {
    list.replaceChildren(...custom.map((c, i) => h('li', {}, h('b', {}, c.name), ' ', h('code', {}, c.url), ' ',
      h('button', { type: 'button', class: 'icon', title: 'Entfernen', onclick: () => { custom.splice(i, 1); renderList(); } }, '✕'))));
    if (!custom.length) list.append(h('li', { class: 'muted' }, 'Keine eigenen Kartenquellen'));
  };
  const cName = h('input', { type: 'text', placeholder: 'Name' }), cUrl = h('input', { type: 'url', placeholder: 'https://server/{z}/{x}/{y}.png' }), cMax = h('input', { type: 'number', class: 'narrow', value: 19, min: 1, max: 22 });
  renderList();
  openDialog({ title: 'Einstellungen', className: 'wide',
    body: [
      h('h3', {}, 'Anzeige'), field('Koordinatenformat', fmt), h('label', { class: 'check' }, labels, 'Namen auf der Karte anzeigen'),
      h('h3', {}, 'Eigene Kartenquellen (XYZ-Kacheln)'), list,
      h('div', { class: 'row' }, cName, cUrl, cMax, h('button', { type: 'button', onclick: () => {
        try { custom.push(customSource(cName.value.trim() || 'Eigene Karte', cUrl.value.trim(), +cMax.value)); cName.value = cUrl.value = ''; renderList(); }
        catch (e) { toast(e.message, 'error'); }
      } }, 'Hinzufügen')),
      h('h3', {}, 'Dienste (austauschbar, z. B. eigener Server)'),
      field('Routing (OSRM), {profile} = car | bike | foot', svc.osrm), field('Ortssuche (Nominatim)', svc.nominatim), field('Höhendienst (Open-Meteo-kompatibel)', svc.elevation), field('Vektorkacheln für den Poster-Export (OpenMapTiles-Schema), {z} {x} {y}', svc.vectorTiles),
      h('button', { type: 'button', onclick: () => { for (const k of Object.keys(svc)) svc[k].value = DEFAULT_SERVICES[k]; } }, 'Standard-Dienste wiederherstellen'),
    ],
    buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true, action: () => {
      s.coordFormat = fmt.value; s.showLabels = labels.checked; s.customSources = custom;
      for (const k of Object.keys(svc)) s.services[k] = svc[k].value.trim() || DEFAULT_SERVICES[k];
      saveSettings(); emit('change');
    } }] });
}

