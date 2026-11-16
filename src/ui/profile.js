// Elevation profile of the selected route/track (canvas chart, hover linked to the map).
import { state, on, findItem, select } from './store.js';
import { $, h } from './dom.js';
import { cumulativeDistance, formatDistance } from '../core/stats.js';
import { timeMs } from '../core/time.js';

let panel, canvas, info, data = null, mapRef;

export function initProfile(map) {
  mapRef = map;
  panel = $('#profile'); canvas = $('#profile-canvas'); info = $('#profile-info');
  on('select', update); on('change', update);
  new ResizeObserver(draw).observe(canvas);
  canvas.addEventListener('pointermove', (e) => hover(e));
  canvas.addEventListener('pointerleave', () => { state.hoverPoint = null; mapRef.requestRender(); info.textContent = data ? data.summary : ''; draw(); });
  canvas.addEventListener('click', (e) => {
    const i = indexAt(e); if (i < 0 || !data) return;
    const ref = data.refs[i];
    select({ type: data.type, id: data.id, segIndex: ref[0], pointIndex: ref[1] });
  });
  update();
}

function update() {
  const f = findItem();
  data = null;
  if (f && f.type !== 'waypoint') {
    const segs = f.type === 'route' ? [f.item.points] : f.item.segments.map((s) => s.points);
    const pts = [], refs = [];
    segs.forEach((s, si) => s.forEach((p, pi) => { pts.push(p); refs.push([si, pi]); }));
    if (pts.length > 1) {
      const dist = cumulativeDistance(pts);
      const hasEle = pts.filter((p) => Number.isFinite(p.ele)).length > 1;
      data = { type: f.type, id: f.item.id, pts, refs, dist, hasEle, total: dist[dist.length - 1],
        summary: hasEle ? '' : 'Keine Höhendaten – „Höhen laden“ ergänzt sie aus dem Geländemodell.' };
    }
  }
  panel.hidden = !data;
  if (data) info.textContent = data.summary;
  draw();
  mapRef.resize();
}

const PAD = { l: 46, r: 10, t: 8, b: 20 };

function indexAt(e) {
  if (!data) return -1;
  const r = canvas.getBoundingClientRect();
  const d = ((e.clientX - r.left - PAD.l) / (r.width - PAD.l - PAD.r)) * data.total;
  let lo = 0, hi = data.dist.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (data.dist[m] < d) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(data.dist[lo - 1] - d) < Math.abs(data.dist[lo] - d)) lo--;
  return lo;
}

function hover(e) {
  const i = indexAt(e); if (i < 0) return;
  const p = data.pts[i];
  state.hoverPoint = p; mapRef.requestRender();
  info.textContent = [formatDistance(data.dist[i]), Number.isFinite(p.ele) ? Math.round(p.ele) + ' m' : null,
    Number.isFinite(timeMs(p)) ? new Date(timeMs(p)).toLocaleTimeString('de-AT') : null, p.name || null].filter(Boolean).join(' · ');
  draw(i);
}

function niceStep(range, target) {
  const raw = range / target, pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw) || pow;
}

function draw(hoverIndex = -1) {
  if (!canvas || panel.hidden || !data) return;
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (r.width < 10) return;
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(canvas);
  const fg = css.getPropertyValue('--fg').trim() || '#222', grid = css.getPropertyValue('--line').trim() || '#ccc';
  const W = r.width - PAD.l - PAD.r, H = r.height - PAD.t - PAD.b;
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = fg; ctx.strokeStyle = grid; ctx.lineWidth = 1;
  const X = (d) => PAD.l + (d / data.total) * W;
  // x axis
  const xs = niceStep(data.total, Math.max(2, Math.floor(W / 90)));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let d = 0; d <= data.total; d += xs) {
    ctx.beginPath(); ctx.moveTo(X(d), PAD.t); ctx.lineTo(X(d), PAD.t + H); ctx.stroke();
    ctx.fillText(xs >= 1000 ? (d / 1000) + ' km' : d + ' m', X(d), PAD.t + H + 4);
  }
  if (!data.hasEle) return;
  let lo = Infinity, hi = -Infinity;
  for (const p of data.pts) if (Number.isFinite(p.ele)) { if (p.ele < lo) lo = p.ele; if (p.ele > hi) hi = p.ele; }
  if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
  const ys = niceStep(hi - lo, Math.max(2, Math.floor(H / 28)));
  lo = Math.floor(lo / ys) * ys; hi = Math.ceil(hi / ys) * ys;
  const Y = (e) => PAD.t + H - ((e - lo) / (hi - lo)) * H;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let e = lo; e <= hi + 1e-9; e += ys) {
    ctx.beginPath(); ctx.moveTo(PAD.l, Y(e)); ctx.lineTo(PAD.l + W, Y(e)); ctx.stroke();
    ctx.fillText(Math.round(e) + ' m', PAD.l - 5, Y(e));
  }
  // profile line (decimated to ~2 points per pixel)
  const stride = Math.max(1, Math.floor(data.pts.length / (W * 2)));
  ctx.beginPath();
  let started = false, lastX = PAD.l;
  for (let i = 0; i < data.pts.length; i += (i + stride >= data.pts.length && i !== data.pts.length - 1 ? data.pts.length - 1 - i : stride)) {
    const e = data.pts[i].ele; if (!Number.isFinite(e)) continue;
    const x = X(data.dist[i]), y = Y(e);
    if (!started) { ctx.moveTo(x, PAD.t + H); ctx.lineTo(x, y); started = true; } else ctx.lineTo(x, y);
    lastX = x;
  }
  ctx.lineTo(lastX, PAD.t + H); ctx.closePath();
  ctx.fillStyle = 'rgba(31,119,180,0.25)'; ctx.fill();
  ctx.strokeStyle = '#1f77b4'; ctx.lineWidth = 1.5; ctx.stroke();
  const mark = hoverIndex >= 0 ? hoverIndex : (state.selection && Number.isInteger(state.selection.pointIndex)
    ? data.refs.findIndex((ref) => ref[0] === (state.selection.segIndex || 0) && ref[1] === state.selection.pointIndex) : -1);
  if (mark >= 0) {
    const x = X(data.dist[mark]);
    ctx.strokeStyle = fg; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + H); ctx.stroke();
    const e = data.pts[mark].ele;
    if (Number.isFinite(e)) { ctx.beginPath(); ctx.arc(x, Y(e), 4, 0, 2 * Math.PI); ctx.fillStyle = '#ffd400'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke(); }
  }
}
