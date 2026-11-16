// Slippy map on a <canvas>: raster tiles in Web Mercator with fractional zoom,
// mouse/touch navigation and a hook for vector overlays. No map library.
//
// The same drawing code serves the interactive view and the print renderer
// (renderStatic), so what is printed is what the layout computed.

import { mercX, mercY, invMercX, invMercY, worldSize, clamp, TILE_SIZE } from '../core/geo.js';
import { requestUrl } from '../core/tilesources.js';

/** Projection helpers for a view {width, height, center:{lat,lon}, zoom}. */
export function viewTransform(view) {
  const ws = worldSize(view.zoom);
  const ox = mercX(view.center.lon) * ws - view.width / 2;
  const oy = mercY(view.center.lat) * ws - view.height / 2;
  return {
    ws, ox, oy, view,
    x: (lon) => mercX(lon) * ws - ox,
    y: (lat) => mercY(lat) * ws - oy,
    toLatLon: (x, y) => ({ lat: invMercY((y + oy) / ws), lon: invMercX((x + ox) / ws) }),
  };
}

let viaLocalServer = false;
/** Route catalogue tiles through the local caching server ('' = same origin, null = direct). */
/** Route tiles through the local disk cache (serve.mjs) once it has been detected. */
export function useLocalServer(on) { viaLocalServer = !!on; }

/** In-memory tile cache with LRU eviction. Images load with CORS first, then without. */
export class TileCache {
  constructor(max = 700) { this.max = max; this.map = new Map(); this.listeners = new Set(); }
  key(source, z, x, y) { return `${source.id}/${z}/${x}/${y}`; }
  peek(source, z, x, y) { const t = this.map.get(this.key(source, z, x, y)); return t && t.ready ? t : null; }
  /** Returns the tile record {img, ready, failed, promise}; starts loading on first request. */
  get(source, z, x, y) {
    const k = this.key(source, z, x, y);
    let t = this.map.get(k);
    if (t) { this.map.delete(k); this.map.set(k, t); return t; }
    t = { img: null, ready: false, failed: false, promise: null };
    t.promise = new Promise((resolve) => {
      const url = requestUrl(source, z, x, y, viaLocalServer);
      if (!url) { t.failed = true; resolve(t); return; }
      const attempt = (cors) => {
        const img = new Image();
        if (cors) img.crossOrigin = 'anonymous';
        img.onload = () => { t.img = img; t.ready = true; t.tainted = !cors; resolve(t); this.listeners.forEach((fn) => fn(t)); };
        img.onerror = () => { if (cors) attempt(false); else { t.failed = true; resolve(t); } };
        img.src = url;
      };
      attempt(true);
    });
    this.map.set(k, t);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return t;
  }
}

/** Tile zoom level used to draw a (fractional) view zoom. */
export function tileZoomFor(source, zoom, detail = 0) {
  return clamp(Math.round(zoom + detail), source.minZoom || 0, source.maxZoom || 19);
}

/**
 * Draw one tile layer. Missing tiles are requested; meanwhile a cached ancestor is drawn magnified.
 * @returns {Promise[]} pending tile loads
 */
export function drawTiles(ctx, view, source, cache, { detail = 0, opacity = 1 } = {}) {
  const tz = tileZoomFor(source, view.zoom, detail);
  const scale = 2 ** (view.zoom - tz);              // screen px per tile px
  const size = TILE_SIZE * scale;
  const ws = worldSize(view.zoom);
  const ox = mercX(view.center.lon) * ws - view.width / 2, oy = mercY(view.center.lat) * ws - view.height / 2;
  const n = 2 ** tz;
  const x0 = Math.floor(ox / size), x1 = Math.floor((ox + view.width) / size);
  const y0 = Math.max(0, Math.floor(oy / size)), y1 = Math.min(n - 1, Math.floor((oy + view.height) / size));
  const pending = [];
  ctx.save();
  ctx.globalAlpha = opacity;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const dx = Math.round(tx * size - ox), dy = Math.round(ty * size - oy);
      const dw = Math.round((tx + 1) * size - ox) - dx, dh = Math.round((ty + 1) * size - oy) - dy;
      const wx = ((tx % n) + n) % n;
      const t = cache.get(source, tz, wx, ty);
      if (t.ready) { ctx.drawImage(t.img, dx, dy, dw, dh); continue; }
      if (!t.failed) pending.push(t.promise);
      for (let up = 1; up <= 5 && tz - up >= 0; up++) { // ancestor fallback
        const a = cache.peek(source, tz - up, wx >> up, ty >> up);
        if (!a) continue;
        const f = 2 ** up, sub = TILE_SIZE / f;
        ctx.drawImage(a.img, (wx % f) * sub, (ty % f) * sub, sub, sub, dx, dy, dw, dh);
        break;
      }
    }
  }
  ctx.restore();
  return pending;
}

/**
 * Render a complete static map (all tiles loaded) — used for printing/export.
 * @param {(ctx, transform) => void} [drawOverlay]
 */
export async function renderStatic(ctx, view, layers, cache, { detail = 0, drawOverlay, background = '#e8e8e8' } = {}) {
  const paint = () => {
    ctx.fillStyle = background; ctx.fillRect(0, 0, view.width, view.height);
    return layers.flatMap((l) => drawTiles(ctx, view, l.source, cache, { detail, opacity: l.opacity ?? 1 }));
  };
  for (let round = 0; round < 3; round++) { // retries pick up tiles that were still loading
    const pending = paint();
    if (!pending.length) break;
    await Promise.all(pending);
  }
  paint();
  if (drawOverlay) drawOverlay(ctx, viewTransform(view));
}

/** Interactive map view bound to a canvas element. */
export class MapView {
  constructor(canvas, { cache = new TileCache() } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.cache = cache;
    this.center = { lat: 47.6, lon: 13.3 }; this.zoom = 7;
    this.base = null; this.overlay = null;
    this.width = 300; this.height = 150;
    this.handlers = {};      // onDraw, onViewChange, onPointerDown/Move/Up, onClick, onDblClick, onContextMenu, onHover
    this._raf = 0; this._pointers = new Map(); this._drag = null;
    cache.listeners.add(() => this.requestRender());
    new ResizeObserver(() => this.resize()).observe(canvas);
    this._bind();
    this.resize();
  }
  get view() { return { width: this.width, height: this.height, center: this.center, zoom: this.zoom }; }
  get transform() { return viewTransform(this.view); }
  get maxZoom() { return (this.base ? this.base.maxZoom || 19 : 19) + 2; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, r.width); this.height = Math.max(1, r.height);
    this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr);
    this.render();
  }
  setLayers(base, overlay) { this.base = base; this.overlay = overlay || null; this.zoom = Math.min(this.zoom, this.maxZoom); this.requestRender(); }
  setView(center, zoom) {
    this.center = { lat: clamp(center.lat, -85, 85), lon: ((center.lon + 540) % 360) - 180 };
    if (zoom !== undefined) this.zoom = clamp(zoom, 1, this.maxZoom);
    this.requestRender();
    if (this.handlers.onViewChange) this.handlers.onViewChange();
  }
  /** Zoom keeping the geographic position under screen point (x, y) fixed. */
  zoomAround(x, y, newZoom) {
    const z = clamp(newZoom, 1, this.maxZoom);
    const anchor = this.transform.toLatLon(x, y);
    const ws = worldSize(z);
    const cx = mercX(anchor.lon) * ws - (x - this.width / 2), cy = mercY(anchor.lat) * ws - (y - this.height / 2);
    this.setView({ lat: invMercY(cy / ws), lon: invMercX(cx / ws) }, z);
  }
  fitBounds(b, padding = 50) {
    if (!b) return;
    const w = Math.max(mercX(b.maxLon) - mercX(b.minLon), 1e-9), h = Math.max(mercY(b.minLat) - mercY(b.maxLat), 1e-9);
    const z = Math.log2(Math.min((this.width - 2 * padding) / (w * TILE_SIZE), (this.height - 2 * padding) / (h * TILE_SIZE)));
    const cy = (mercY(b.minLat) + mercY(b.maxLat)) / 2;
    this.setView({ lat: invMercY(cy), lon: (b.minLon + b.maxLon) / 2 }, Math.min(z, Math.min(17, this.maxZoom)));
  }
  requestRender() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); }); }
  render() {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#dfe3e6'; ctx.fillRect(0, 0, this.width, this.height);
    if (this.base) drawTiles(ctx, this.view, this.base, this.cache);
    if (this.overlay) drawTiles(ctx, this.view, this.overlay, this.cache);
    if (this.handlers.onDraw) this.handlers.onDraw(ctx, this.transform);
  }

  _pos(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  _bind() {
    const c = this.canvas, h = () => this.handlers;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      c.setPointerCapture(e.pointerId);
      const [x, y] = this._pos(e);
      this._pointers.set(e.pointerId, [x, y]);
      if (this._pointers.size === 2) { // start pinch
        const [a, b] = [...this._pointers.values()];
        this._pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.zoom };
        this._drag = null; return;
      }
      const captured = h().onPointerDown ? h().onPointerDown(e, x, y) === true : false;
      this._drag = { x0: x, y0: y, x, y, captured, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = this._pos(e);
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, [x, y]);
      if (this._pinch && this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.zoomAround((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, this._pinch.zoom + Math.log2(d / this._pinch.dist));
        return;
      }
      const d = this._drag;
      if (!d) { if (h().onHover) h().onHover(e, x, y); return; }
      if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
      d.moved = true;
      if (d.captured) { if (h().onPointerMove) h().onPointerMove(e, x, y); }
      else { // pan
        const ws = worldSize(this.zoom);
        const cx = mercX(this.center.lon) * ws - (x - d.x), cy = mercY(this.center.lat) * ws - (y - d.y);
        this.setView({ lat: invMercY(cy / ws), lon: invMercX(cx / ws) });
      }
      d.x = x; d.y = y;
    });
    const end = (e) => {
      const [x, y] = this._pos(e);
      this._pointers.delete(e.pointerId);
      if (this._pinch) { if (this._pointers.size < 2) this._pinch = null; this._drag = null; return; }
      const d = this._drag; this._drag = null;
      if (!d) return;
      if (d.captured && h().onPointerUp) h().onPointerUp(e, x, y, d.moved);
      if (!d.moved && e.type === 'pointerup' && h().onClick) h().onClick(e, x, y, d.captured);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this._pos(e);
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomAround(x, y, this.zoom - clamp(delta * (e.ctrlKey ? 0.01 : 0.0025), -0.6, 0.6));
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const [x, y] = this._pos(e);
      if (h().onDblClick && h().onDblClick(e, x, y) === true) return;
      this.zoomAround(x, y, Math.round(this.zoom) + (e.shiftKey ? -1 : 1));
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = this._pos(e);
      if (h().onContextMenu) h().onContextMenu(e, x, y);
    });
    c.addEventListener('pointerleave', () => { if (h().onHover) h().onHover(null); });
  }
}
