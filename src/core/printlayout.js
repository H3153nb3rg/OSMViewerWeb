// Print layout: find the ideal map cut-out(s) for a route/track on paper.
//
// Two strategies (both pure functions, the browser only renders the result):
//   fitPage()      one page; orientation and (fractional) zoom chosen so the
//                  geometry fills the printable area as tightly as possible.
//   layoutPages()  fixed map scale (e.g. 1:50 000); the path is cut into as few
//                  pages as possible, each page portrait or landscape as needed.
//
// All sizes in "page pixels" = millimetres * dpi / 25.4. A page is described by
// {orientation, widthPx, heightPx, center:{lat,lon}, zoom, scale} — exactly what
// the map renderer needs.

import { mercX, mercY, invMercX, invMercY, worldSize, groundResolution, zoomForResolution, bboxOf, bboxCenter } from './geo.js';

export const PAPER_SIZES = { A5: [148, 210], A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
export const COMMON_SCALES = [10000, 15000, 25000, 35000, 50000, 75000, 100000, 150000, 200000, 250000, 500000, 1000000];

const mmToPx = (mm, dpi) => (mm * dpi) / 25.4;

/** Page geometry in pixels for a paper size, orientation and margins. */
export function pageGeometry({ paper = 'A4', orientation = 'portrait', marginMm = 10, headerMm = 8, dpi = 150 } = {}) {
  const size = PAPER_SIZES[paper] || PAPER_SIZES.A4;
  const [w, h] = orientation === 'landscape' ? [size[1], size[0]] : size;
  return {
    paper, orientation, dpi, marginMm, headerMm, pageWidthMm: w, pageHeightMm: h,
    widthPx: Math.round(mmToPx(w - 2 * marginMm, dpi)),            // map area
    heightPx: Math.round(mmToPx(h - 2 * marginMm - headerMm, dpi)),
  };
}

/** Map scale denominator (1:N) of a page rendered at `zoom` for latitude `lat`. */
export const scaleAt = (lat, zoom, dpi) => (groundResolution(lat, zoom) * dpi) / 0.0254;
/** Zoom level that prints at scale 1:N at latitude `lat`. */
export const zoomForScale = (lat, scale, dpi) => zoomForResolution(lat, (scale * 0.0254) / dpi);

function mercBox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    const x = mercX(p.lon), y = mercY(p.lat);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Single page that shows all points as large as possible.
 * @param {object[]} points  {lat, lon}[]
 * @param {object} opts  paper, orientation ('auto'|'portrait'|'landscape'), marginMm, headerMm, dpi,
 *                       paddingMm (free space around the geometry), maxZoom, roundScale (snap to a "nice" scale)
 */
export function fitPage(points, opts = {}) {
  const { orientation = 'auto', paddingMm = 8, maxZoom = 19, roundScale = false, dpi = 150 } = opts;
  if (!points || !points.length) return null;
  const box = mercBox(points);
  const pad = mmToPx(paddingMm, dpi) * 2;
  const candidates = (orientation === 'auto' ? ['portrait', 'landscape'] : [orientation]).map((o) => {
    const g = pageGeometry({ ...opts, orientation: o, dpi });
    const availW = Math.max(16, g.widthPx - pad), availH = Math.max(16, g.heightPx - pad);
    const bw = Math.max(box.x1 - box.x0, 1e-12), bh = Math.max(box.y1 - box.y0, 1e-12);
    const zoom = Math.log2(Math.min(availW / (bw * 256), availH / (bh * 256)));
    return { g, zoom };
  });
  candidates.sort((a, b) => b.zoom - a.zoom);
  let { g, zoom } = candidates[0];
  zoom = Math.min(zoom, maxZoom + 0.5);
  const center = { lat: invMercY((box.y0 + box.y1) / 2), lon: invMercX((box.x0 + box.x1) / 2) };
  if (roundScale) {
    const s = scaleAt(center.lat, zoom, dpi);
    const nice = COMMON_SCALES.find((c) => c >= s);
    if (nice) zoom = zoomForScale(center.lat, nice, dpi);
  }
  return { ...g, center, zoom, scale: scaleAt(center.lat, zoom, dpi) };
}

/**
 * Cut a path into pages at a fixed scale. Greedy along the path: a page grows
 * until the covered stretch no longer fits either orientation.
 * @param {object[]} points  ordered path {lat, lon}[]
 * @param {object} opts  scale (1:N), paper, marginMm, headerMm, dpi, paddingMm, orientation
 * @returns {object[]} pages (same shape as fitPage) with fromIndex/toIndex
 */
export function layoutPages(points, opts = {}) {
  const { scale = 50000, orientation = 'auto', paddingMm = 8, dpi = 150, maxPages = 60 } = opts;
  if (!points || !points.length) return [];
  const mid = bboxCenter(bboxOf(points));
  const zoom = zoomForScale(mid.lat, scale, dpi);
  const ws = worldSize(zoom);
  const pad = mmToPx(paddingMm, dpi) * 2;
  const geoms = (orientation === 'auto' ? ['portrait', 'landscape'] : [orientation]).map((o) => pageGeometry({ ...opts, orientation: o, dpi }));
  const fits = (w, h) => geoms.filter((g) => w <= g.widthPx - pad && h <= g.heightPx - pad);
  const xs = points.map((p) => mercX(p.lon) * ws), ys = points.map((p) => mercY(p.lat) * ws);
  const pages = [];
  let i = 0;
  while (i < points.length && pages.length < maxPages) {
    let x0 = xs[i], x1 = xs[i], y0 = ys[i], y1 = ys[i], j = i, ok = fits(0, 0);
    while (j + 1 < points.length) {
      const nx0 = Math.min(x0, xs[j + 1]), nx1 = Math.max(x1, xs[j + 1]), ny0 = Math.min(y0, ys[j + 1]), ny1 = Math.max(y1, ys[j + 1]);
      const f = fits(nx1 - nx0, ny1 - ny0);
      if (!f.length) break;
      x0 = nx0; x1 = nx1; y0 = ny0; y1 = ny1; ok = f; j++;
    }
    // prefer the orientation that matches the covered stretch
    const wide = x1 - x0 >= y1 - y0;
    const g = ok.find((c) => (c.orientation === 'landscape') === wide) || ok[0] || geoms[0];
    const center = { lat: invMercY((y0 + y1) / 2 / ws), lon: invMercX((x0 + x1) / 2 / ws) };
    pages.push({ ...g, center, zoom, scale: scaleAt(center.lat, zoom, dpi), fromIndex: i, toIndex: j });
    if (j >= points.length - 1) break;
    i = j === i ? i + 1 : j; // the last point of a page starts the next one (continuity)
  }
  return pages;
}

/** Geographic bounds covered by a page (for preview rectangles on the map). */
export function pageBounds(page) {
  const ws = worldSize(page.zoom);
  const cx = mercX(page.center.lon) * ws, cy = mercY(page.center.lat) * ws;
  return {
    minLon: invMercX((cx - page.widthPx / 2) / ws), maxLon: invMercX((cx + page.widthPx / 2) / ws),
    maxLat: invMercY((cy - page.heightPx / 2) / ws), minLat: invMercY((cy + page.heightPx / 2) / ws),
  };
}

/** Pick a round scale-bar length (metres) close to targetPx wide. */
export function scaleBar(lat, zoom, targetPx = 150) {
  const res = groundResolution(lat, zoom);
  const raw = res * targetPx;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((k) => k * pow).filter((v) => v <= raw).pop() || pow;
  return { metres: nice, px: nice / res, label: nice >= 1000 ? nice / 1000 + ' km' : nice + ' m' };
}
