// Application entry point: wires toolbar, map, sidebar, files and shortcuts.
import { state, on, emit, openFile, closeFile, resetWorkspace, select, setTool, undo, redo, saveSettings, writeDraft, readDraft, findItem, isEmptyDoc, fileById } from './store.js';
import { h, $, toast, confirmDialog, download, closeContextMenu } from './dom.js';
import { MapView, useLocalServer } from './mapview.js';
import { drawDoc, drawScaleBar, fileColor, drawGrid, drawGhost, drawNav } from './overlay.js';
import { PROFILES } from '../services/osrm.js';
import * as editor from './editor.js';
import { initSidebar } from './sidebar.js';
import { initProfile } from './profile.js';
import { openPrintDialog } from './print.js';
import { openPosterDialog } from './poster.js';
import * as act from './actions.js';
import { parseGpx, serializeGpx, newDoc, pointCount } from '../core/gpx.js';
import { parseKml, serializeKml } from '../core/kml.js';
import { TILE_SOURCES, OVERLAY_SOURCES, findSource, archiveSource } from '../core/tilesources.js';
import { parseCoordinate, formatCoordinate } from '../core/coords.js';
import { groundResolution, bboxOf, unionBbox } from '../core/geo.js';
import { search } from '../services/nominatim.js';

const map = new MapView($('#map'));
act.initActions(map);

// --- layers --------------------------------------------------------------------
const extraSources = () => [...state.settings.customSources, ...state.archives];
function applyLayers() {
  const s = state.settings;
  const base = findSource(s.baseId, extraSources()) || TILE_SOURCES[0];
  const overlay = s.overlayId ? findSource(s.overlayId, extraSources()) : null;
  map.setLayers(base, overlay);
  $('#attribution').textContent = [base.attribution, overlay && overlay.attribution].filter(Boolean).join(' | ');
}
function fillLayerSelects() {
  const s = state.settings;
  const opt = (x) => h('option', { value: x.id, selected: x.id === s.baseId }, x.name);
  $('#base').replaceChildren(...[...TILE_SOURCES, ...s.customSources].map(opt),
    ...(state.archives.length ? [h('optgroup', { label: 'Lokales Archiv (offline)' }, state.archives.map(opt))] : []));
  $('#overlay').replaceChildren(h('option', { value: '' }, 'Keine Überlagerung'), ...OVERLAY_SOURCES.map((x) => h('option', { value: x.id, selected: x.id === s.overlayId }, x.name)));
}
$('#base').addEventListener('change', (e) => { state.settings.baseId = e.target.value; saveSettings(); });
$('#overlay').addEventListener('change', (e) => { state.settings.overlayId = e.target.value; saveSettings(); });
on('settings', () => { fillLayerSelects(); applyLayers(); });

// --- map drawing & interaction ---------------------------------------------------
map.handlers.onDraw = (ctx, tf) => {
  for (const f of state.files) {
    if (f.id === state.activeId || !f.visible) continue;
    drawDoc(ctx, tf, f.doc, { hidden: state.hidden, labels: state.settings.showLabels, reference: { color: fileColor(f) } });
  }
  if (state.active.visible !== false) drawDoc(ctx, tf, state.doc, { selection: state.selection, hidden: state.hidden, handles: true, labels: state.settings.showLabels,
    preview: state.preview, marker: state.marker, hoverPoint: state.hoverPoint, printPages: state.printPages });
  else drawDoc(ctx, tf, { waypoints: [], routes: [], tracks: [] }, { marker: state.marker, printPages: state.printPages });
  const g = state.settings.grid;
  drawGrid(ctx, tf, { format: state.settings.coordFormat, grid: g === 'grid' || g === 'both', corners: g === 'corners' || g === 'both' });
  drawNav(ctx, tf, state.nav);
  drawGhost(ctx, tf, editor.ghost());
  drawScaleBar(ctx, tf.view);
};
map.handlers.onPointerDown = (e, x, y) => { closeContextMenu(); return editor.pointerDown(map, e, x, y); };
map.handlers.onPointerMove = (e, x, y) => editor.pointerMove(map, e, x, y);
map.handlers.onPointerUp = () => editor.pointerUp();
map.handlers.onClick = (e, x, y, captured) => editor.click(map, e, x, y, captured);
map.handlers.onDblClick = (e, x, y) => editor.dblClick(map, e, x, y);
map.handlers.onContextMenu = (e, x, y) => editor.showContextMenu(map, e, x, y);
map.handlers.onHover = (e, x, y) => {
  if (!e) { $('#coords').textContent = ''; if (state.cursor) { state.cursor = null; map.requestRender(); } return; }
  const p = map.transform.toLatLon(x, y);
  if (state.tool !== 'select') { state.cursor = p; map.requestRender(); }
  $('#coords').textContent = formatCoordinate(p.lat, p.lon, state.settings.coordFormat);
  map.canvas.style.cursor = editor.hoverCursor(map, x, y);
};
let viewTimer = 0;
map.handlers.onViewChange = () => {
  const res = groundResolution(map.center.lat, map.zoom);
  $('#zoominfo').textContent = `Zoom ${map.zoom.toFixed(1).replace('.', ',')} · 1 px ≈ ${res >= 100 ? Math.round(res) : res.toFixed(1).replace('.', ',')} m`;
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { state.settings.view = { lat: map.center.lat, lon: map.center.lon, zoom: map.zoom }; try { localStorage.setItem('osmviewer-web.settings.v1', JSON.stringify(state.settings)); } catch { /* ignore */ } }, 800);
};
for (const ev of ['change', 'select', 'view']) on(ev, () => map.requestRender());

// --- files ---------------------------------------------------------------------
function parseFile(name, text) {
  const isKml = /\.kml$/i.test(name) || /<kml[\s>]/i.test(text.slice(0, 2000));
  return isKml ? parseKml(text) : parseGpx(text);
}
const docPoints = (d) => [...d.waypoints, ...d.routes.flatMap((r) => r.points), ...d.tracks.flatMap((t) => t.segments.flatMap((s) => s.points))];

/**
 * mode 'open': regular files, the first one becomes active.
 * mode 'compare': temporary files shown next to the working file — nothing is changed
 * until items are taken over explicitly.
 */
async function loadFiles(files, { mode = 'open' } = {}) {
  let opened = 0, bounds = null;
  for (const file of files) {
    try {
      const doc = parseFile(file.name, await file.text());
      if (isEmptyDoc(doc)) { toast(`${file.name}: keine Wegpunkte, Routen oder Tracks gefunden`, 'error'); continue; }
      openFile(doc, file.name.replace(/\.kml$/i, '.gpx'), { temp: mode === 'compare', activate: mode === 'open' && opened === 0 });
      bounds = unionBbox(bounds, bboxOf(docPoints(doc)));
      opened++;
    } catch (e) { toast(`${file.name}: ${e.message}`, 'error', 8000); }
  }
  if (!opened) return;
  if (mode === 'compare') bounds = unionBbox(bounds, bboxOf(docPoints(state.doc)));
  if (bounds) map.fitBounds(bounds);
  toast(mode === 'compare' ? `${opened} Datei(en) zum Vergleich geöffnet – Übernehmen über die Liste oder das Kontextmenü`
    : opened === 1 ? `${files[0].name} geöffnet` : `${opened} Dateien geöffnet`, 'info', 5000);
}

function pickFiles(mode) {
  const input = h('input', { type: 'file', accept: '.gpx,.kml,.xml,application/gpx+xml', multiple: true });
  input.addEventListener('change', () => { if (input.files.length) loadFiles([...input.files], { mode }); });
  input.click();
}

/** Save the active file. A temporary file becomes a regular one once saved. */
async function save(saveAs = false) {
  const file = state.active;
  const text = serializeGpx(file.doc);
  if (window.showSaveFilePicker) { // File System Access API (Chromium): real "save in place"
    try {
      if (!file.handle || saveAs) {
        file.handle = await window.showSaveFilePicker({ suggestedName: file.name, types: [{ description: 'GPX', accept: { 'application/gpx+xml': ['.gpx'] } }] });
        file.name = file.handle.name;
      }
      const w = await file.handle.createWritable();
      await w.write(text); await w.close();
      file.dirty = false; file.temp = false; state.workId = file.id; state.version++; emit('change'); toast('Gespeichert: ' + file.name);
      return;
    } catch (e) { if (e.name === 'AbortError') return; file.handle = null; }
  }
  download(file.name, text);
  file.dirty = false; file.temp = false; state.workId = file.id; state.version++; emit('change');
}

const needsSaving = (f) => f.dirty && !f.temp && !isEmptyDoc(f.doc);

/** Close a file; asks first when it holds unsaved work (temporary files never ask). */
export async function closeFileAsk(id) {
  const f = fileById(id); if (!f) return;
  if (needsSaving(f) && !(await confirmDialog('Schließen', `„${f.name}“ hat ungespeicherte Änderungen. Trotzdem schließen?`, 'Schließen'))) return;
  closeFile(id);
}

function newDocument() { openFile(newDoc(), 'unbenannt.gpx'); }

// drag & drop
const drop = $('#dropzone');
window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.hidden = false; } });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.hidden = true; });
window.addEventListener('drop', (e) => {
  e.preventDefault(); drop.hidden = true;
  // dropped onto a workspace with data: open for comparison, never mixed in unasked
  if (e.dataTransfer.files.length) loadFiles([...e.dataTransfer.files], { mode: isEmptyDoc(state.doc) ? 'open' : 'compare' });
});

// --- toolbar -------------------------------------------------------------------
const commands = {
  new: newDocument, open: () => pickFiles('open'), compare: () => pickFiles('compare'), save: () => save(false), saveas: () => save(true),
  kml: () => download(state.fileName.replace(/\.gpx$/i, '') + '.kml', serializeKml(state.doc), 'application/vnd.google-earth.kml+xml'),
  undo, redo, fit: act.zoomToAll, print: () => openPrintDialog(), poster: () => openPosterDialog(), settings: act.openSettings,
  'tool-select': () => setTool('select'), 'tool-done': () => setTool('select'), 'tool-waypoint': () => setTool('waypoint'), 'tool-route': () => setTool('route'),
  zoomin: () => map.zoomAround(map.width / 2, map.height / 2, Math.round(map.zoom) + 1),
  zoomout: () => map.zoomAround(map.width / 2, map.height / 2, Math.round(map.zoom) - 1),
};
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => commands[b.dataset.cmd]()));

function refreshToolbar() {
  $('[data-cmd="undo"]').disabled = !state.undoStack.length;
  $('[data-cmd="redo"]').disabled = !state.redoStack.length;
  const u = state.undoStack[state.undoStack.length - 1];
  $('[data-cmd="undo"]').title = u ? `Rückgängig: ${u.label} (Strg+Z)` : 'Rückgängig (Strg+Z)';
  document.querySelectorAll('[data-cmd^="tool-"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cmd === 'tool-' + state.tool)));
  document.title = `${state.dirty && !state.active.temp ? '• ' : ''}${state.fileName} – OSMViewer Web`;
  const hints = { select: 'Auswahl: Klick wählt, Ziehen verschiebt Punkte, Doppelklick auf die gewählte Linie fügt einen Punkt ein, Rechtsklick öffnet das Menü.',
    waypoint: 'Wegpunkt: Klick in die Karte setzt einen Wegpunkt. Esc beendet.',
    route: 'Route: Klicks setzen Routenpunkte (an die gewählte Route angehängt). Doppelklick oder Esc beendet.' };
  $('#hint').textContent = hints[state.tool];
}
for (const ev of ['change', 'tool', 'select']) on(ev, refreshToolbar);
const TOOL_BANNER = {
  waypoint: 'Wegpunkt setzen: in die Karte klicken – jeder Klick legt einen Wegpunkt an.',
  route: 'Route zeichnen: in die Karte klicken, um Punkte anzuhängen. Doppelklick oder „Fertig“ beendet.',
};
on('tool', () => {
  map.canvas.style.cursor = state.tool === 'select' ? 'grab' : 'crosshair';
  if (state.tool === 'route') editor.startRoute(); else editor.discardEmptyRoutes();
  if (state.tool === 'select') state.cursor = null;
  $('#maphint').hidden = state.tool === 'select';
  $('#maphint-text').textContent = TOOL_BANNER[state.tool] || '';
  map.requestRender();
});
$('#grid').addEventListener('change', (e) => { state.settings.grid = e.target.value; saveSettings(); map.requestRender(); });

// --- search --------------------------------------------------------------------
const searchInput = $('#search'), results = $('#results');
function showMarker(lat, lon, label, bbox) {
  state.marker = { lat, lon, label }; emit('marker');
  if (bbox && (bbox.maxLat - bbox.minLat > 0.002 || bbox.maxLon - bbox.minLon > 0.002)) map.fitBounds(bbox, 30); else map.setView({ lat, lon }, Math.max(map.zoom, 14));
  map.requestRender();
}
function resultRow(r) {
  const point = { lat: r.lat, lon: r.lon, name: r.name };
  const done = () => { closeResults(); map.canvas.focus(); }; // focus back on the map so Entf/Esc work there
  return h('li', {}, h('button', { type: 'button', class: 'res', onclick: () => showMarker(r.lat, r.lon, r.name, r.bbox) }, h('b', {}, r.name), h('small', {}, r.label)),
    h('button', { type: 'button', title: 'Als Wegpunkt übernehmen', 'aria-label': 'Als Wegpunkt übernehmen', onclick: () => { editor.addWaypoint(point, r.name); act.clearMarker(); done(); } }, '＋'),
    h('button', { type: 'button', title: 'Route von hier (Start)', onclick: () => { act.clearMarker(); done(); act.setNavPoint('start', point); } }, 'Start'),
    h('button', { type: 'button', title: 'Route hierher (Ziel)', onclick: () => { act.clearMarker(); done(); act.setNavPoint('end', point); } }, 'Ziel'));
}
function refreshMarkerButton() { $('#clearmarker').hidden = !state.marker; }
on('marker', refreshMarkerButton);
function closeResults() { results.hidden = true; results.replaceChildren(); }
async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) { act.clearMarker(); closeResults(); return; }
  const c = parseCoordinate(q);
  if (c) {
    const label = formatCoordinate(c.lat, c.lon, state.settings.coordFormat);
    showMarker(c.lat, c.lon, label);
    results.replaceChildren(resultRow({ ...c, name: label, label: 'Koordinate (' + c.format + ')' })); results.hidden = false;
    return;
  }
  results.replaceChildren(h('li', { class: 'muted' }, 'Suche …')); results.hidden = false;
  try {
    const list = await search(q, { base: state.settings.services.nominatim });
    if (!list.length) { results.replaceChildren(h('li', { class: 'muted' }, 'Nichts gefunden')); return; }
    results.replaceChildren(...list.map(resultRow));
    showMarker(list[0].lat, list[0].lon, list[0].name, list[0].bbox);
  } catch (e) { results.replaceChildren(h('li', { class: 'muted' }, 'Suche fehlgeschlagen: ' + e.message)); }
}
$('#searchform').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
searchInput.addEventListener('input', () => { if (!searchInput.value.trim()) { act.clearMarker(); closeResults(); } }); // emptied (also via the field's ✕)
$('#clearmarker').addEventListener('click', () => { act.clearMarker(); searchInput.value = ''; closeResults(); });

// --- navigation banner -----------------------------------------------------------
$('#navprofile').replaceChildren(...Object.entries(PROFILES).map(([k, v]) => h('option', { value: k, selected: k === state.settings.routingProfile }, v)));
$('#navprofile').addEventListener('change', (e) => { state.settings.routingProfile = e.target.value; saveSettings(); });
$('#navcancel').addEventListener('click', () => act.cancelNav());
on('nav', () => {
  const { start, end } = state.nav;
  $('#navhint').hidden = !start && !end;
  $('#navhint-text').textContent = start ? 'Start gesetzt – jetzt das Ziel wählen: Rechtsklick in die Karte → „Route hierher“, oder „Ziel“ bei einem Suchergebnis/Wegpunkt.'
    : end ? 'Ziel gesetzt – jetzt den Start wählen: Rechtsklick in die Karte → „Route von hier“, oder „Start“ bei einem Suchergebnis/Wegpunkt.' : '';
});
document.addEventListener('pointerdown', (e) => { if (!$('#searchbox').contains(e.target)) closeResults(); });

// --- keyboard ------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase();
  if (mod && k === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (mod && k === 'o') { e.preventDefault(); pickFiles('open'); return; }
  if (mod && k === 'p') { e.preventDefault(); openPrintDialog(); return; }
  if (typing || document.querySelector('dialog[open]:not(.floating)')) return;
  if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (k === 'delete' || k === 'backspace') { if (findItem()) { e.preventDefault(); editor.deleteSelection(); } else if (state.marker) { e.preventDefault(); act.clearMarker(); } }
  else if (k === 'escape') { if (state.tool !== 'select') setTool('select'); else if (state.nav.start || state.nav.end) act.cancelNav(); else if (state.marker) act.clearMarker(); else select(null); }
  else if (k === 'w' && !mod) setTool('waypoint');
  else if (k === 'r' && !mod) setTool('route');
  else if (k === 'f' && !mod) act.zoomToSelection();
  else if (k === '+' || k === '=') commands.zoomin();
  else if (k === '-') commands.zoomout();
});
window.addEventListener('beforeunload', (e) => { if (state.files.some(needsSaving)) { e.preventDefault(); e.returnValue = ''; } });

// --- start-up ------------------------------------------------------------------
const DRAFT_MAX_POINTS = 40000; // larger workspaces are not mirrored to localStorage (quota, serialisation cost)
on('draft', () => {
  const n = state.files.reduce((a, f) => a + docPoints(f.doc).length, 0);
  writeDraft(n && n <= DRAFT_MAX_POINTS ? state.files.filter((f) => !isEmptyDoc(f.doc))
    .map((f) => ({ name: f.name, text: serializeGpx(f.doc), dirty: f.dirty, temp: f.temp, active: f.id === state.activeId })) : null);
});
fillLayerSelects(); applyLayers();
$('#grid').value = state.settings.grid || 'none';
initSidebar({ closeFile: closeFileAsk }); initProfile(map);
if (state.settings.view) map.setView(state.settings.view, state.settings.view.zoom);
const draft = readDraft();
if (Array.isArray(draft) && draft.length) {
  try {
    let activeId = null;
    for (const e of draft) {
      const f = openFile(parseGpx(e.text), e.name, { temp: !!e.temp, activate: false });
      f.dirty = !!e.dirty; if (e.active) activeId = f.id;
    }
    if (activeId) select(null, activeId);
    emit('change');
    if (draft.some((e) => e.dirty && !e.temp)) toast('Letzte Sitzung wiederhergestellt (ungespeicherte Änderungen)', 'info', 5000);
  } catch { resetWorkspace(); }
}

// Local server (serve.mjs): tiles and elevation through the disk cache, archive layers.
// Without it (plain web server, hosting) the app talks to the services directly.
async function detectLocalServer() {
  try {
    const res = await fetch('/api/info', { cache: 'no-store' });
    const info = res.ok ? await res.json() : null;
    if (!info || !info.cache) return;
    state.localServer = info;
    state.archives = (info.archives || []).map((a) => archiveSource(a.store, a.maxZoom));
    useLocalServer(true);
    fillLayerSelects(); applyLayers();
    $('#cacheinfo').textContent = info.offline ? 'Cache: offline' : 'Cache: lokal';
    $('#cacheinfo').title = 'Kacheln und Höhendaten werden gespeichert in ' + info.root;
  } catch { /* no local server */ }
}
detectLocalServer();
refreshToolbar(); map.handlers.onViewChange();
window.osmviewer = { state, map }; // handy for debugging in the console
