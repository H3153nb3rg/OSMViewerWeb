// Printing: layout dialog, page rendering to canvases, browser print.
// Layout maths lives in core/printlayout.js; this module only renders pages.
import { state, findItem, emit } from './store.js';
import { h, $, toast, openDialog, field, select as selectEl } from './dom.js';
import { itemPoints } from '../core/gpx.js';
import { fitPage, layoutPages, PAPER_SIZES, COMMON_SCALES } from '../core/printlayout.js';
import { TILE_SOURCES, OVERLAY_SOURCES, findSource } from '../core/tilesources.js';
import { computeStats, formatDistance } from '../core/stats.js';
import { TileCache, renderStatic } from './mapview.js';
import { drawDoc, drawScaleBar, drawAttribution, drawGrid } from './overlay.js';
import { COORD_FORMATS } from '../core/coords.js';

const MAX_CANVAS_PIXELS = 16e6; // Safari limit; plenty for A3 at 200 dpi
const fmtScale = (s) => { const k = s >= 10000 ? 100 : 10; return '1 : ' + (Math.round(s / k) * k).toLocaleString('de'); };

function printTarget() {
  const f = findItem();
  if (f && f.type !== 'waypoint') return { item: f.item, type: f.type, title: f.item.name || (f.type === 'route' ? 'Route' : 'Track'), points: itemPoints(f.item), path: true };
  const d = state.doc;
  const vis = (x) => !state.hidden.has(x.id);
  const points = [...d.waypoints.filter(vis), ...d.routes.filter(vis).flatMap((r) => r.points), ...d.tracks.filter(vis).flatMap((t) => itemPoints(t))];
  return { item: null, title: d.metadata.name || state.fileName.replace(/\.[^.]+$/, ''), points, path: false };
}

export function openPrintDialog() {
  const target = printTarget();
  if (!target.points.length) { toast('Nichts zu drucken – das Dokument ist leer', 'error'); return; }
  const custom = [...state.settings.customSources, ...state.archives];
  const opt = { paper: 'A4', orientation: 'auto', mode: 'fit', scale: 50000, dpi: 150, detail: 0, baseId: state.settings.baseId, overlayId: state.settings.overlayId,
    only: !!target.item, labels: true, marginMm: 10,
    grid: state.settings.grid && state.settings.grid !== 'none' ? state.settings.grid : 'corners', coordFormat: state.settings.coordFormat };
  const summary = h('p', { class: 'result' });
  let pages = [];
  const recompute = () => {
    const src = findSource(opt.baseId, custom) || TILE_SOURCES[0];
    const size = PAPER_SIZES[opt.paper];
    const dpi = Math.min(opt.dpi, Math.floor(Math.sqrt(MAX_CANVAS_PIXELS / ((size[0] / 25.4) * (size[1] / 25.4)))));
    const common = { paper: opt.paper, orientation: opt.orientation, dpi, marginMm: opt.marginMm, headerMm: 8, maxZoom: src.maxZoom };
    pages = opt.mode === 'pages' && target.path ? layoutPages(target.points, { ...common, scale: opt.scale })
      : [fitPage(target.points, { ...common, roundScale: opt.mode === 'nice' })].filter(Boolean);
    state.printPages = pages; emit('view');
    const o = pages.map((p) => (p.orientation === 'landscape' ? 'quer' : 'hoch'));
    summary.textContent = pages.length === 1
      ? `1 Seite ${opt.paper} ${o[0]}, Maßstab ca. ${fmtScale(pages[0].scale)}`
      : `${pages.length} Seiten ${opt.paper} (${o.filter((x) => x === 'hoch').length} hoch, ${o.filter((x) => x === 'quer').length} quer), Maßstab ${fmtScale(opt.scale)}`;
    if (dpi < opt.dpi) summary.textContent += ` – Auflösung auf ${dpi} dpi begrenzt`;
    return dpi;
  };
  const bind = (key, el, num) => { el.addEventListener('change', () => { opt[key] = el.type === 'checkbox' ? el.checked : num ? +el.value : el.value; scaleRow.hidden = opt.mode !== 'pages'; recompute(); }); return el; };
  const scaleRow = field('Maßstab', bind('scale', selectEl(COMMON_SCALES.map((s) => [s, fmtScale(s)]), opt.scale), true));
  scaleRow.hidden = true;
  const modes = [['fit', 'Eine Seite – Ausschnitt exakt einpassen'], ['nice', 'Eine Seite – auf runden Maßstab einpassen']];
  if (target.path) modes.push(['pages', 'Mehrere Seiten in festem Maßstab (Streckenkarte)']);
  const body = [
    h('p', {}, h('b', {}, target.title), target.item ? ` – ${formatDistance(computeStats([target.points]).distance)}` : ' – gesamtes Dokument',
      '. Die blauen Rahmen auf der Karte zeigen die Seitenausschnitte.'),
    h('div', { class: 'grid2' },
      field('Papier', bind('paper', selectEl(Object.keys(PAPER_SIZES).map((p) => [p, p]), opt.paper))),
      field('Ausrichtung', bind('orientation', selectEl([['auto', 'Automatisch (beste Ausnutzung)'], ['portrait', 'Hochformat'], ['landscape', 'Querformat']], opt.orientation))),
      field('Aufteilung', bind('mode', selectEl(modes, opt.mode))), scaleRow,
      field('Karte', bind('baseId', selectEl([...TILE_SOURCES, ...custom].map((s) => [s.id, s.name]), opt.baseId))),
      field('Überlagerung', bind('overlayId', selectEl([['', '– keine –'], ...OVERLAY_SOURCES.map((s) => [s.id, s.name])], opt.overlayId))),
      field('Auflösung', bind('dpi', selectEl([[100, '100 dpi (Entwurf)'], [150, '150 dpi'], [200, '200 dpi'], [300, '300 dpi (viele Kacheln)']], opt.dpi), true)),
      field('Kartendetail', bind('detail', selectEl([[-1, 'Grob (größere Schrift)'], [0, 'Normal'], [1, 'Fein (kleinere Schrift, schärfer)']], opt.detail), true)),
      field('Koordinaten', bind('grid', selectEl([['none', 'Keine'], ['corners', 'Eckpunkte beschriften'], ['grid', 'Gitter mit Randbeschriftung'], ['both', 'Gitter + Eckpunkte']], opt.grid))),
      field('Koordinatensystem', bind('coordFormat', selectEl(Object.entries(COORD_FORMATS), opt.coordFormat))),
      field('Rand (mm)', bind('marginMm', h('input', { type: 'number', min: 0, max: 30, value: opt.marginMm }), true))),
    target.item ? h('label', { class: 'check' }, bind('only', h('input', { type: 'checkbox', checked: opt.only })), 'Nur dieses Element und die Wegpunkte drucken') : null,
    h('label', { class: 'check' }, bind('labels', h('input', { type: 'checkbox', checked: opt.labels })), 'Namen beschriften'),
    summary,
    h('p', { class: 'muted' }, 'Hinweis: Öffentliche Kachelserver sind für den Einzelgebrauch gedacht – bitte keine Seitenserien in hoher Auflösung über tile.openstreetmap.org drucken.'),
  ];
  let dpi = recompute();
  const run = async () => {
    dpi = recompute();
    if (!pages.length) return false;
    await renderPreview(pages, { ...opt, dpi }, target);
    return false; // keep the dialog open: settings can be adjusted after the preview
  };
  openDialog({ title: 'Drucken', modal: false, className: 'wide', body,
    buttons: [{ label: 'Schließen' }, { label: 'Druckvorschau', primary: true, action: run }],
    onClose: () => { state.printPages = null; emit('view'); } });
}

async function renderPreview(pages, opt, target) {
  const custom = [...state.settings.customSources, ...state.archives];
  const base = findSource(opt.baseId, custom) || TILE_SOURCES[0];
  const overlay = opt.overlayId ? findSource(opt.overlayId, custom) : null;
  const layers = [{ source: base }, ...(overlay ? [{ source: overlay }] : [])];
  const cache = new TileCache(4000);
  const s = opt.dpi / 96;
  const only = opt.only && target.item ? new Set([target.item.id, ...state.doc.waypoints.map((w) => w.id)]) : null;
  const attribution = [base.attribution, overlay && overlay.attribution].filter(Boolean).join(' | ');
  const root = $('#print-root');
  const status = h('span', {}, '');
  const bar = h('div', { class: 'print-bar' }, h('b', {}, 'Druckvorschau'), status,
    h('button', { type: 'button', class: 'primary', onclick: () => window.print() }, 'Drucken / als PDF speichern'),
    pages.length === 1 ? h('button', { type: 'button', onclick: () => savePng(root.querySelector('canvas'), target.title) }, 'Als PNG speichern') : null,
    h('button', { type: 'button', onclick: closePreview }, 'Schließen'));
  // one @page rule per orientation so mixed portrait/landscape documents print correctly
  const [pw, ph] = PAPER_SIZES[opt.paper];
  const style = h('style', {}, `@page pp { size: ${pw}mm ${ph}mm; margin: 0 } @page pl { size: ${ph}mm ${pw}mm; margin: 0 }
    @page { size: ${pages[0].orientation === 'landscape' ? `${ph}mm ${pw}mm` : `${pw}mm ${ph}mm`}; margin: 0 }`);
  root.replaceChildren(style, bar);
  root.hidden = false; document.body.classList.add('previewing');
  const date = new Date().toLocaleDateString('de-AT');
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    status.textContent = `Seite ${i + 1} von ${pages.length} wird aufgebaut …`;
    const canvas = h('canvas', { width: pg.widthPx, height: pg.heightPx });
    const head = h('header', { style: `height:${pg.headerMm}mm` }, h('b', {}, target.title),
      h('span', {}, `${pages.length > 1 ? `Seite ${i + 1} / ${pages.length} · ` : ''}${fmtScale(pg.scale)} · ${base.name} · ${date}`));
    const sheet = h('section', { class: 'print-page ' + pg.orientation,
      // 0.4 mm short of the sheet so rounding never spills onto a blank extra page
      style: `width:${pg.pageWidthMm}mm;height:${pg.pageHeightMm - 0.4}mm;padding:${pg.marginMm}mm` }, head, canvas);
    root.append(sheet);
    const view = { width: pg.widthPx, height: pg.heightPx, center: pg.center, zoom: pg.zoom };
    await renderStatic(canvas.getContext('2d'), view, layers, cache, { detail: opt.detail, drawOverlay: (ctx, tf) => {
      drawDoc(ctx, tf, state.doc, { scale: s, hidden: state.hidden, only, labels: opt.labels, endpoints: true });
      drawGrid(ctx, tf, { format: opt.coordFormat, scale: s, grid: opt.grid === 'grid' || opt.grid === 'both', corners: opt.grid === 'corners' || opt.grid === 'both' });
      drawScaleBar(ctx, view, s);
      drawAttribution(ctx, view, attribution, s);
    } });
    if (!document.body.classList.contains('previewing')) return; // closed while rendering
  }
  status.textContent = `${pages.length} Seite(n) bereit`;
}

function closePreview() {
  const root = $('#print-root');
  root.replaceChildren(); root.hidden = true;
  document.body.classList.remove('previewing');
}

function savePng(canvas, title) {
  try {
    canvas.toBlob((blob) => {
      if (!blob) { toast('PNG-Export nicht möglich', 'error'); return; }
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: title.replace(/[\\/:*?"<>|]+/g, '_') + '.png' });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  } catch { toast('Diese Kartenquelle erlaubt keinen Bildexport (kein CORS) – Drucken funktioniert trotzdem.', 'error', 7000); }
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('previewing')) closePreview(); });
