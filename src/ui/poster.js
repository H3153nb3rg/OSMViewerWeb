// Poster export dialog: route/track on a simplified map, saved as SVG (vector,
// any print size) or PNG. Layout and drawing live in core/poster.js.
import { state, findItem } from './store.js';
import { h, toast, openDialog, field, select as selectEl, download, setChildren } from './dom.js';
import { computeStats, formatDistance, formatDuration, cumulativeDistance } from '../core/stats.js';
import { posterLayout, posterTiles, backdropSpec, buildPosterSvg, POSTER_SIZES, POSTER_THEMES, POSTER_DESIGNS, POSTER_FONTS } from '../core/poster.js';
import { geoContours } from '../core/contours.js';
import { TILE_SOURCES, findSource } from '../core/tilesources.js';
import { loadBasemap } from '../services/vectortiles.js';
import { fetchJson } from '../services/http.js';
import { TileCache, renderStatic } from './mapview.js';

const MAX_CANVAS_SIDE = 16384, MAX_CANVAS_PIXELS = 200e6;
const DETAIL = [[3, 'Grob (ruhig, wenige Details)'], [5, 'Mittel'], [8, 'Fein (mehr Wege und Orte)']];
const MAP_KINDS = [['vector', 'Vereinfachte Karte (Vektor)'], ['topo', 'Topo: Wege, Gipfel, Höhenlinien (Vektor)'], ['raster', 'Rasterkarte (Kartenkacheln)'], ['none', 'Ohne Karte – nur die Route']];
const CONTOUR_MAX_SPAN = 2.5; // degrees; beyond that contour lines are neither loadable nor legible

function posterContent(all) {
  const f = findItem();
  const doc = state.doc, vis = (x) => !state.hidden.has(x.id);
  const items = all || !f || f.type === 'waypoint' ? [...doc.tracks.filter(vis), ...doc.routes.filter(vis)] : [f.item];
  const lines = items.flatMap((it) => (it.segments ? it.segments.map((s) => s.points) : [it.points])).filter((l) => l.length > 1);
  const single = items.length === 1 ? items[0] : null;
  return { lines, title: (single && single.name) || doc.metadata.name || state.fileName.replace(/\.[^.]+$/, ''), waypoints: doc.waypoints.filter(vis) };
}

/** Figures that can be derived from the data. A route has no times, hence no duration — it can be typed in. */
export function defaultStats(lines) {
  const s = computeStats(lines);
  const out = [{ label: 'Distanz', value: formatDistance(s.distance) }];
  if (s.ascent !== undefined && s.ascent > 0) out.push({ label: 'Aufstieg', value: Math.round(s.ascent).toLocaleString('de') + ' m' });
  if (s.maxEle !== undefined) out.push({ label: 'Höchster Punkt', value: Math.round(s.maxEle).toLocaleString('de') + ' m' });
  if (s.durationMs > 36 * 3600e3) out.push({ label: 'Tage', value: String(Math.round(s.durationMs / 864e5) + 1) });
  else if (s.durationMs > 0) out.push({ label: 'Dauer', value: formatDuration(s.durationMs) });
  let subtitle = '';
  if (s.start !== undefined) {
    const fmt = (t) => new Date(t).toLocaleDateString('de-AT', { day: 'numeric', month: 'long', year: 'numeric' });
    subtitle = fmt(s.start) === fmt(s.end) ? fmt(s.start) : `${fmt(s.start)} – ${fmt(s.end)}`;
  }
  return { stats: out, subtitle };
}
export const statsToText = (stats) => stats.map((s) => `${s.label}: ${s.value}`).join('\n');
/** "Bezeichnung: Wert" per line; at most six are shown. */
export function parseStats(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6).map((l) => {
    const i = l.indexOf(':');
    return i < 0 ? { label: '', value: l } : { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
  });
}

function profileOf(lines) {
  const pts = lines.flat();
  if (pts.filter((p) => Number.isFinite(p.ele)).length < 2) return null;
  const dist = cumulativeDistance(pts);
  const out = [];
  pts.forEach((p, i) => { if (Number.isFinite(p.ele)) out.push({ d: dist[i], ele: p.ele }); });
  return out;
}

/** Rasterise an SVG string to a PNG blob (browser only). */
export function svgToPng(svg, widthPx, heightPx) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = h('canvas', { width: widthPx, height: heightPx });
        canvas.getContext('2d').drawImage(img, 0, 0, widthPx, heightPx);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Bild konnte nicht erzeugt werden (zu groß für diesen Browser?)'))), 'image/png');
      } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG konnte nicht gerendert werden')); };
    img.src = url;
  });
}

const svgUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
function swatch(T) { // miniature of a map style
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40"><rect width="60" height="40" fill="${T.land}"/><path d="M0 26Q14 18 26 27T60 22V40H0Z" fill="${T.water}"/>`
    + `<path d="M34 0L60 0L60 12Q46 16 34 0Z" fill="${T.wood}"/><path d="M0 10Q30 16 60 6" fill="none" stroke="${T.contour}"/><path d="M4 0L40 40" fill="none" stroke="${T.road}" stroke-width="1.4"/>`
    + `<path d="M6 34Q20 6 34 18T56 8" fill="none" stroke="${T.route}" stroke-width="2.4" stroke-linecap="round"/><rect width="60" height="40" fill="none" stroke="${T.frame}" stroke-width="1.5"/></svg>`);
}

const rasterCache = new TileCache(1500);
/** Render the map frame from ordinary raster tiles into a data URL. */
async function renderBackdrop(layout, source, { muted }) {
  const spec = backdropSpec(layout, { maxZoom: source.maxZoom || 17 });
  const canvas = h('canvas', { width: spec.width, height: spec.height });
  const ctx = canvas.getContext('2d');
  if (muted) ctx.filter = 'grayscale(0.85) contrast(0.82) brightness(1.1)';
  await renderStatic(ctx, { width: spec.width, height: spec.height, center: layout.center, zoom: spec.zoom }, [{ source }], rasterCache, { background: '#ffffff' });
  return { href: canvas.toDataURL('image/jpeg', 0.9), spec, attribution: source.attribution }; // throws when a tile server forbids reading pixels
}

export function openPosterDialog() {
  const first = posterContent(false);
  if (!first.lines.length) { toast('Für ein Poster wird eine Route oder ein Track mit mindestens zwei Punkten gebraucht', 'error'); return; }
  const auto = defaultStats(first.lines);
  const sources = () => [...TILE_SOURCES, ...state.settings.customSources, ...state.archives];
  const opt = { size: 'A3', orientation: 'auto', design: 'galerie', theme: 'hell', font: 'klassisch', title: first.title, subtitle: auto.subtitle, all: false,
    map: 'vector', rasterId: 'opentopo', muted: false, detail: 5, statsText: statsToText(auto.stats),
    roads: true, waterways: true, boundaries: true, forest: true, places: true, peaks: true, compass: true, scaleBar: true, profile: !!profileOf(first.lines),
    coords: false, waypoints: false, lineWidth: 1, dpi: 300 };
  const preview = h('img', { class: 'poster-preview', alt: 'Poster-Vorschau' });
  const info = h('p', { class: 'result' }), note = h('p', { class: 'muted poster-note' });
  const designPick = h('div', { class: 'picker designs', role: 'radiogroup', 'aria-label': 'Layout' });
  const themePick = h('div', { class: 'picker themes', role: 'radiogroup', 'aria-label': 'Kartenstil' });
  const rasterRow = h('div', { class: 'grid2' });
  let svg = '', run = 0, blobUrl = null, layout = null;

  const refresh = async () => {
    const mine = ++run;
    const c = posterContent(opt.all);
    if (!c.lines.length) { info.textContent = 'Keine sichtbare Route oder Track'; return; }
    const profile = opt.profile ? profileOf(c.lines) : null;
    const pts = c.lines.flat();
    const stats = parseStats(opt.statsText);
    const fitPts = opt.waypoints ? [...pts, ...c.waypoints] : pts;
    const layoutFor = (design) => posterLayout(fitPts, { size: POSTER_SIZES[opt.size], orientation: opt.orientation, design, textBlock: !!(opt.title || opt.subtitle || stats.length), profile: !!profile });
    layout = layoutFor(opt.design);
    const base = { lines: c.lines, waypoints: opt.waypoints ? c.waypoints : [], theme: opt.theme, title: opt.title, subtitle: opt.subtitle, stats };
    const options = { topo: opt.map === 'topo', roads: opt.roads, waterways: opt.waterways, boundaries: opt.boundaries, forest: opt.forest, places: opt.places, peaks: opt.peaks,
      compass: opt.compass, scaleBar: opt.scaleBar, coords: opt.coords, coordFormat: state.settings.coordFormat, lineWidth: opt.lineWidth, font: opt.font, profile };
    const build = (extra = {}) => {
      svg = buildPosterSvg({ layout, ...base, ...extra, options });
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      preview.src = blobUrl;
    };
    // pickers: every layout with this route, every style as a swatch
    setChildren(designPick, Object.entries(POSTER_DESIGNS).map(([id, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === opt.design), title: label, dataset: { design: id },
      onclick: () => { opt.design = id; refresh(); } },
    h('img', { alt: '', src: svgUrl(buildPosterSvg({ layout: layoutFor(id), ...base, options: { ...options, scaleBar: false, compass: false, coords: false } })) }), h('span', {}, label.split(' – ')[0]))));
    setChildren(themePick, Object.entries(POSTER_THEMES).map(([id, T]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === opt.theme), title: T.name, dataset: { theme: id },
      onclick: () => { opt.theme = id; refresh(); } }, h('img', { alt: '', src: swatch(T) }), h('span', {}, T.name))));
    rasterRow.hidden = opt.map !== 'raster';

    const k = layout.scale >= 10000 ? 1000 : 100;
    const head = `${opt.size} ${layout.orientation === 'landscape' ? 'quer' : 'hoch'} · Maßstab ca. 1 : ${(Math.round(layout.scale / k) * k).toLocaleString('de')}`;
    const notes = [];
    const done = (text) => { if (mine === run) { info.textContent = `${head} · ${text}`; setChildren(note, notes); } };
    build(); // route at once, the map follows
    if (opt.map === 'none') { done('ohne Kartenhintergrund'); return; }

    if (opt.map === 'raster') {
      const source = findSource(opt.rasterId, sources()) || TILE_SOURCES[0];
      info.textContent = `${head} · Rasterkarte wird aufgebaut …`;
      try {
        const b = await renderBackdrop(layout, source, { muted: opt.muted });
        if (mine !== run) return;
        build({ backdrop: b });
        const dpi = Math.round(b.spec.dpi);
        if (dpi < 110) notes.push(`Die Rasterkarte erreicht bei ${opt.size} nur ${dpi} dpi (Kacheln enden bei Zoom ${source.maxZoom}). Für einen scharfen Druck ein kleineres Format oder eine Vektorkarte wählen.`);
        done(`${source.name}: ${b.spec.width} × ${b.spec.height} px ≈ ${dpi} dpi (Zoom ${b.spec.tileZoom})`);
      } catch (e) {
        notes.push('Diese Kartenquelle lässt sich nicht als Bild übernehmen' + (state.localServer ? '' : ' (ohne lokalen Server verbieten viele Kachelserver das Auslesen)') + '. ' + (e.message || ''));
        done('Rasterkarte nicht verfügbar');
      }
      return;
    }

    const spec = posterTiles(layout, opt.detail);
    info.textContent = `${head} · Karte wird geladen …`;
    const B = layout.bounds;
    const wantContours = opt.map === 'topo';
    const contourJob = !wantContours ? null
      : !state.localServer ? Promise.resolve({ skip: 'Höhenlinien brauchen den lokalen Server (node serve.mjs) – er liefert die Höhendaten.' })
        : B.maxLat - B.minLat > CONTOUR_MAX_SPAN || B.maxLon - B.minLon > CONTOUR_MAX_SPAN ? Promise.resolve({ skip: 'Gebiet zu groß für Höhenlinien – sie wären nicht mehr lesbar.' })
          : (() => {
            const aspect = layout.frame.h / layout.frame.w, cols = Math.round(Math.min(420, Math.max(120, layout.frame.w * 1.1))), rows = Math.max(2, Math.round(cols * aspect));
            return fetchJson(`/api/elevgrid?south=${B.minLat.toFixed(5)}&west=${B.minLon.toFixed(5)}&north=${B.maxLat.toFixed(5)}&east=${B.maxLon.toFixed(5)}&cols=${cols}&rows=${rows}`, { timeoutMs: 120000 })
              .then((g) => (g.known ? geoContours(g, { target: 16 }) : { skip: 'Für dieses Gebiet liegen keine Höhendaten vor.' }), (e) => ({ skip: 'Höhendaten nicht erreichbar: ' + e.message }));
          })();
    const [res, ct] = await Promise.all([
      loadBasemap(spec, { local: !!state.localServer, base: state.settings.services.vectorTiles, onProgress: (d, n) => { if (mine === run) info.textContent = `${head} · Karte wird geladen … ${d} / ${n}`; } }),
      contourJob]);
    if (mine !== run) return; // options changed meanwhile
    build({ tiles: res.tiles, contours: ct && ct.contours ? ct.contours : [] });
    if (ct && ct.skip) notes.push(ct.skip);
    if (!res.tiles.length) {
      notes.push('Die Vektorkarte ist nicht erreichbar (OpenFreeMap, siehe Einstellungen → Dienste). ',
        h('button', { type: 'button', class: 'link', onclick: () => { opt.map = 'raster'; mapSel.value = 'raster'; refresh(); } }, 'Stattdessen eine Rasterkarte verwenden'));
    } else if (res.failed) notes.push(`${res.failed} Kartenkachel(n) fehlen – erneut versuchen, sonst bleiben Lücken im Hintergrund.`);
    if (opt.map === 'topo' && res.tiles.length && spec.z < 11) notes.push(`Bei diesem Maßstab (Kartendaten Zoom ${spec.z}) enthält die Karte noch keine Wanderwege – „Kartendetail: Fein“ oder ein kleineres Gebiet zeigt sie.`);
    done(`${res.tiles.length} Kartenkacheln (Zoom ${spec.z})` + (ct && ct.contours ? ` · Höhenlinien alle ${ct.interval} m` : ''));
  };

  const bind = (key, el, num) => { el.addEventListener('change', () => { opt[key] = el.type === 'checkbox' ? el.checked : num ? +el.value : el.value; refresh(); }); return el; };
  const check = (key, label) => h('label', { class: 'check' }, bind(key, h('input', { type: 'checkbox', checked: opt[key] })), label);
  const fileName = () => (opt.title || 'poster').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'poster';
  const mapSel = bind('map', selectEl(MAP_KINDS, opt.map));
  mapSel.setAttribute('name', 'pmap');
  const statsArea = bind('statsText', h('textarea', { name: 'pstats', rows: 4, spellcheck: 'false' }));
  statsArea.value = opt.statsText;
  setChildren(rasterRow, field('Kartenquelle', bind('rasterId', selectEl(sources().map((s) => [s.id, s.name]), opt.rasterId))), check('muted', 'Farben zurücknehmen'));

  const savePng = async () => {
    const mmW = layout.W, mmH = layout.H;
    let dpi = opt.dpi;
    const fit = Math.min(MAX_CANVAS_SIDE / (Math.max(mmW, mmH) / 25.4), Math.sqrt(MAX_CANVAS_PIXELS / ((mmW / 25.4) * (mmH / 25.4))));
    if (dpi > fit) { dpi = Math.floor(fit); toast(`Auflösung auf ${dpi} dpi begrenzt (Browser-Grenze) – für größere Drucke das SVG verwenden`, 'info', 7000); }
    const blob = await svgToPng(svg, Math.round((mmW / 25.4) * dpi), Math.round((mmH / 25.4) * dpi));
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${fileName()}_${opt.size.replace(/\s+/g, '')}_${dpi}dpi.png` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    return false;
  };

  const body = h('div', { class: 'poster-grid' },
    h('div', { class: 'poster-options' },
      h('h3', {}, 'Layout'), designPick,
      h('h3', {}, 'Kartenstil'), themePick,
      h('h3', {}, 'Karte'),
      field('Kartengrundlage', mapSel), rasterRow,
      h('div', { class: 'grid2' },
        field('Kartendetail', bind('detail', selectEl(DETAIL, opt.detail), true)),
        field('Linienstärke Route', bind('lineWidth', selectEl([[0.6, 'Fein'], [1, 'Normal'], [1.6, 'Kräftig'], [2.4, 'Sehr kräftig']], opt.lineWidth), true))),
      h('div', { class: 'grid2 checks' },
        check('roads', 'Straßen und Wege'), check('places', 'Ortsnamen'), check('waterways', 'Flüsse und Bäche'), check('boundaries', 'Grenzen'),
        check('forest', 'Wald'), check('peaks', 'Gipfel (Topo)'), check('waypoints', 'Wegpunkte'), check('all', 'Alle sichtbaren Routen/Tracks')),
      h('h3', {}, 'Text'),
      field('Überschrift', bind('title', h('input', { type: 'text', name: 'ptitle', value: opt.title }))),
      field('Unterzeile', bind('subtitle', h('input', { type: 'text', name: 'psubtitle', value: opt.subtitle }))),
      field('Kennzahlen – eine pro Zeile als „Bezeichnung: Wert“', statsArea,
        'Aus den Daten vorbelegt, frei änderbar – z. B. „Dauer: 3 Tage“ ergänzen (eine Route hat keine Zeiten). Leer = keine Kennzahlen.'),
      h('div', { class: 'grid2' },
        field('Schrift', bind('font', selectEl(Object.entries(POSTER_FONTS).map(([k2, f]) => [k2, f.name]), opt.font))),
        h('div', { class: 'buttons' }, h('button', { type: 'button', title: 'Kennzahlen wieder aus den Daten berechnen',
          onclick: () => { opt.statsText = statsToText(defaultStats(posterContent(opt.all).lines).stats); statsArea.value = opt.statsText; refresh(); } }, 'Kennzahlen aus Daten'))),
      h('div', { class: 'grid2 checks' }, check('profile', 'Höhenprofil'), check('compass', 'Nordpfeil'), check('scaleBar', 'Maßstabsleiste'), check('coords', 'Koordinaten Start → Ziel')),
      h('h3', {}, 'Format'),
      h('div', { class: 'grid2' },
        field('Größe', bind('size', selectEl(Object.keys(POSTER_SIZES).map((s) => [s, s]), opt.size))),
        field('Ausrichtung', bind('orientation', selectEl([['auto', 'Automatisch'], ['portrait', 'Hochformat'], ['landscape', 'Querformat']], opt.orientation))),
        field('PNG-Auflösung', bind('dpi', selectEl([[150, '150 dpi'], [200, '200 dpi'], [300, '300 dpi']], opt.dpi), true))),
      h('p', { class: 'muted' }, 'SVG ist eine Vektorgrafik und lässt sich in jeder Größe verlustfrei drucken (eine Rasterkarte darin bleibt ein Bild); Schriften setzt das öffnende Programm. PNG ist ein fertiges Bild in der gewählten Auflösung.')),
    h('div', { class: 'poster-stage' }, preview, info, note));

  openDialog({ title: 'Poster exportieren', className: 'poster', body,
    buttons: [{ label: 'Schließen' },
      { label: 'PNG speichern', action: savePng },
      { label: 'SVG speichern', primary: true, action: () => { download(`${fileName()}_${opt.size.replace(/\s+/g, '')}.svg`, svg, 'image/svg+xml'); return false; } }],
    onClose: () => { run++; if (blobUrl) URL.revokeObjectURL(blobUrl); } });
  refresh();
}
