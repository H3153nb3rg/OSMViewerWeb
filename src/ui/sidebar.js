// Sidebar: document tree (waypoints / routes / tracks) and the property panel
// of the current selection.
import { state, on, mutate, select, findItem, emit, activate, keepFile, workFile, setTool } from './store.js';
import { compareDocs, summarize } from '../core/compare.js';
import { fileColor } from './overlay.js';
import { h, $, toast, field, select as selectEl, setChildren } from './dom.js';
import { itemPoints, pointCount } from '../core/gpx.js';
import { computeStats, formatDistance, formatDuration } from '../core/stats.js';
import { parseCoordinate, formatCoordinate } from '../core/coords.js';
import { haversine } from '../core/geo.js';
import { timeMs } from '../core/time.js';
import { PROFILES } from '../services/osrm.js';
import { itemColor } from './overlay.js';
import * as act from './actions.js';
import { deleteSelection } from './editor.js';
import { openPrintDialog } from './print.js';
import { openPosterDialog } from './poster.js';

let treeEl, propsEl, hooks = {};
const collapsed = new Set();

export function initSidebar(h = {}) {
  hooks = h;
  treeEl = $('#tree'); propsEl = $('#props');
  on('change', () => { renderTree(); renderProps(); });
  on('select', () => { renderTree(); renderProps(); });
  on('tool', () => { renderTree(); renderProps(); });
  renderTree(); renderProps();
}

const fmtNum = (n) => n.toLocaleString('de');

// --- comparison with the working file (cached per change) ------------------------
const compareCache = new Map();
/** Map itemId -> {status, coverage, match} for a non-working file, or null. */
export function comparison(file) {
  const work = workFile();
  if (!work || work.id === file.id) return null;
  const key = `${file.id}:${work.id}:${state.version}`;
  if (!compareCache.has(key)) {
    if (compareCache.size > 20) compareCache.clear();
    compareCache.set(key, compareDocs(file.doc, work.doc));
  }
  return compareCache.get(key);
}
const STATUS_TEXT = { neu: 'neu', teilweise: 'teilw.', enthalten: 'vorhanden', identisch: 'identisch' };
function badge(cmp) {
  if (!cmp) return null;
  const text = cmp.status === 'teilweise' ? `${Math.round(cmp.coverage * 100)} % vorh.` : STATUS_TEXT[cmp.status];
  return h('span', { class: 'badge ' + cmp.status, title: 'Verglichen mit der Arbeitsdatei' }, text);
}

function row(file, type, item, label, meta, color, cmp) {
  const sel = state.selection, selected = file.id === state.activeId && sel && sel.id === item.id;
  const vis = h('input', { type: 'checkbox', checked: !state.hidden.has(item.id), title: 'Auf der Karte anzeigen',
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { if (e.target.checked) state.hidden.delete(item.id); else state.hidden.add(item.id); emit('view'); } });
  return h('li', { class: 'item' + (selected ? ' selected' : ''), tabindex: 0,
    onclick: () => select({ type, id: item.id }, file.id),
    ondblclick: () => { select({ type, id: item.id }, file.id); act.zoomToSelection(); },
    onkeydown: (e) => { if (e.key === 'Enter') { select({ type, id: item.id }, file.id); act.zoomToSelection(); } } },
  vis, color ? h('span', { class: 'swatch', style: `background:${color}` }) : h('span', { class: 'swatch pin' }),
  h('span', { class: 'name', title: item.src ? 'Datenquelle: ' + item.src : null }, label, item.src ? h('small', { class: 'src' }, ' ← ' + item.src) : null),
  badge(cmp), h('span', { class: 'meta' }, meta));
}

/** add: {title, tool} shows a "+" in the header (and keeps the section visible while empty). */
function section(key, title, items, renderRow, add = null) {
  if (!items.length && !add) return null;
  const isCollapsed = collapsed.has(key);
  const allVisible = items.every((i) => !state.hidden.has(i.id));
  const head = h('div', { class: 'section-head' },
    h('button', { type: 'button', class: 'twisty', 'aria-expanded': String(!isCollapsed), onclick: () => { if (isCollapsed) collapsed.delete(key); else collapsed.add(key); renderTree(); } }, isCollapsed ? '▸' : '▾'),
    h('span', {}, `${title} (${items.length})`),
    add ? h('button', { type: 'button', class: 'add', title: add.title, 'aria-label': add.title, 'aria-pressed': String(state.tool === add.tool),
      onclick: () => setTool(state.tool === add.tool ? 'select' : add.tool) }, '＋') : null,
    items.length ? h('input', { type: 'checkbox', checked: allVisible, title: 'Alle ein-/ausblenden', onchange: (e) => {
      for (const i of items) { if (e.target.checked) state.hidden.delete(i.id); else state.hidden.add(i.id); }
      emit('view'); renderTree();
    } }) : null);
  const hint = add && state.tool === add.tool ? h('div', { class: 'hintrow' }, add.active) : !items.length && add ? h('div', { class: 'hintrow' }, add.empty) : null;
  return h('section', {}, head, isCollapsed ? null : [h('ul', {}, items.map(renderRow)), hint]);
}

function fileHeader(file, results) {
  const active = file.id === state.activeId, work = workFile();
  const sum = results ? summarize(results) : null;
  const newIds = results ? [...results.entries()].filter(([, r]) => r.status === 'neu' || r.status === 'teilweise').map(([id]) => id) : [];
  const allIds = [...file.doc.waypoints, ...file.doc.routes, ...file.doc.tracks].map((x) => x.id);
  const collapsedFile = collapsed.has('file:' + file.id);
  return h('div', { class: 'file-head' + (active ? ' active' : '') + (file.temp ? ' temp' : '') },
    h('div', { class: 'file-title' },
      h('button', { type: 'button', class: 'twisty', 'aria-expanded': String(!collapsedFile), onclick: () => { if (collapsedFile) collapsed.delete('file:' + file.id); else collapsed.add('file:' + file.id); renderTree(); } }, collapsedFile ? '▸' : '▾'),
      h('input', { type: 'checkbox', checked: file.visible, title: 'Datei auf der Karte anzeigen', onchange: (e) => { file.visible = e.target.checked; emit('view'); } }),
      active ? h('span', { class: 'swatch file active-mark', title: 'Aktive Datei (wird bearbeitet)' }) : h('span', { class: 'swatch file', style: `background:${fileColor(file)}` }),
      h('button', { type: 'button', class: 'file-name', title: active ? 'Aktive Datei' : 'Aktivieren (bearbeiten)', onclick: () => activate(file.id) },
        file.name, file.dirty && !file.temp ? ' •' : ''),
      file.temp ? h('span', { class: 'badge temp', title: 'Zum Vergleich geöffnet – Änderungen werden nicht gespeichert, solange sie nicht übernommen werden' }, 'temporär') : null,
      file.id === work?.id && state.files.length > 1 ? h('span', { class: 'badge work', title: 'Ziel für Vergleich und Übernahme' }, 'Arbeitsdatei') : null,
      h('button', { type: 'button', class: 'icon', title: 'Datei schließen', 'aria-label': 'Datei schließen', onclick: () => (hooks.closeFile ? hooks.closeFile(file.id) : null) }, '✕')),
    sum ? h('div', { class: 'file-cmp' },
      `${sum.neu} neu · ${sum.teilweise} teilweise · ${sum.enthalten + sum.identisch} vorhanden`,
      newIds.length ? h('button', { type: 'button', title: `Neue und teilweise neue Elemente nach „${work.name}“ kopieren`, onclick: () => act.adoptFile(file.id, newIds) }, 'Neue übernehmen') : null,
      h('button', { type: 'button', title: `Alles nach „${work.name}“ kopieren`, onclick: () => act.adoptFile(file.id, allIds) }, 'Alles'),
      file.temp ? h('button', { type: 'button', title: 'Als normale Datei behalten (fragt dann vor dem Schließen)', onclick: () => keepFile(file.id) }, 'Behalten') : null) : null);
}

function renderTree() {
  const files = state.files;
  const intro = files.length === 1 && isEmpty(files[0].doc) && state.tool === 'select' ? h('div', { class: 'empty' }, h('p', {}, 'Noch keine Daten.'),
    h('p', {}, 'GPX- oder KML-Dateien öffnen oder hierher ziehen – oder mit „＋“ bei Routen bzw. Wegpunkten direkt auf der Karte beginnen.'),
    h('p', {}, '„Vergleichen“ öffnet weitere Dateien neben der Arbeitsdatei, um gezielt Daten zu übernehmen.')) : null;
  setChildren(treeEl, files.map((file) => {
    const isActive = file.id === state.activeId;
    const drawing = (r) => isActive && state.tool === 'route' && state.selection && state.selection.id === r.id;
    const d = file.doc, results = comparison(file);
    const cmp = (id) => (results ? results.get(id) : null);
    const body = collapsed.has('file:' + file.id) ? null : [
      section(file.id + 't', 'Tracks', d.tracks, (t, i) => row(file, 'track', t, t.name || '(ohne Namen)', `${fmtNum(pointCount(t))} Pkt`, itemColor(t, i), cmp(t.id))),
      section(file.id + 'r', 'Routen', d.routes, (r, i) => row(file, 'route', r, r.name || '(ohne Namen)', drawing(r) ? `wird gezeichnet · ${r.points.length} Pkt` : `${r.points.length} Pkt`, itemColor(r, i + 3), cmp(r.id)),
        isActive ? { tool: 'route', title: 'Neue Route zeichnen (R) – ist eine Route gewählt, wird sie fortgesetzt', active: 'In die Karte klicken, um Punkte anzuhängen. Doppelklick oder Esc beendet.', empty: '＋ legt eine Route an, die Punkte werden in die Karte geklickt.' } : null),
      section(file.id + 'w', 'Wegpunkte', d.waypoints, (w) => row(file, 'waypoint', w, w.name || '(ohne Namen)', Number.isFinite(w.ele) ? Math.round(w.ele) + ' m' : '', null, cmp(w.id)),
        isActive ? { tool: 'waypoint', title: 'Wegpunkte setzen (W)', active: 'Jeder Klick in die Karte legt einen Wegpunkt an. Esc beendet.', empty: '＋ wählen, dann in die Karte klicken.' } : null),
      !isActive && isEmpty(d) ? h('p', { class: 'muted pad' }, 'leer') : null,
    ];
    // the file name is always shown, also for a single open file
    return h('div', { class: 'file' + (isActive ? ' active' : '') }, fileHeader(file, results), body);
  }), intro);
  const s = treeEl.querySelector('.selected');
  if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
}
const isEmpty = (d) => !d.waypoints.length && !d.routes.length && !d.tracks.length;

/** Origin, comparison and transfer block for the selected item. */
function filePanel(f) {
  const file = state.active, others = state.files.filter((x) => x.id !== file.id), work = workFile();
  const results = comparison(file);
  const cmp = results ? results.get(f.item.id) : null;
  if (!others.length && !f.item.src) return null;
  const target = h('select', { 'aria-label': 'Zieldatei' }, others.map((o) => h('option', { value: o.id, selected: o.id === work?.id }, o.name + (o.temp ? ' (temporär)' : ''))));
  return h('fieldset', { class: 'transfer' }, h('legend', {}, 'Datei & Herkunft'),
    h('p', {}, 'In: ', h('b', {}, file.name), file.temp ? ' (temporär)' : ''),
    textInput(f.item, 'src', 'Datenquelle', { undoLabel: 'Datenquelle ändern' }),
    cmp ? h('p', {}, 'Vergleich mit „', work.name, '“: ', badge(cmp),
      cmp.status === 'teilweise' ? ` – ${Math.round(cmp.coverage * 100)} % der Strecke sind dort schon enthalten` : '',
      cmp.match ? h('button', { type: 'button', class: 'link', onclick: () => act.showItem(cmp.match) }, 'Gegenstück zeigen') : null) : null,
    others.length ? h('div', { class: 'row' }, target,
      h('button', { type: 'button', class: work && file.temp ? 'primary' : '', onclick: () => act.transferSelected(target.value) }, 'Kopieren'),
      h('button', { type: 'button', onclick: () => act.transferSelected(target.value, true) }, 'Verschieben')) : null);
}

/** Text input bound to a property; commits on change. */
function textInput(obj, key, label, { multiline = false, undoLabel = 'Eigenschaft ändern' } = {}) {
  const el = h(multiline ? 'textarea' : 'input', { name: key, ...(multiline ? { rows: 2 } : { type: 'text' }), value: obj[key] || '',
    onchange: (e) => mutate(undoLabel, () => { const v = e.target.value.trim(); if (v) obj[key] = v; else delete obj[key]; }) });
  return field(label, el);
}

function coordInput(pt, name = 'coord') {
  const el = h('input', { type: 'text', name, value: formatCoordinate(pt.lat, pt.lon, state.settings.coordFormat), spellcheck: 'false',
    title: 'Dezimalgrad, Grad/Minuten(/Sekunden), UTM, MGRS, Maidenhead oder Plus Code',
    onchange: (e) => {
      const p = parseCoordinate(e.target.value);
      if (!p) { toast('Koordinate nicht erkannt: ' + e.target.value, 'error'); e.target.value = formatCoordinate(pt.lat, pt.lon, state.settings.coordFormat); return; }
      mutate('Koordinaten ändern', () => { pt.lat = p.lat; pt.lon = p.lon; });
    } });
  return field('Koordinaten', el);
}

function eleInput(pt, name = 'ele') {
  return field('Höhe (m)', h('input', { type: 'number', name, step: 'any', value: Number.isFinite(pt.ele) ? Math.round(pt.ele * 10) / 10 : '',
    onchange: (e) => mutate('Höhe ändern', () => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) pt.ele = v; else delete pt.ele; }) }));
}

const btn = (label, action, title) => h('button', { type: 'button', title, onclick: action }, label);

function statsTable(item, type) {
  const segs = type === 'route' ? [item.points] : item.segments.map((s) => s.points);
  const s = computeStats(segs);
  const rows = [['Punkte', fmtNum(s.count) + (type === 'track' && item.segments.length > 1 ? ` in ${item.segments.length} Segmenten` : '')], ['Länge', formatDistance(s.distance)]];
  if (s.durationMs !== undefined) {
    rows.push(['Zeitraum', new Date(s.start).toLocaleString('de-AT', { dateStyle: 'medium', timeStyle: 'short' })]);
    rows.push(['Dauer', formatDuration(s.durationMs) + (s.movingMs ? ` (in Bewegung ${formatDuration(s.movingMs)})` : '')]);
    if (s.avgKmh) rows.push(['Ø Tempo', s.avgKmh.toFixed(1).replace('.', ',') + ' km/h' + (s.movingKmh ? ` (${s.movingKmh.toFixed(1).replace('.', ',')} in Bewegung)` : '')]);
  }
  if (s.minEle !== undefined) rows.push(['Höhe', `${Math.round(s.minEle)} – ${Math.round(s.maxEle)} m`], ['Auf / Ab', `↑ ${Math.round(s.ascent)} m  ↓ ${Math.round(s.descent)} m`]);
  return h('table', { class: 'stats' }, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))));
}

function colorInput(item, index, type) {
  return field('Farbe', h('input', { type: 'color', name: 'color', value: itemColor(item, type === 'route' ? index + 3 : index),
    onchange: (e) => mutate('Farbe ändern', () => { item.color = e.target.value; }) }));
}

function vertexPanel(f) {
  const sel = state.selection;
  if (!Number.isInteger(sel.pointIndex)) return null;
  const pts = f.type === 'route' ? f.item.points : (f.item.segments[sel.segIndex || 0] || {}).points;
  const p = pts && pts[sel.pointIndex];
  if (!p) return null;
  const step = (d) => { const i = sel.pointIndex + d; if (i >= 0 && i < pts.length) { select({ ...sel, pointIndex: i }); } };
  return h('fieldset', {}, h('legend', {}, `Punkt ${sel.pointIndex + 1} von ${pts.length}` + (f.type === 'track' && f.item.segments.length > 1 ? ` (Segment ${(sel.segIndex || 0) + 1})` : '')),
    f.type === 'route' ? textInput(p, 'name', 'Name') : null,
    f.type === 'route' ? textInput(p, 'desc', 'Beschreibung') : null,
    coordInput(p, 'vcoord'), eleInput(p, 'vele'),
    p.time ? h('p', { class: 'muted' }, 'Zeit: ' + (Number.isFinite(timeMs(p)) ? new Date(timeMs(p)).toLocaleString('de-AT') : p.time)) : null,
    h('div', { class: 'buttons' }, btn('◂ Voriger', () => step(-1)), btn('Nächster ▸', () => step(1)), btn('Punkt zeigen', act.zoomToSelection, 'Karte auf diesen Punkt zentrieren'), btn('Punkt löschen', deleteSelection)));
}

/** Route points by typed coordinates: one per line, any notation. */
function addPointForm(route) {
  const sel = state.selection, after = Number.isInteger(sel.pointIndex) ? sel.pointIndex + 1 : null;
  const coords = h('textarea', { name: 'addcoord', rows: 2, spellcheck: 'false',
    placeholder: 'z. B. 47.2692, 11.4041  ·  N 47° 16.152\' E 011° 24.246\'  ·  32T 681960 5237970\nmehrere Punkte: eine Koordinate pro Zeile' });
  const name = h('input', { type: 'text', name: 'addname', placeholder: 'Name (optional)' });
  const add = () => {
    const r = act.addRoutePointsFromText(coords.value, name.value);
    if (r.errors.length) { toast('Nicht erkannt: ' + r.errors.slice(0, 3).join(' | ') + (r.errors.length > 3 ? ' …' : '') + ' – nichts hinzugefügt', 'error', 6000); coords.focus(); return; }
    if (!r.added) { coords.focus(); return; }
    toast(r.added === 1 ? 'Routenpunkt hinzugefügt' : `${r.added} Routenpunkte hinzugefügt`);
  };
  coords.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  return h('fieldset', { class: 'addpoint' }, h('legend', {}, 'Punkt per Koordinate'),
    field(after ? `Einfügen nach Punkt ${after}` : `Anhängen als Punkt ${route.points.length + 1}`, coords,
      'Dezimalgrad, Grad/Minuten(/Sekunden), UTM, MGRS, Maidenhead, Plus Code. Enter fügt hinzu, Umschalt+Enter neue Zeile.'),
    h('div', { class: 'row' }, name, h('button', { type: 'button', class: 'primary', onclick: add }, 'Hinzufügen')));
}

function routePointList(route) {
  if (route.points.length > 400) return null;
  let dist = 0;
  const sel = state.selection;
  return h('details', { open: route.points.length <= 25 }, h('summary', {}, 'Routenpunkte'),
    h('table', { class: 'points' }, route.points.map((p, i) => {
      if (i) dist += haversine(route.points[i - 1], p);
      return h('tr', { class: sel.pointIndex === i ? 'selected' : '', onclick: () => select({ type: 'route', id: route.id, pointIndex: i }) },
        h('td', {}, i + 1), h('td', {}, p.name || '–'), h('td', { class: 'coord' }, formatCoordinate(p.lat, p.lon, state.settings.coordFormat)), h('td', { class: 'num' }, formatDistance(dist)));
    })));
}

function renderProps() {
  const f = findItem();
  const focusName = propsEl.contains(document.activeElement) ? document.activeElement.getAttribute('name') : null;
  if (!f) {
    const d = state.doc, m = d.metadata;
    setChildren(propsEl, h('h2', {}, 'Datei'), h('p', { class: 'muted' }, state.fileName + (state.dirty && !state.active.temp ? ' •' : '') + (state.active.temp ? ' (temporär – zum Vergleich geöffnet)' : '')),
      textInput(m, 'name', 'Titel'), textInput(m, 'desc', 'Beschreibung', { multiline: true }), textInput(m, 'author', 'Autor'),
      h('div', { class: 'buttons' }, btn('Alles zeigen', act.zoomToAll),
        d.tracks.length > 1 ? btn('Alle Tracks zusammenführen', act.mergeAllTracks) : null,
        btn('Übersicht drucken …', () => openPrintDialog())));
    return;
  }
  const { item, type, index } = f;
  let content;
  if (type === 'waypoint') {
    content = [h('h2', {}, 'Wegpunkt'), textInput(item, 'name', 'Name'), coordInput(item), eleInput(item),
      textInput(item, 'desc', 'Beschreibung', { multiline: true }), textInput(item, 'cmt', 'Kommentar'), textInput(item, 'sym', 'Symbol'),
      h('div', { class: 'buttons' }, btn('Zeigen', act.zoomToSelection), btn('Höhe laden', act.fetchElevationForSelected), btn('Duplizieren', act.duplicateSelected), btn('Löschen', deleteSelection)),
      h('div', { class: 'buttons' }, btn('Route von hier', () => act.setNavPoint('start', item), 'Navigationsroute: diesen Wegpunkt als Start'), btn('Route hierher', () => act.setNavPoint('end', item), 'Navigationsroute: diesen Wegpunkt als Ziel')), filePanel(f)];
  } else if (type === 'route') {
    const profile = selectEl(Object.entries(PROFILES), state.settings.routingProfile);
    content = [h('h2', {}, 'Route'), textInput(item, 'name', 'Name'), textInput(item, 'desc', 'Beschreibung', { multiline: true }), colorInput(item, index, type),
      statsTable(item, type),
      h('div', { class: 'row' }, profile, btn('Route berechnen', () => act.calcRouteForSelected(profile.value), 'Straßen-/Wegeverlauf über OSRM berechnen und als Track ablegen')),
      h('div', { class: 'buttons' }, btn('Ganze Route zeigen', act.zoomToItem, 'Karte auf die gesamte Route einpassen'), btn('Umkehren', act.reverseSelected), btn('→ Track', act.routeToTrackSelected, 'Luftlinien-Track aus den Routenpunkten'),
        btn('Höhen laden', act.fetchElevationForSelected), btn('Drucken …', () => openPrintDialog()), btn('Poster …', () => openPosterDialog(), 'Als Wandbild exportieren: vereinfachte Karte, SVG oder PNG in beliebiger Größe'), btn('Exportieren', act.exportSelection), btn('Duplizieren', act.duplicateSelected), btn('Löschen', () => { select({ type, id: item.id }); deleteSelection(); })),
      addPointForm(item), vertexPanel(f), routePointList(item), filePanel(f)];
  } else {
    content = [h('h2', {}, 'Track'), textInput(item, 'name', 'Name'), textInput(item, 'desc', 'Beschreibung', { multiline: true }), colorInput(item, index, type),
      statsTable(item, type),
      h('div', { class: 'buttons' }, btn('Ganzen Track zeigen', act.zoomToItem, 'Karte auf den gesamten Track einpassen'), btn('Optimieren …', act.openOptimizer, 'Punkte reduzieren (Douglas-Peucker) mit Live-Vorschau'),
        btn('Reparieren …', act.openRepair, 'Duplikate, Lücken, Verkehrsmittel'), btn('Umkehren', act.reverseSelected),
        item.segments.length > 1 ? btn('Segmente verbinden', act.joinSelectedSegments) : null, item.segments.length > 1 ? btn('Segmente → Tracks', act.segmentsToTracks) : null,
        btn('→ Route …', act.trackToRouteDialog), btn('Höhen laden', act.fetchElevationForSelected), btn('Drucken …', () => openPrintDialog()), btn('Poster …', () => openPosterDialog(), 'Als Wandbild exportieren: vereinfachte Karte, SVG oder PNG in beliebiger Größe'),
        btn('Exportieren', act.exportSelection), btn('Duplizieren', act.duplicateSelected), btn('Löschen', () => { select({ type, id: item.id }); deleteSelection(); })),
      filePanel(f), vertexPanel(f)];
  }
  setChildren(propsEl, content);
  if (focusName) { const el = propsEl.querySelector(`[name="${focusName}"]`); if (el) el.focus(); }
}
