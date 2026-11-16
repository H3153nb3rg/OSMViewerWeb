// Coordinate grid for map and print: lines and labels in the chosen coordinate
// system. Pure geometry — the UI only strokes the returned polylines.
//
//   dd / dmm / dms (and Maidenhead, Plus Code)  -> graticule (meridians/parallels)
//   utm / mgrs                                   -> UTM grid (eastings/northings per zone)
//
// A line is { axis: 'x' | 'y', points: [{lat, lon}], label }.
// axis 'x' = line of constant longitude/easting (labelled at top and bottom),
// axis 'y' = line of constant latitude/northing (labelled left and right).

import { latLonToUtm, utmToLatLon, utmZone, formatCoordinate } from './coords.js';

// "nice" steps: degrees expressed in arc seconds for the sexagesimal formats
const SEXA = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000, 72000, 108000].map((s) => s / 3600);

function niceDecimal(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw - 1e-12);
}
const niceSexagesimal = (raw) => SEXA.find((s) => s >= raw) || 30;

function degLabel(v, format, step, pos, neg) {
  const h = v < 0 ? neg : pos, a = Math.abs(v);
  if (format === 'dmm' || format === 'dms') {
    let d = Math.floor(a + 1e-9), rest = (a - d) * 60;
    let m = Math.floor(rest + 1e-7), s = Math.round((rest - m) * 60);
    if (s >= 60) { s = 0; m++; } if (m >= 60) { m = 0; d++; }
    if (step >= 1 - 1e-9) return `${d}° ${h}`;
    if (step >= 1 / 60 - 1e-9) return `${d}° ${String(m).padStart(2, '0')}' ${h}`;
    return `${d}° ${String(m).padStart(2, '0')}' ${String(s).padStart(2, '0')}" ${h}`;
  }
  const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return `${a.toFixed(digits)}° ${h}`;
}

function graticule(b, format, stepDeg) {
  const step = format === 'dmm' || format === 'dms' ? niceSexagesimal(stepDeg) : niceDecimal(stepDeg);
  const lines = [];
  const first = (v) => Math.ceil(v / step - 1e-9) * step;
  for (let lon = first(b.minLon), n = 0; lon <= b.maxLon + 1e-9 && n < 200; lon += step, n++) {
    const v = Math.abs(lon) < step / 1e6 ? 0 : lon;
    lines.push({ axis: 'x', label: degLabel(v, format, step, 'E', 'W'), points: [{ lat: b.minLat, lon: v }, { lat: b.maxLat, lon: v }] });
  }
  for (let lat = first(b.minLat), n = 0; lat <= b.maxLat + 1e-9 && n < 200; lat += step, n++) {
    const v = Math.abs(lat) < step / 1e6 ? 0 : lat;
    lines.push({ axis: 'y', label: degLabel(v, format, step, 'N', 'S'), points: [{ lat: v, lon: b.minLon }, { lat: v, lon: b.maxLon }] });
  }
  return { kind: 'graticule', step, unit: '°', lines };
}

const metreLabel = (v, step) => (step >= 1000 ? `${Math.round(v / 1000)} km` : `${Math.round(v).toLocaleString('de')} m`);

/** Signed northing (no false northing): negative south of the equator. */
function signedUtm(lat, lon, zone) {
  const u = latLonToUtm(lat, lon, zone);
  return { e: u.easting, n: lat < 0 ? u.northing - 1e7 : u.northing };
}
const fromSigned = (zone, e, n) => utmToLatLon(zone, e, n, true);

function utmGrid(b, stepM) {
  const step = niceDecimal(stepM), lines = [];
  const z0 = utmZone((b.minLat + b.maxLat) / 2, b.minLon), z1 = utmZone((b.minLat + b.maxLat) / 2, b.maxLon);
  for (let zone = z0; zone <= z1; zone++) {
    const west = Math.max(b.minLon, (zone - 1) * 6 - 180), east = Math.min(b.maxLon, zone * 6 - 180);
    if (east <= west) continue;
    // UTM extent of this zone's part of the view (corners and edge midpoints)
    let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
    for (const lat of [b.minLat, (b.minLat + b.maxLat) / 2, b.maxLat]) for (const lon of [west, (west + east) / 2, east]) {
      const u = signedUtm(lat, lon, zone);
      e0 = Math.min(e0, u.e); e1 = Math.max(e1, u.e); n0 = Math.min(n0, u.n); n1 = Math.max(n1, u.n);
    }
    const SAMPLES = 16, prefix = z1 > z0 ? `${zone}: ` : '';
    // cut only at real zone boundaries; the view edge is clipped by the canvas
    const zw = (zone - 1) * 6 - 180, ze = zone * 6 - 180;
    const clip = (pts) => (z1 > z0 ? pts.filter((p) => p.lon >= zw - 1e-9 && p.lon <= ze + 1e-9) : pts);
    for (let e = Math.ceil(e0 / step) * step, c = 0; e <= e1 && c < 200; e += step, c++) {
      const pts = clip(Array.from({ length: SAMPLES + 1 }, (_, i) => fromSigned(zone, e, n0 + ((n1 - n0) * i) / SAMPLES)));
      if (pts.length > 1) lines.push({ axis: 'x', label: prefix + 'E ' + metreLabel(e, step), points: pts });
    }
    for (let n = Math.ceil(n0 / step) * step, c = 0; n <= n1 && c < 200; n += step, c++) {
      const pts = clip(Array.from({ length: SAMPLES + 1 }, (_, i) => fromSigned(zone, e0 + ((e1 - e0) * i) / SAMPLES, n)));
      if (pts.length > 1) lines.push({ axis: 'y', label: prefix + 'N ' + metreLabel(n < 0 ? n + 1e7 : n, step), points: pts });
    }
  }
  return { kind: 'utm', step, unit: 'm', lines };
}

/**
 * Grid for a geographic view.
 * @param {object} bounds   {minLat, minLon, maxLat, maxLon}
 * @param {string} format   coordinate format id (dd, dmm, dms, utm, mgrs, maidenhead, olc)
 * @param {number} widthPx  width of the view in pixels
 * @param {number} [targetPx] desired distance between lines
 */
export function buildGrid(bounds, format, widthPx, targetPx = 130) {
  const b = bounds, midLat = (b.minLat + b.maxLat) / 2;
  const degPerPx = (b.maxLon - b.minLon) / Math.max(1, widthPx);
  const utm = format === 'utm' || format === 'mgrs';
  // UTM only where it is defined and legible: at most two zones in view
  if (utm && b.minLat > -80 && b.maxLat < 84 && b.maxLon - b.minLon <= 9) {
    const metresPerPx = degPerPx * 111320 * Math.cos((midLat * Math.PI) / 180);
    return utmGrid(b, metresPerPx * targetPx);
  }
  return graticule(b, utm ? 'dd' : format, degPerPx * targetPx);
}

/** Coordinates of the four corners as text, in the chosen format. */
export function cornerLabels(bounds, format) {
  const f = (lat, lon) => formatCoordinate(lat, lon, format);
  return { nw: f(bounds.maxLat, bounds.minLon), ne: f(bounds.maxLat, bounds.maxLon), sw: f(bounds.minLat, bounds.minLon), se: f(bounds.minLat, bounds.maxLon) };
}
