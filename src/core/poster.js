// Poster export: a route or track on a simplified map as a vector graphic.
//
// Pure functions producing an SVG string — the browser only supplies the map
// data and saves the result. The output is vector data in millimetres, so it
// prints at any size without loss.
//
// Map background, one of:
//   vector tiles   OpenMapTiles schema, reduced to a few quiet layers ("Straße"),
//                  or with paths, streams, rock/ice, peaks and contour lines ("Topo")
//   backdrop       a raster image of ordinary map tiles (limited print size)
//   nothing        the route alone

import { mercX, mercY, invMercX, invMercY, rad } from './geo.js';
import { simplifyPoints } from './simplify.js';
import { formatCoordinate } from './coords.js';

export const POSTER_SIZES = {
  A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189],
  '30 × 40 cm': [300, 400], '40 × 50 cm': [400, 500], '50 × 70 cm': [500, 700], '70 × 100 cm': [700, 1000], 'Quadrat 50 cm': [500, 500],
};

export const POSTER_THEMES = {
  hell:      { name: 'Hellgrau',            paper: '#f3f1ec', land: '#f3f1ec', water: '#d5dde0', wood: '#e8eadf', road: '#c9c5bb', boundary: '#a9a59b', label: '#77736a', route: '#c8452c', text: '#2b2a27', muted: '#8d897f', frame: '#2b2a27', contour: '#d9d3c5', rock: '#e6e2d9', ice: '#f9fbfc', path: '#a39c8d' },
  topo:      { name: 'Topografisch',        paper: '#f7f4ea', land: '#f7f4ea', water: '#b9d2e0', wood: '#dde7cc', road: '#bcb3a2', boundary: '#9c8fa8', label: '#5f5a4e', route: '#d0342c', text: '#2d2a24', muted: '#8b8371', frame: '#2d2a24', contour: '#cfa77c', rock: '#e4ded2', ice: '#eef6fa', path: '#7d6146' },
  tusche:    { name: 'Tusche',              paper: '#faf8f3', land: '#faf8f3', water: '#c9d6d8', wood: '#e3e8da', road: '#b9b3a6', boundary: '#8f8a7e', label: '#5e5a52', route: '#1f3a4d', text: '#1f2a30', muted: '#8a8478', frame: '#1f2a30', contour: '#d6d0c2', rock: '#e9e5dc', ice: '#ffffff', path: '#8f897c' },
  pergament: { name: 'Pergament',           paper: '#ead9b8', land: '#ead9b8', water: '#bfc9b4', wood: '#dccb9f', road: '#b49a6c', boundary: '#8c7447', label: '#6b5631', route: '#7a2d1c', text: '#3d2f18', muted: '#927b50', frame: '#3d2f18', contour: '#cdb586', rock: '#dfcba3', ice: '#f3e9d2', path: '#8c7447' },
  schwarzweiss: { name: 'Schwarz auf Weiß', paper: '#ffffff', land: '#ffffff', water: '#e6e6e6', wood: '#f4f4f4', road: '#bdbdbd', boundary: '#8a8a8a', label: '#555555', route: '#000000', text: '#000000', muted: '#8a8a8a', frame: '#000000', contour: '#d4d4d4', rock: '#efefef', ice: '#fafafa', path: '#8f8f8f' },
  nacht:     { name: 'Weiß auf Schwarz',    paper: '#111315', land: '#111315', water: '#23292e', wood: '#161a18', road: '#3c4247', boundary: '#5c6369', label: '#9aa1a7', route: '#ffffff', text: '#f2f2f2', muted: '#7d848a', frame: '#f2f2f2', contour: '#2b3035', rock: '#1b1e21', ice: '#262b30', path: '#565d63' },
  seekarte:  { name: 'Seekarte',            paper: '#fbf6e6', land: '#f3e7c1', water: '#cfe3ee', wood: '#e6dcae', road: '#c2ab7a', boundary: '#9a8556', label: '#5b5236', route: '#b3261e', text: '#22303a', muted: '#8a7f5e', frame: '#22303a', contour: '#dccb97', rock: '#eadcb0', ice: '#fbf6e6', path: '#9a8556' },
};

/** Page layouts ("designs"). */
export const POSTER_DESIGNS = {
  galerie:  'Galerie – Karte im Rahmen, Titel darunter',
  karte:    'Karte – randlose Karte, Angaben auf einer Karte',
  atlas:    'Atlas – Doppelrahmen mit Gradeinteilung',
  kompass:  'Kompass – runde Karte im Gradring',
  horizont: 'Horizont – randlose Karte, läuft in den Titel aus',
};

export const POSTER_FONTS = {
  klassisch:       { name: 'Klassisch',       family: "'Helvetica Neue', Helvetica, Arial, 'Segoe UI', sans-serif", weight: 700, spacing: 0.19, caps: true, width: 0.68 },
  elegant:         { name: 'Elegant',         family: "Didot, 'Bodoni MT', 'Playfair Display', Georgia, 'Times New Roman', serif", weight: 400, spacing: 0.24, caps: true, width: 0.66 },
  kraeftig:        { name: 'Kräftig',         family: "'Arial Black', Impact, 'Helvetica Neue', Arial, sans-serif", weight: 900, spacing: 0.05, caps: true, width: 0.8 },
  journal:         { name: 'Journal',         family: "Georgia, 'Times New Roman', serif", weight: 400, spacing: 0.02, caps: false, italic: true, width: 0.52 },
  schreibmaschine: { name: 'Schreibmaschine', family: "'Courier New', Courier, monospace", weight: 700, spacing: 0.1, caps: true, width: 0.6 },
};

/** Layers the poster reads from a vector tile. */
export const POSTER_LAYERS = ['water', 'waterway', 'landcover', 'boundary', 'transportation', 'place', 'mountain_peak'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (v) => (Math.round(v * 100) / 100).toString();
const EARTH = 40075016.686;

/**
 * Page geometry and map projection.
 * @param {object[]} points  all points that must be visible ({lat, lon})
 * @param {object} o  size ([w, h] mm), orientation 'auto'|'portrait'|'landscape', design, textBlock, profile, padding (0..0.4)
 * Result: W, H, unit (1/1000 of the short side), frame (map extent), fit (area the route is fitted into),
 *         clip ('rect' | 'circle'), text / profileBox / card boxes, x(lon), y(lat), bounds, scale …
 */
export function posterLayout(points, { size = POSTER_SIZES.A3, orientation = 'auto', design = 'galerie', textBlock = true, profile = false, padding = 0.12 } = {}) {
  if (!points || !points.length) return null;
  if (!POSTER_DESIGNS[design]) design = 'galerie';
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) { const x = mercX(p.lon), y = mercY(p.lat); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const bw = Math.max(x1 - x0, 1e-9), bh = Math.max(y1 - y0, 1e-9);
  const [a, b] = [Math.min(size[0], size[1]), Math.max(size[0], size[1])];
  const candidates = (orientation === 'auto' ? ['portrait', 'landscape'] : [orientation]).map((o) => {
    const W = o === 'landscape' ? b : a, H = o === 'landscape' ? a : b;
    const short = Math.min(W, H), m = short * 0.06, unit = short / 1000;
    const textH = textBlock ? short * 0.2 : 0, profileH = profile ? short * 0.075 : 0;
    const L = { design, orientation: o, W, H, unit, margin: m, textH, profileH, clip: 'rect', bleed: false, card: null, fade: null, circle: null };
    const below = { x: m, y: m, w: W - 2 * m, h: H - 2 * m - textH - profileH }; // classic: map above, text below
    if (design === 'galerie' || design === 'atlas') {
      if (design === 'atlas') {
        // The band between the two frames (see buildPosterSvg) must sit inside the map area,
        // otherwise its lower edge and degree labels spill into the profile/text block.
        const g = m * 0.5;
        L.frame = { x: below.x + g, y: below.y + g, w: below.w - 2 * g, h: below.h - 2 * g };
      } else L.frame = below;
      L.fit = L.frame;
      L.profileBox = profileH ? { x: m, y: below.y + below.h, w: below.w, h: profileH } : null;
      L.text = textH ? { x: m, y: below.y + below.h + profileH, w: below.w, h: textH } : null;
    } else if (design === 'kompass') {
      const ring = 36 * unit, r = Math.min(below.w, below.h) / 2 - ring;
      const cx = W / 2, cy = below.y + below.h / 2;
      L.circle = { cx, cy, r, ring }; L.clip = 'circle';
      L.frame = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
      const s = r * Math.SQRT2; L.fit = { x: cx - s / 2, y: cy - s / 2, w: s, h: s };
      L.profileBox = profileH ? { x: m, y: below.y + below.h, w: below.w, h: profileH } : null;
      L.text = textH ? { x: m, y: below.y + below.h + profileH, w: below.w, h: textH } : null;
    } else { // karte, horizont: the map covers the whole sheet
      L.bleed = true; L.frame = { x: 0, y: 0, w: W, h: H };
      if (design === 'karte') {
        const ch = textH + profileH, cw = Math.min(W - 2 * m, Math.max(short * 0.7, W * 0.55)), pad = ch ? 10 * unit : 0;
        L.card = ch ? { x: (W - cw) / 2, y: H - m - ch - 2 * pad, w: cw, h: ch + 2 * pad } : null;
        const top = L.card ? L.card.y : H - m;
        L.fit = { x: m, y: m, w: W - 2 * m, h: top - 2 * m };
        L.profileBox = profileH ? { x: L.card.x + pad, y: L.card.y + pad, w: cw - 2 * pad, h: profileH } : null;
        L.text = textH ? { x: L.card.x + pad, y: L.card.y + pad + profileH, w: cw - 2 * pad, h: textH } : null;
      } else {
        const zone = textH + profileH + (textH + profileH ? short * 0.16 : 0);
        L.fade = zone ? { y: H - zone - m, h: zone + m } : null;
        L.fit = { x: m, y: m, w: W - 2 * m, h: H - 2 * m - zone };
        L.profileBox = profileH ? { x: m, y: H - m - textH - profileH, w: W - 2 * m, h: profileH } : null;
        L.text = textH ? { x: m, y: H - m - textH, w: W - 2 * m, h: textH } : null;
      }
    }
    // furniture stays inside this box
    L.inner = L.bleed ? { x: m, y: m, w: W - 2 * m, h: L.fit.h } : L.frame;
    L.k = Math.min((L.fit.w * (1 - 2 * padding)) / bw, (L.fit.h * (1 - 2 * padding)) / bh); // mm per world unit
    return L;
  });
  candidates.sort((p, q) => q.k - p.k);
  const L = candidates[0];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // never zoom in beyond ~1:2000 on paper (single points, tiny tracks)
  L.k = Math.min(L.k, (EARTH * Math.cos(rad(invMercY(cy))) * 1000) / 2000);
  // world coordinates of the frame's top-left corner: the route's centre sits in the centre of `fit`
  L.ox = cx - (L.fit.x + L.fit.w / 2 - L.frame.x) / L.k;
  L.oy = cy - (L.fit.y + L.fit.h / 2 - L.frame.y) / L.k;
  L.x = (lon) => (mercX(lon) - L.ox) * L.k + L.frame.x;
  L.y = (lat) => (mercY(lat) - L.oy) * L.k + L.frame.y;
  L.bounds = { minLon: invMercX(L.ox), maxLon: invMercX(L.ox + L.frame.w / L.k), maxLat: invMercY(L.oy), minLat: invMercY(L.oy + L.frame.h / L.k) };
  L.center = { lat: invMercY(L.oy + L.frame.h / 2 / L.k), lon: invMercX(L.ox + L.frame.w / 2 / L.k) };
  L.metresPerMm = (EARTH * Math.cos(rad(invMercY(cy)))) / L.k;
  L.scale = L.metresPerMm * 1000; // 1 : scale
  return L;
}

/**
 * Vector tiles covering the map frame.
 * @param {number} across  desired number of tiles across the longer frame side (detail level)
 */
export function posterTiles(layout, across = 4, maxZoom = 14, maxTiles = 48) {
  const spanW = layout.frame.w / layout.k, spanH = layout.frame.h / layout.k;
  let z = Math.max(0, Math.min(maxZoom, Math.round(Math.log2(across / Math.max(spanW, spanH)))));
  for (;; z--) {
    const n = 2 ** z;
    const tx0 = Math.floor(layout.ox * n), tx1 = Math.floor((layout.ox + spanW) * n - 1e-9);
    const ty0 = Math.max(0, Math.floor(layout.oy * n)), ty1 = Math.min(n - 1, Math.floor((layout.oy + spanH) * n - 1e-9));
    const count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    if (count <= maxTiles || z === 0) {
      const tiles = [];
      for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) tiles.push({ z, x: ((x % n) + n) % n, y, col: x });
      return { z, tiles };
    }
  }
}

/**
 * Pixel size and tile zoom for a raster backdrop of the map frame.
 * The print size of a raster map is limited: tiles end at the source's maximum zoom.
 * @returns {{width, height, zoom, tileZoom, dpi, tiles}}  dpi = resolution the backdrop reaches on paper
 */
export function backdropSpec(layout, { maxZoom = 17, targetDpi = 150, maxPixels = 60e6, maxTiles = 900 } = {}) {
  const F = layout.frame;
  // zoom at which one tile pixel is one image pixel: world width in px = 256 * 2^z = (mm per world) * dpi / 25.4
  const zoomFor = (dpi) => Math.log2((layout.k * dpi) / 25.4 / 256);
  let tileZoom = Math.min(maxZoom, Math.ceil(zoomFor(targetDpi) - 0.3));
  let spec;
  for (;; tileZoom--) {
    const native = (256 * 2 ** tileZoom * 25.4) / layout.k; // resolution of this zoom level on paper
    const dpi = Math.min(native, targetDpi * 1.5);
    const width = Math.round((F.w / 25.4) * dpi), height = Math.round((F.h / 25.4) * dpi);
    const tiles = Math.ceil((F.w / 25.4) * native / 256 + 1) * Math.ceil((F.h / 25.4) * native / 256 + 1);
    spec = { width, height, tileZoom, zoom: zoomFor(dpi), dpi, tiles };
    if ((width * height <= maxPixels && tiles <= maxTiles) || tileZoom <= 1) break;
  }
  return spec;
}

const ROAD_CLASSES = [ // [class, minimum tile zoom, width in units, dash, minimum zoom in topo mode]
  ['motorway', 0, 1.7], ['trunk', 0, 1.4], ['primary', 7, 1.1], ['secondary', 9, 0.85], ['tertiary', 11, 0.65],
  ['minor', 13, 0.45, null, 12], ['service', 14, 0.35], ['rail', 10, 0.5, '3 1.5'], ['track', 13, 0.45, '2.4 1.2', 11], ['path', 13, 0.4, '1.3 1.1', 11],
];

function ringPath(rings, px, py) {
  let d = '';
  for (const ring of rings) {
    if (ring.length < 2) continue;
    let lx = null, ly = null;
    ring.forEach(([x, y], i) => {
      const X = n2(px(x)), Y = n2(py(y));
      if (i && X === lx && Y === ly) return; // drop vertices that collapse at print resolution
      d += (i ? 'L' : 'M') + X + ' ' + Y;
      lx = X; ly = Y;
    });
  }
  return d;
}

/** Greedy label placement: most important first, no overlaps, inside the map, clear of `avoid` boxes. */
function placeLabels(candidates, inside, avoid = []) {
  const placed = avoid.map((box) => ({ box }));
  const out = [];
  for (const c of candidates) {
    const w = c.text.length * c.size * 0.56, h = c.size * 1.25;
    const box = { x0: c.x - c.size * 0.4, y0: c.y - h / 2, x1: c.x + c.size * 0.45 + w, y1: c.y + h / 2 };
    if (![[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]].every(([x, y]) => inside(x, y))) continue;
    if (placed.some((p) => p.box.x0 < box.x1 && p.box.x1 > box.x0 && p.box.y0 < box.y1 && p.box.y1 > box.y0)) continue;
    placed.push({ box }); out.push(c);
  }
  return out;
}

function niceLength(maxMetres) {
  const pow = 10 ** Math.floor(Math.log10(maxMetres));
  return [5, 2, 1].map((k) => k * pow).find((v) => v <= maxMetres) || pow;
}

const DEG_STEPS = [1 / 60, 2 / 60, 5 / 60, 10 / 60, 15 / 60, 30 / 60, 1, 2, 5, 10, 20];
function degLabel(v, pos, neg) {
  const a = Math.abs(v) + 1e-9, d = Math.floor(a), m = Math.round((a - d) * 60);
  return `${m === 60 ? d + 1 : d}°${m && m !== 60 ? String(m).padStart(2, '0') + "'" : ''} ${v < 0 ? neg : pos}`;
}

/**
 * Build the poster.
 * @param {object} p
 *   layout     from posterLayout()
 *   lines      [[{lat, lon}, ...], ...]  route/track segments
 *   waypoints  [{lat, lon, name}]
 *   tiles      [{z, x, y, col?, layers}] decoded vector tiles
 *   contours   [{level, index, lines: [[{lat, lon}]]}] from core/contours.js
 *   backdrop   {href, attribution} raster image covering layout.frame (instead of vector tiles)
 *   theme      id of POSTER_THEMES or a theme object
 *   title, subtitle, stats: [{label, value}]
 *   options    { topo, roads, waterways, boundaries, forest, places, peaks, lang, compass, scaleBar, startEnd, coords,
 *                coordFormat, lineWidth (factor), font (id of POSTER_FONTS), profile: [{d, ele}] | null, attribution }
 * @returns {string} SVG document
 */
export function buildPosterSvg({ layout: L, lines = [], waypoints = [], tiles = [], contours = [], backdrop = null, theme = 'hell', title = '', subtitle = '', stats = [], options = {} }) {
  const T = typeof theme === 'string' ? POSTER_THEMES[theme] || POSTER_THEMES.hell : theme;
  const o = { topo: false, roads: true, waterways: true, boundaries: true, forest: true, places: true, peaks: true, lang: 'de', compass: true, scaleBar: true,
    startEnd: true, coords: false, coordFormat: 'dd', lineWidth: 1, font: 'klassisch', profile: null, attribution: '© OpenStreetMap-Mitwirkende · OpenMapTiles · OpenFreeMap', ...options };
  const FONT = POSTER_FONTS[o.font] || POSTER_FONTS.klassisch;
  const u = L.unit, F = L.frame, I = L.inner, C = L.circle;
  const font = `font-family="${FONT.family.replace(/"/g, "'")}"`;
  const sans = `font-family="'Helvetica Neue', Helvetica, Arial, 'Segoe UI', sans-serif"`; // map lettering stays neutral
  const inside = C ? (x, y) => Math.hypot(x - C.cx, y - C.cy) < C.r - 2 * u
    : (x, y) => x > I.x + 1 && y > I.y + 1 && x < I.x + I.w - 1 && y < I.y + I.h - 1;
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n2(L.W)}mm" height="${n2(L.H)}mm" viewBox="0 0 ${n2(L.W)} ${n2(L.H)}">`);
  out.push(`<title>${esc(title || 'Poster')}</title>`);
  const clipShape = C ? `<circle cx="${n2(C.cx)}" cy="${n2(C.cy)}" r="${n2(C.r)}"/>` : `<rect x="${n2(F.x)}" y="${n2(F.y)}" width="${n2(F.w)}" height="${n2(F.h)}"/>`;
  out.push(`<defs><clipPath id="map">${clipShape}</clipPath>`
    + (L.fade ? `<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.paper}" stop-opacity="0"/><stop offset="0.42" stop-color="${T.paper}" stop-opacity="0.93"/><stop offset="1" stop-color="${T.paper}"/></linearGradient>` : '')
    + `</defs>`);
  out.push(`<rect width="${n2(L.W)}" height="${n2(L.H)}" fill="${T.paper}"/>`);
  out.push(`<g clip-path="url(#map)">`);
  out.push(`<rect x="${n2(F.x)}" y="${n2(F.y)}" width="${n2(F.w)}" height="${n2(F.h)}" fill="${T.land}"/>`);
  if (backdrop && backdrop.href) out.push(`<image id="backdrop" x="${n2(F.x)}" y="${n2(F.y)}" width="${n2(F.w)}" height="${n2(F.h)}" preserveAspectRatio="none" href="${backdrop.href}" xlink:href="${backdrop.href}"/>`);

  // --- basemap ---------------------------------------------------------------------
  const G = { wood: [], rock: [], ice: [], water: [], waterway: [], boundary: [], roads: new Map() };
  const labels = [];
  for (const t of backdrop ? [] : tiles) {
    const n = 2 ** t.z, col = t.col ?? t.x;
    const proj = (extent) => [(x) => ((col + x / extent) / n - L.ox) * L.k + F.x, (y) => ((t.y + y / extent) / n - L.oy) * L.k + F.y];
    const layer = (name) => (t.layers && t.layers[name]) || { extent: 4096, features: [] };
    const own = (name, gx, gy) => gx >= 0 && gy >= 0 && gx < layer(name).extent && gy < layer(name).extent; // buffer duplicates belong to the neighbour tile
    let [px, py] = proj(layer('landcover').extent);
    for (const f of layer('landcover').features) {
      if (f.type !== 3) continue;
      const cls = f.props.class;
      if (o.forest && (cls === 'wood' || cls === 'forest')) G.wood.push(ringPath(f.geometry, px, py));
      else if (o.topo && cls === 'rock') G.rock.push(ringPath(f.geometry, px, py));
      else if (o.topo && cls === 'ice') G.ice.push(ringPath(f.geometry, px, py));
    }
    [px, py] = proj(layer('water').extent);
    for (const f of layer('water').features) if (f.type === 3) G.water.push(ringPath(f.geometry, px, py));
    [px, py] = proj(layer('waterway').extent);
    if (o.waterways) for (const f of layer('waterway').features) {
      if (f.type !== 2) continue;
      const major = f.props.class === 'river' || f.props.class === 'canal';
      if (major || t.z >= 12 || o.topo) G.waterway.push([ringPath(f.geometry, px, py), major ? 1.3 : 0.6]);
    }
    [px, py] = proj(layer('boundary').extent);
    if (o.boundaries) for (const f of layer('boundary').features) {
      const lvl = Number(f.props.admin_level);
      if (f.type === 2 && lvl <= 4 && !f.props.maritime) G.boundary.push([ringPath(f.geometry, px, py), lvl <= 2 ? 1.3 : 0.7]);
    }
    [px, py] = proj(layer('transportation').extent);
    if (o.roads) for (const f of layer('transportation').features) {
      if (f.type !== 2) continue;
      const spec = ROAD_CLASSES.find((r) => r[0] === f.props.class);
      if (!spec || t.z < (o.topo && spec[4] ? spec[4] : spec[1])) continue;
      if (!G.roads.has(spec[0])) G.roads.set(spec[0], []);
      G.roads.get(spec[0]).push(ringPath(f.geometry, px, py));
    }
    [px, py] = proj(layer('place').extent);
    if (o.places) for (const f of layer('place').features) {
      if (f.type !== 1 || !f.geometry.length) continue;
      const cls = f.props.class;
      const size = cls === 'city' ? 11 : cls === 'town' ? 9 : cls === 'village' && (t.z >= 10 || o.topo) ? 7.5 : (cls === 'country' && t.z <= 5) ? 13 : 0;
      const [gx, gy] = f.geometry[0];
      if (!size || !own('place', gx, gy)) continue;
      const text = f.props['name:' + o.lang] || f.props['name:latin'] || f.props.name;
      if (!text) continue;
      const order = ({ country: 0, city: 1, town: 2, village: 3 })[cls] * 100 + (Number.isFinite(f.props.rank) ? f.props.rank : 50);
      labels.push({ text: String(text), x: px(gx), y: py(gy), size: size * u, order, cls });
    }
    [px, py] = proj(layer('mountain_peak').extent);
    if (o.topo && o.peaks) for (const f of layer('mountain_peak').features) {
      if (f.type !== 1 || !f.geometry.length) continue;
      const [gx, gy] = f.geometry[0];
      const name = f.props['name:' + o.lang] || f.props['name:latin'] || f.props.name;
      if (!name || !own('mountain_peak', gx, gy)) continue;
      const ele = Number(f.props.ele);
      labels.push({ text: Number.isFinite(ele) ? `${name} ${Math.round(ele)}` : String(name), x: px(gx), y: py(gy), size: 7.5 * u, cls: 'peak',
        order: 150 + (Number.isFinite(f.props.rank) ? f.props.rank * 10 : 50) - (Number.isFinite(ele) ? ele / 1000 : 0) });
    }
  }
  const pathEl = (d, attrs) => (d ? `<path d="${d}" ${attrs}/>` : '');
  const fillEl = (list, color) => { if (list.length) out.push(pathEl(list.join(''), `fill="${color}" fill-rule="evenodd"`)); };
  fillEl(G.wood, T.wood); fillEl(G.rock, T.rock); fillEl(G.ice, T.ice);
  // contour lines: below water and roads
  for (const index of [false, true]) {
    let d = '';
    for (const c of contours) if (c.index === index) for (const line of c.lines) line.forEach((p, i) => { d += (i ? 'L' : 'M') + n2(L.x(p.lon)) + ' ' + n2(L.y(p.lat)); });
    out.push(pathEl(d, `class="contour${index ? ' index' : ''}" fill="none" stroke="${T.contour}" stroke-width="${n2((index ? 0.8 : 0.4) * u)}" stroke-linejoin="round"`));
  }
  fillEl(G.water, T.water);
  for (const w of [1.3, 0.6]) {
    const d = G.waterway.filter((x) => x[1] === w).map((x) => x[0]).join('');
    out.push(pathEl(d, `fill="none" stroke="${T.water}" stroke-width="${n2(w * u)}" stroke-linecap="round" stroke-linejoin="round"`));
  }
  for (const spec of [...ROAD_CLASSES].reverse()) { // minor roads first, motorways on top
    const d = (G.roads.get(spec[0]) || []).join('');
    const trail = o.topo && (spec[0] === 'path' || spec[0] === 'track'); // hiking: trails are the point of the map
    out.push(pathEl(d, `fill="none" stroke="${trail ? T.path : T.road}" stroke-width="${n2(spec[2] * u * (trail ? 1.35 : 1))}" stroke-linecap="round" stroke-linejoin="round"${spec[3] ? ` stroke-dasharray="${spec[3].split(' ').map((v) => n2(v * u)).join(' ')}"` : ''}`));
  }
  for (const w of [0.7, 1.3]) {
    const d = G.boundary.filter((x) => x[1] === w).map((x) => x[0]).join('');
    out.push(pathEl(d, `fill="none" stroke="${T.boundary}" stroke-width="${n2(w * u)}" stroke-dasharray="${n2(4 * u)} ${n2(2 * u)} ${n2(0.8 * u)} ${n2(2 * u)}" stroke-linejoin="round"`));
  }

  // --- route -----------------------------------------------------------------------
  const epsilon = 0.04 * L.metresPerMm; // 0.04 mm on paper
  const routeW = 3.2 * u * o.lineWidth;
  const halo = backdrop ? '#ffffff' : T.land;
  let routeD = '';
  const ends = [];
  for (const seg of lines) {
    if (!seg.length) continue;
    const pts = seg.length > 2 ? simplifyPoints(seg, { mode: 'tolerance', value: epsilon }).points : seg;
    pts.forEach((p, i) => { routeD += (i ? 'L' : 'M') + n2(L.x(p.lon)) + ' ' + n2(L.y(p.lat)); });
    ends.push([pts[0], pts[pts.length - 1]]);
  }
  out.push(pathEl(routeD, `fill="none" stroke="${halo}" stroke-width="${n2(routeW + 2.4 * u)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"`));
  out.push(pathEl(routeD, `id="route" fill="none" stroke="${T.route}" stroke-width="${n2(routeW)}" stroke-linecap="round" stroke-linejoin="round"`));

  // labels above the basemap, below markers
  const avoid = [];
  if (L.card) avoid.push({ x0: L.card.x, y0: L.card.y, x1: L.card.x + L.card.w, y1: L.card.y + L.card.h });
  if (L.fade) avoid.push({ x0: 0, y0: L.fade.y + L.fade.h * 0.15, x1: L.W, y1: L.H });
  const sorted = labels.sort((p, q) => p.order - q.order).slice(0, 600);
  const limit = Math.max(6, Math.round((F.w * F.h) / (u * u * (o.topo ? 16000 : 26000))));
  for (const l of placeLabels(sorted, inside, avoid).slice(0, limit)) {
    if (l.cls === 'peak') {
      const s = l.size * 0.42;
      out.push(`<path class="peak" d="M${n2(l.x)} ${n2(l.y - s)}L${n2(l.x + s)} ${n2(l.y + s * 0.8)}L${n2(l.x - s)} ${n2(l.y + s * 0.8)}Z" fill="${T.label}"/>`);
    } else out.push(`<circle cx="${n2(l.x)}" cy="${n2(l.y)}" r="${n2(l.size * 0.16)}" fill="${T.label}"/>`);
    out.push(`<text x="${n2(l.x + l.size * 0.45)}" y="${n2(l.y)}" ${sans} font-size="${n2(l.size)}" fill="${T.label}" dominant-baseline="central" stroke="${halo}" stroke-width="${n2(l.size * 0.22)}" paint-order="stroke" stroke-linejoin="round"${l.cls === 'city' || l.cls === 'country' ? ' font-weight="600"' : l.cls === 'peak' ? ' font-style="italic"' : ''}>${esc(l.text)}</text>`);
  }
  if (o.startEnd && ends.length) {
    const a = ends[0][0], b = ends[ends.length - 1][1], r = routeW * 1.25;
    out.push(`<circle cx="${n2(L.x(a.lon))}" cy="${n2(L.y(a.lat))}" r="${n2(r)}" fill="${halo}" stroke="${T.route}" stroke-width="${n2(routeW * 0.7)}"/>`);
    out.push(`<circle cx="${n2(L.x(b.lon))}" cy="${n2(L.y(b.lat))}" r="${n2(r)}" fill="${T.route}" stroke="${halo}" stroke-width="${n2(routeW * 0.45)}"/>`);
  }
  for (const w of waypoints) {
    const x = L.x(w.lon), y = L.y(w.lat), s = 8.5 * u;
    if (!inside(x, y)) continue;
    out.push(`<circle cx="${n2(x)}" cy="${n2(y)}" r="${n2(routeW * 0.8)}" fill="${T.text}" stroke="${halo}" stroke-width="${n2(routeW * 0.35)}"/>`);
    if (w.name) out.push(`<text x="${n2(x + routeW * 1.4)}" y="${n2(y)}" ${sans} font-size="${n2(s)}" font-weight="600" fill="${T.text}" dominant-baseline="central" stroke="${halo}" stroke-width="${n2(s * 0.25)}" paint-order="stroke" stroke-linejoin="round">${esc(w.name)}</text>`);
  }

  // --- furniture inside the map ---------------------------------------------------------
  if (o.compass && !C) {
    const cx = I.x + I.w - 22 * u, cy = I.y + 30 * u, r = 11 * u;
    out.push(`<g id="compass"><path d="M${n2(cx)} ${n2(cy - r)}L${n2(cx + r * 0.42)} ${n2(cy + r * 0.75)}L${n2(cx)} ${n2(cy + r * 0.35)}L${n2(cx - r * 0.42)} ${n2(cy + r * 0.75)}Z" fill="${T.text}" stroke="${halo}" stroke-width="${n2(0.6 * u)}"/>`
      + `<text x="${n2(cx)}" y="${n2(cy - r - 3 * u)}" ${sans} font-size="${n2(8 * u)}" font-weight="700" fill="${T.text}" text-anchor="middle" stroke="${halo}" stroke-width="${n2(1.6 * u)}" paint-order="stroke">N</text></g>`);
  }
  if (o.scaleBar) {
    const metres = niceLength(L.metresPerMm * (C ? C.r * 0.5 : I.w * 0.22)), len = metres / L.metresPerMm;
    // full-bleed designs keep the bottom for the title: the bar moves to the top
    const x = C ? C.cx - len / 2 : I.x + 14 * u, y = C ? C.cy + C.r * 0.88 : L.bleed ? I.y + 24 * u : I.y + I.h - 14 * u;
    const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
    out.push(`<g id="scalebar"><path d="M${n2(x)} ${n2(y - 3 * u)}V${n2(y)}H${n2(x + len)}V${n2(y - 3 * u)}" fill="none" stroke="${T.text}" stroke-width="${n2(0.9 * u)}"/>`
      + `<text x="${n2(x + len / 2)}" y="${n2(y - 5 * u)}" ${sans} font-size="${n2(7.5 * u)}" fill="${T.text}" text-anchor="middle" stroke="${halo}" stroke-width="${n2(1.8 * u)}" paint-order="stroke">${esc(label)}</text></g>`);
  }
  out.push(`</g>`);

  // --- frame ----------------------------------------------------------------------------
  const B = L.bounds;
  if (L.design === 'galerie') out.push(`<rect x="${n2(F.x)}" y="${n2(F.y)}" width="${n2(F.w)}" height="${n2(F.h)}" fill="none" stroke="${T.frame}" stroke-width="${n2(1.1 * u)}"/>`);
  else if (L.design === 'atlas') {
    const g = L.margin * 0.5; // band between the two frames carries the degree scale
    out.push(`<g id="atlas"><rect x="${n2(F.x)}" y="${n2(F.y)}" width="${n2(F.w)}" height="${n2(F.h)}" fill="none" stroke="${T.frame}" stroke-width="${n2(2.2 * u)}"/>`
      + `<rect x="${n2(F.x - g)}" y="${n2(F.y - g)}" width="${n2(F.w + 2 * g)}" height="${n2(F.h + 2 * g)}" fill="none" stroke="${T.frame}" stroke-width="${n2(0.7 * u)}"/>`);
    const step = DEG_STEPS.find((s) => (B.maxLon - B.minLon) / s <= 7) || 20, fs = 6 * u;
    let ticks = '';
    for (let lon = Math.ceil(B.minLon / step - 1e-9) * step; lon <= B.maxLon + 1e-9; lon += step) {
      const x = L.x(lon);
      if (x < F.x + 12 * u || x > F.x + F.w - 40 * u) continue;
      ticks += `M${n2(x)} ${n2(F.y - g)}V${n2(F.y)}M${n2(x)} ${n2(F.y + F.h)}V${n2(F.y + F.h + g)}`;
      for (const y of [F.y - g * 0.45, F.y + F.h + g * 0.55]) out.push(`<text x="${n2(x + 2 * u)}" y="${n2(y)}" ${sans} font-size="${n2(fs)}" fill="${T.muted}" dominant-baseline="central">${esc(degLabel(lon, 'O', 'W'))}</text>`);
    }
    for (let lat = Math.ceil(B.minLat / step - 1e-9) * step; lat <= B.maxLat + 1e-9; lat += step) {
      const y = L.y(lat);
      if (y < F.y + 40 * u || y > F.y + F.h - 12 * u) continue;
      ticks += `M${n2(F.x - g)} ${n2(y)}H${n2(F.x)}M${n2(F.x + F.w)} ${n2(y)}H${n2(F.x + F.w + g)}`;
      for (const x of [F.x - g * 0.5, F.x + F.w + g * 0.5]) out.push(`<text x="${n2(x)}" y="${n2(y - 2 * u)}" ${sans} font-size="${n2(fs)}" fill="${T.muted}" text-anchor="start" transform="rotate(-90 ${n2(x)} ${n2(y - 2 * u)})" dominant-baseline="central">${esc(degLabel(lat, 'N', 'S'))}</text>`);
    }
    out.push(pathEl(ticks, `fill="none" stroke="${T.frame}" stroke-width="${n2(0.7 * u)}"`) + `</g>`);
  } else if (C) {
    let ticks = '';
    for (let a = 0; a < 360; a += 5) {
      const len = a % 90 === 0 ? C.ring * 0.42 : a % 30 === 0 ? C.ring * 0.3 : C.ring * 0.16, s = Math.sin(rad(a)), c = -Math.cos(rad(a));
      ticks += `M${n2(C.cx + s * (C.r + 2 * u))} ${n2(C.cy + c * (C.r + 2 * u))}L${n2(C.cx + s * (C.r + 2 * u + len))} ${n2(C.cy + c * (C.r + 2 * u + len))}`;
    }
    out.push(`<g id="ring"><circle cx="${n2(C.cx)}" cy="${n2(C.cy)}" r="${n2(C.r)}" fill="none" stroke="${T.frame}" stroke-width="${n2(1.6 * u)}"/>`
      + `<circle cx="${n2(C.cx)}" cy="${n2(C.cy)}" r="${n2(C.r + C.ring * 0.95)}" fill="none" stroke="${T.frame}" stroke-width="${n2(0.6 * u)}"/>`
      + pathEl(ticks, `fill="none" stroke="${T.frame}" stroke-width="${n2(0.7 * u)}"`));
    for (const [a, t] of [[0, 'N'], [90, 'O'], [180, 'S'], [270, 'W']]) {
      const d = C.r + C.ring * 0.68;
      out.push(`<text x="${n2(C.cx + Math.sin(rad(a)) * d)}" y="${n2(C.cy - Math.cos(rad(a)) * d)}" ${font} font-size="${n2(C.ring * 0.36)}" font-weight="700" fill="${T.text}" text-anchor="middle" dominant-baseline="central" stroke="${T.paper}" stroke-width="${n2(C.ring * 0.2)}" paint-order="stroke">${t}</text>`);
    }
    out.push(`</g>`);
  }
  if (L.fade) out.push(`<rect id="fadeout" x="0" y="${n2(L.fade.y)}" width="${n2(L.W)}" height="${n2(L.fade.h)}" fill="url(#fade)"/>`);
  if (L.card) out.push(`<rect id="card" x="${n2(L.card.x)}" y="${n2(L.card.y)}" width="${n2(L.card.w)}" height="${n2(L.card.h)}" rx="${n2(3 * u)}" fill="${T.paper}" fill-opacity="0.95" stroke="${T.frame}" stroke-width="${n2(0.7 * u)}"/>`);

  // --- elevation profile strip --------------------------------------------------------
  if (L.profileBox && o.profile && o.profile.length > 1) {
    const P = o.profile, PB = L.profileBox, x0 = PB.x, w = PB.w, top = PB.y + PB.h * 0.22, h = PB.h * 0.78;
    const total = P[P.length - 1].d || 1;
    let lo = Infinity, hi = -Infinity;
    for (const p of P) { if (p.ele < lo) lo = p.ele; if (p.ele > hi) hi = p.ele; }
    if (hi - lo < 1) hi = lo + 1;
    const X = (d) => x0 + (d / total) * w, Y = (e) => top + h - ((e - lo) / (hi - lo)) * h * 0.92;
    const stride = Math.max(1, Math.floor(P.length / 1500));
    let line = '';
    for (let i = 0; i < P.length; i += stride) line += `${line ? 'L' : 'M'}${n2(X(P[i].d))} ${n2(Y(P[i].ele))}`;
    line += `L${n2(X(total))} ${n2(Y(P[P.length - 1].ele))}`;
    const area = `M${n2(X(0))} ${n2(top + h)}L${line.slice(1)}L${n2(X(total))} ${n2(top + h)}Z`;
    out.push(`<g id="profile"><path d="${area}" fill="${T.route}" opacity="0.18"/><path d="${line}" fill="none" stroke="${T.route}" stroke-width="${n2(0.9 * u)}" stroke-linejoin="round"/>`
      + `<text x="${n2(x0)}" y="${n2(top - 1.5 * u)}" ${sans} font-size="${n2(6.5 * u)}" fill="${T.muted}">${Math.round(P[0].ele)} m</text>`
      + `<text x="${n2(x0 + w / 2)}" y="${n2(top - 1.5 * u)}" ${sans} font-size="${n2(6.5 * u)}" fill="${T.muted}" text-anchor="middle">${Math.round(lo)} – ${Math.round(hi)} m</text>`
      + `<text x="${n2(x0 + w)}" y="${n2(top - 1.5 * u)}" ${sans} font-size="${n2(6.5 * u)}" fill="${T.muted}" text-anchor="end">${Math.round(P[P.length - 1].ele)} m</text></g>`);
  }

  // --- text block -----------------------------------------------------------------------
  if (L.text) {
    const X = L.text, cx = X.x + X.w / 2, th = X.h, y0 = X.y;
    const hasStats = stats.length > 0;
    if (title) { // shrink long titles so they never run off the sheet
      const shown = FONT.caps ? title.toUpperCase() : title;
      const size = Math.min(th * (FONT.caps ? 0.24 : 0.3), (X.w * 0.96) / (shown.length * (FONT.width + FONT.spacing)));
      out.push(`<text id="title" x="${n2(cx)}" y="${n2(y0 + th * 0.36)}" ${font} font-size="${n2(size)}" font-weight="${FONT.weight}"${FONT.italic ? ' font-style="italic"' : ''} letter-spacing="${n2(size * FONT.spacing)}" fill="${T.text}" text-anchor="middle">${esc(shown)}</text>`);
    }
    if (subtitle) {
      const size = Math.min(th * 0.095, (X.w * 0.96) / (subtitle.length * (0.55 + 0.21)));
      out.push(`<text id="subtitle" x="${n2(cx)}" y="${n2(y0 + th * 0.54)}" ${font} font-size="${n2(size)}" letter-spacing="${n2(size * 0.21)}" fill="${T.muted}" text-anchor="middle">${esc(subtitle)}</text>`);
    }
    if (hasStats) {
      const colW = Math.min(X.w / stats.length, th * 1.5), start = cx - (colW * stats.length) / 2;
      out.push(`<g id="stats">`);
      stats.forEach((s, i) => {
        const x = start + colW * (i + 0.5);
        const vs = Math.min(th * 0.13, (colW * 0.92) / (String(s.value).length * 0.6)), ls = Math.min(th * 0.06, (colW * 0.92) / (String(s.label).length * 0.82));
        out.push(`<text x="${n2(x)}" y="${n2(y0 + th * 0.78)}" ${font} font-size="${n2(vs)}" font-weight="600" fill="${T.text}" text-anchor="middle">${esc(s.value)}</text>`);
        out.push(`<text x="${n2(x)}" y="${n2(y0 + th * 0.9)}" ${sans} font-size="${n2(ls)}" letter-spacing="${n2(ls * 0.2)}" fill="${T.muted}" text-anchor="middle">${esc(String(s.label).toUpperCase())}</text>`);
      });
      out.push(`</g>`);
    }
    if (o.coords && lines.length && lines[0].length) {
      const a = lines[0][0], last = lines[lines.length - 1], b = last[last.length - 1];
      const txt = `${formatCoordinate(a.lat, a.lon, o.coordFormat)}  →  ${formatCoordinate(b.lat, b.lon, o.coordFormat)}`;
      const size = Math.min(th * 0.06, (X.w * 0.96) / (txt.length * 0.62));
      out.push(`<text id="coords" x="${n2(cx)}" y="${n2(y0 + th * (hasStats ? 0.635 : 0.7))}" ${sans} font-size="${n2(size)}" letter-spacing="${n2(size * 0.16)}" fill="${T.muted}" text-anchor="middle">${esc(txt)}</text>`);
    }
  }
  const credit = backdrop ? backdrop.attribution : [tiles.length ? o.attribution : '', contours.length ? 'Höhen: SRTM' : ''].filter(Boolean).join(' · ');
  if (credit) out.push(`<text id="attribution" x="${n2(L.W / 2)}" y="${n2(L.H - L.margin * 0.28)}" ${sans} font-size="${n2(5.2 * u)}" fill="${T.muted}" opacity="0.7" text-anchor="middle">${esc(credit)}</text>`);
  out.push(`</svg>`);
  return out.filter(Boolean).join('\n');
}
