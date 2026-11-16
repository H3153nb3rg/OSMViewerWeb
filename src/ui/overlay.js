// Vector overlay: draws the GPX document on top of the tiles. Used by the
// interactive map and (with a scale factor) by the print renderer.
import { scaleBar, pageBounds } from '../core/printlayout.js';
import { buildGrid, cornerLabels } from '../core/grid.js';

export const PALETTE = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#008080', '#8c564b', '#e377c2', '#000075', '#7f7f00'];
export const itemColor = (item, index) => item.color || PALETTE[index % PALETTE.length];

function tracePath(ctx, tf, points) {
  // Skip vertices that fall on (nearly) the same pixel: keeps 100k-point tracks fluid.
  let lx = NaN, ly = NaN, n = 0;
  for (let i = 0; i < points.length; i++) {
    const x = tf.x(points[i].lon), y = tf.y(points[i].lat);
    if (i > 0 && i < points.length - 1 && Math.abs(x - lx) < 0.6 && Math.abs(y - ly) < 0.6) continue;
    if (n++ === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    lx = x; ly = y;
  }
}

function strokeLine(ctx, tf, points, color, width, { casing = true, dash = null } = {}) {
  if (points.length < 2) return;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath(); tracePath(ctx, tf, points);
  if (casing) { ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = width + 2.5 * (width / 3); ctx.stroke(); }
  ctx.setLineDash(dash || []);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  ctx.setLineDash([]);
}

export function drawLabel(ctx, text, x, y, s = 1, { align = 'left', bold = false } = {}) {
  if (!text) return;
  ctx.font = `${bold ? '600 ' : ''}${12 * s}px system-ui, "Segoe UI", sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 * s; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y); ctx.fillStyle = '#111'; ctx.fillText(text, x, y);
}

function drawPin(ctx, x, y, s, color, selected) {
  const r = 6 * s;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.bezierCurveTo(x - r * 0.4, y - r * 1.1, x - r, y - r * 1.5, x - r, y - r * 2.2);
  ctx.arc(x, y - r * 2.2, r, Math.PI, 0); ctx.bezierCurveTo(x + r, y - r * 1.5, x + r * 0.4, y - r * 1.1, x, y);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = (selected ? 2.5 : 1.2) * s; ctx.strokeStyle = selected ? '#000' : '#fff'; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y - r * 2.2, r * 0.4, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill();
}

function dot(ctx, x, y, r, fill, stroke, lw) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

/** Colour of an open file that is shown for comparison (not the active one). */
export const FILE_COLORS = ['#e6007e', '#ff7f0e', '#008b8b', '#7b3fbf', '#b8860b', '#2e8b57', '#c0392b', '#1f4e9c'];
export const fileColor = (file) => FILE_COLORS[(parseInt(String(file.id).replace(/\D/g, ''), 10) - 1) % FILE_COLORS.length];

/**
 * @param {object} o  selection, hidden:Set, scale (line/label factor), labels, handles (edit vertices),
 *                    reference: {color} draws the whole document in one colour, dashed and lighter
 *                    (a file opened for comparison),
 *                    only: Set of ids to draw (print "nur Auswahl"), preview, marker, hoverPoint, printPages
 */
export function drawDoc(ctx, tf, doc, o = {}) {
  const s = o.scale || 1, sel = o.selection, hidden = o.hidden || new Set();
  const { width, height } = tf.view;
  const visible = (item) => !hidden.has(item.id) && (!o.only || o.only.has(item.id));
  const onScreen = (x, y, m = 40 * s) => x > -m && y > -m && x < width + m && y < height + m;
  const ref = o.reference;
  if (ref) { ctx.save(); ctx.globalAlpha = 0.85; }

  doc.tracks.forEach((t, i) => {
    if (!visible(t)) return;
    const selected = sel && sel.type === 'track' && sel.id === t.id;
    const color = ref ? ref.color : itemColor(t, i);
    for (const seg of t.segments) strokeLine(ctx, tf, seg.points, color, (selected ? 4 : ref ? 2.5 : 3) * s, ref ? { dash: [10 * s, 5 * s] } : {});
    if (!ref && (selected || o.endpoints)) {
      const first = t.segments.find((g) => g.points.length), last = [...t.segments].reverse().find((g) => g.points.length);
      if (first) {
        const a = first.points[0], b = last.points[last.points.length - 1];
        dot(ctx, tf.x(a.lon), tf.y(a.lat), 5 * s, '#18a418', '#fff', 1.5 * s);
        dot(ctx, tf.x(b.lon), tf.y(b.lat), 5 * s, '#d01818', '#fff', 1.5 * s);
      }
    }
  });

  doc.routes.forEach((r, i) => {
    if (!visible(r)) return;
    const selected = sel && sel.type === 'route' && sel.id === r.id;
    const color = ref ? ref.color : itemColor(r, i + 3);
    strokeLine(ctx, tf, r.points, color, (selected ? 3.5 : 2.5) * s, { dash: ref ? [3 * s, 4 * s] : [8 * s, 5 * s] });
    r.points.forEach((p, k) => {
      const x = tf.x(p.lon), y = tf.y(p.lat);
      if (!onScreen(x, y)) return;
      dot(ctx, x, y, 4.5 * s, '#fff', color, 2 * s);
      if (o.labels !== false && p.name && (selected || r.points.length <= 60)) drawLabel(ctx, p.name, x + 8 * s, y - 8 * s, s * 0.92);
      else if (selected && !p.name) drawLabel(ctx, String(k + 1), x + 8 * s, y - 8 * s, s * 0.85);
    });
  });

  if (o.preview) for (const pts of o.preview.segments) strokeLine(ctx, tf, pts, o.preview.color || '#e6007e', 2.5 * s, { casing: false });

  if (o.handles && sel && sel.type !== 'waypoint') { // edit vertices of the selected line
    const item = (sel.type === 'route' ? doc.routes : doc.tracks).find((x) => x.id === sel.id);
    if (item && visible(item)) {
      const segs = item.segments ? item.segments.map((g) => g.points) : [item.points];
      let inView = 0;
      for (const pts of segs) for (const p of pts) { if (onScreen(tf.x(p.lon), tf.y(p.lat), 0) && ++inView > 1500) break; }
      segs.forEach((pts, si) => pts.forEach((p, pi) => {
        const x = tf.x(p.lon), y = tf.y(p.lat);
        const isSel = sel.pointIndex === pi && (sel.segIndex || 0) === si;
        if (!onScreen(x, y, 0) || (inView > 1500 && !isSel)) return;
        if (sel.type === 'track' || isSel) {
          ctx.beginPath(); ctx.rect(x - (isSel ? 5 : 3), y - (isSel ? 5 : 3), isSel ? 10 : 6, isSel ? 10 : 6);
          ctx.fillStyle = isSel ? '#ffd400' : '#fff'; ctx.fill(); ctx.lineWidth = isSel ? 2 : 1; ctx.strokeStyle = '#000'; ctx.stroke();
        }
      }));
    }
  }

  doc.waypoints.forEach((w) => {
    if (!visible(w)) return;
    const x = tf.x(w.lon), y = tf.y(w.lat);
    if (!onScreen(x, y)) return;
    const selected = sel && sel.type === 'waypoint' && sel.id === w.id;
    drawPin(ctx, x, y, ref ? s * 0.85 : s, selected ? '#ffb400' : ref ? ref.color : '#2b6fd6', selected);
    if (o.labels !== false) drawLabel(ctx, w.name, x + 9 * s, y - 13 * s, s, { bold: selected });
  });

  if (ref) { ctx.restore(); return; }
  if (o.printPages) {
    ctx.save();
    o.printPages.forEach((pg, i) => {
      const b = pageBounds(pg);
      const x0 = tf.x(b.minLon), y0 = tf.y(b.maxLat), w = tf.x(b.maxLon) - x0, h = tf.y(b.minLat) - y0;
      ctx.fillStyle = 'rgba(0,90,200,0.08)'; ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = '#005ac8'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(x0, y0, w, h); ctx.setLineDash([]);
      if (o.printPages.length > 1) drawLabel(ctx, 'Seite ' + (i + 1), x0 + 6, y0 + 11, 1, { bold: true });
    });
    ctx.restore();
  }
  if (o.marker) {
    const x = tf.x(o.marker.lon), y = tf.y(o.marker.lat);
    drawPin(ctx, x, y, s, '#e6007e', false);
    drawLabel(ctx, o.marker.label, x + 9 * s, y - 13 * s, s, { bold: true });
  }
  if (o.hoverPoint) dot(ctx, tf.x(o.hoverPoint.lon), tf.y(o.hoverPoint.lat), 6 * s, '#ffd400', '#000', 2 * s);
}

/** Scale bar in the lower left corner of a map. */
export function drawScaleBar(ctx, view, s = 1, margin = 12) {
  const sb = scaleBar(view.center.lat, view.zoom, 140 * s);
  const x = margin * s, y = view.height - margin * s;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(x - 4 * s, y - 20 * s, sb.px + 8 * s, 24 * s);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5 * s;
  ctx.beginPath(); ctx.moveTo(x, y - 6 * s); ctx.lineTo(x, y); ctx.lineTo(x + sb.px, y); ctx.lineTo(x + sb.px, y - 6 * s); ctx.stroke();
  ctx.font = `${11 * s}px system-ui, "Segoe UI", sans-serif`; ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(sb.label, x + sb.px / 2, y - 6 * s);
  ctx.restore();
}

/** Attribution text in the lower right corner (required by the tile licences). */
export function drawAttribution(ctx, view, text, s = 1) {
  if (!text) return;
  ctx.save();
  ctx.font = `${10 * s}px system-ui, "Segoe UI", sans-serif`;
  const w = ctx.measureText(text).width + 8 * s;
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillRect(view.width - w, view.height - 15 * s, w, 15 * s);
  ctx.fillStyle = '#222'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(text, view.width - 4 * s, view.height - 7.5 * s);
  ctx.restore();
}

/**
 * Coordinate grid and/or corner coordinates in the chosen format.
 * @param {object} o  format, grid (lines + edge labels), corners (corner coordinates), scale
 */
export function drawGrid(ctx, tf, o = {}) {
  if (!o.grid && !o.corners) return;
  const s = o.scale || 1, { width, height } = tf.view;
  const nw = tf.toLatLon(0, 0), se = tf.toLatLon(width, height);
  const bounds = { minLat: se.lat, maxLat: nw.lat, minLon: nw.lon, maxLon: se.lon };
  const format = o.format || 'dd';
  ctx.save();
  if (o.grid) {
    const g = buildGrid(bounds, format, width / s, 130);
    const top = (o.corners ? 26 : 10) * s, bottom = height - (o.corners ? 40 : 26) * s;
    const labels = [];
    /** Screen position where a projected polyline crosses the line x=c (axis 0) or y=c (axis 1). */
    const crossing = (pts, axis, c) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1][axis], b = pts[i][axis];
        if ((a - c) * (b - c) <= 0 && a !== b) { const t = (c - a) / (b - a); return pts[i - 1][1 - axis] + (pts[i][1 - axis] - pts[i - 1][1 - axis]) * t; }
      }
      return null;
    };
    ctx.lineJoin = 'round';
    for (const pass of [{ style: 'rgba(255,255,255,0.55)', w: 2.6 }, { style: 'rgba(20,20,60,0.55)', w: 0.9 }]) {
      ctx.strokeStyle = pass.style; ctx.lineWidth = pass.w * s;
      ctx.beginPath();
      for (const l of g.lines) l.points.forEach((p, i) => { const x = tf.x(p.lon), y = tf.y(p.lat); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
    for (const l of g.lines) {
      const pts = l.points.map((p) => [tf.x(p.lon), tf.y(p.lat)]);
      if (l.axis === 'x') {
        const xt = crossing(pts, 1, 0), xb = crossing(pts, 1, height);
        if (xt !== null && xt > 60 * s && xt < width - 60 * s) labels.push([l.label, xt, top, 'center']);
        if (xb !== null && xb > 210 * s && xb < width - 60 * s) labels.push([l.label, xb, bottom, 'center']); // keep clear of the scale bar
      } else {
        const yl = crossing(pts, 0, 0), yr = crossing(pts, 0, width);
        if (yl !== null && yl > 44 * s && yl < height - 54 * s) labels.push([l.label, 5 * s, yl - 8 * s, 'left']);
        if (yr !== null && yr > 44 * s && yr < height - 54 * s) labels.push([l.label, width - 5 * s, yr - 8 * s, 'right']);
      }
    }
    for (const [text, x, y, align] of labels) drawLabel(ctx, text, x, y, s * 0.88, { align });
  }
  if (o.corners) {
    const c = cornerLabels(bounds, format), m = 6 * s;
    drawLabel(ctx, c.nw, m, 10 * s, s * 0.88, { align: 'left', bold: true });
    drawLabel(ctx, c.ne, width - m, 10 * s, s * 0.88, { align: 'right', bold: true });
    drawLabel(ctx, c.sw, m, height - 34 * s, s * 0.88, { align: 'left', bold: true });
    drawLabel(ctx, c.se, width - m, height - 24 * s, s * 0.88, { align: 'right', bold: true });
  }
  ctx.restore();
}

/** Start/destination flags while a navigation route is being picked. */
export function drawNav(ctx, tf, nav) {
  if (!nav) return;
  for (const [p, color, text] of [[nav.start, '#18a418', 'Start'], [nav.end, '#d01818', 'Ziel']]) {
    if (!p) continue;
    const x = tf.x(p.lon), y = tf.y(p.lat);
    drawPin(ctx, x, y, 1.15, color, false);
    drawLabel(ctx, p.name ? `${text}: ${p.name}` : text, x + 10, y - 15, 1, { bold: true });
  }
}

/** Preview of what the next click will create (route rubber band, waypoint pin). */
export function drawGhost(ctx, tf, ghost) {
  if (!ghost || !ghost.cursor) return;
  const x = tf.x(ghost.cursor.lon), y = tf.y(ghost.cursor.lat);
  ctx.save();
  if (ghost.from) {
    ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath(); ctx.moveTo(tf.x(ghost.from.lon), tf.y(ghost.from.lat)); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
  }
  if (ghost.kind === 'waypoint') { ctx.globalAlpha = 0.6; drawPin(ctx, x, y, 1, '#2b6fd6', false); }
  else dot(ctx, x, y, 4.5, '#fff', '#000', 2);
  if (ghost.label) { ctx.globalAlpha = 1; drawLabel(ctx, ghost.label, x + 12, y + 14, 0.9); }
  ctx.restore();
}
