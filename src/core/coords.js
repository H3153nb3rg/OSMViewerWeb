// Coordinate parsing and formatting: decimal degrees, DMM, DMS, UTM, MGRS,
// Maidenhead locator, Open Location Code (plus code), geo: URIs. WGS84 only.
// One shared entry point (parseCoordinate) for every input field in the app.

import { rad, deg } from './geo.js';

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const COL_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';

export function utmZone(lat, lon) {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;              // Norway
  if (lat >= 72 && lat < 84) {                                                // Svalbard
    if (lon >= 0 && lon < 9) zone = 31; else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35; else if (lon >= 33 && lon < 42) zone = 37;
  }
  return zone;
}
export const latBand = (lat) => BANDS[Math.min(19, Math.max(0, Math.floor((lat + 80) / 8)))];

function meridianArc(phi) {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
}

/** WGS84 lat/lon -> UTM {zone, band, easting, northing, north}. Valid for 80°S..84°N. */
export function latLonToUtm(lat, lon, forceZone) {
  const zone = forceZone || utmZone(lat, lon);
  const phi = rad(lat), lam0 = rad((zone - 1) * 6 - 180 + 3);
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, AA = (rad(lon) - lam0) * c;
  const M = meridianArc(phi);
  const easting = K0 * N * (AA + (1 - T + C) * AA ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * AA ** 5 / 120) + 500000;
  let northing = K0 * (M + N * t * (AA * AA / 2 + (5 - T + 9 * C + 4 * C * C) * AA ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * AA ** 6 / 720));
  if (lat < 0) northing += 10000000;
  return { zone, band: latBand(lat), easting, northing, north: lat >= 0 };
}

/** UTM -> WGS84 {lat, lon}. */
export function utmToLatLon(zone, easting, northing, north = true) {
  const x = easting - 500000, y = north ? northing : northing - 10000000;
  const e4 = E2 * E2, e6 = e4 * E2;
  const mu = y / K0 / (A * (1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const N1 = A / Math.sqrt(1 - E2 * s * s), T1 = t * t, C1 = EP2 * c * c;
  const R1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5, D = x / (N1 * K0);
  const phi = phi1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lam = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return { lat: deg(phi), lon: (zone - 1) * 6 - 180 + 3 + deg(lam) };
}

/** MGRS string, digits = 1..5 per axis (5 = 1 m). */
export function latLonToMgrs(lat, lon, digits = 5) {
  const u = latLonToUtm(lat, lon);
  const e = Math.floor(u.easting), n = Math.floor(u.northing);
  const col = COL_LETTERS[((u.zone - 1) % 3) * 8 + Math.floor(e / 100000) - 1];
  const row = ROW_LETTERS[(Math.floor(n / 100000) + (u.zone % 2 === 0 ? 5 : 0)) % 20];
  const div = 10 ** (5 - digits);
  const part = (v) => String(Math.floor((v % 100000) / div)).padStart(digits, '0');
  return `${u.zone}${u.band} ${col}${row} ${part(e)} ${part(n)}`;
}

/** MGRS -> {lat, lon} (centre of the referenced square). */
export function mgrsToLatLon(mgrs) {
  const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/i.exec(mgrs.replace(/\s+/g, ''));
  if (!m || m[5].length % 2 || m[5].length > 10) return null;
  const zone = +m[1], band = m[2].toUpperCase(), colL = m[3].toUpperCase(), rowL = m[4].toUpperCase();
  if (zone < 1 || zone > 60) return null;
  const colIdx = COL_LETTERS.indexOf(colL) - ((zone - 1) % 3) * 8;
  if (colIdx < 0 || colIdx > 7) return null;
  const rowIdx = (ROW_LETTERS.indexOf(rowL) - (zone % 2 === 0 ? 5 : 0) + 20) % 20;
  const d = m[5].length / 2, scale = 10 ** (5 - d);
  const half = d ? scale / 2 : 50000;
  const easting = (colIdx + 1) * 100000 + (d ? +m[5].slice(0, d) * scale : 0) + half;
  const nPart = rowIdx * 100000 + (d ? +m[5].slice(d) * scale : 0) + half;
  const bandIdx = BANDS.indexOf(band), north = bandIdx >= 10;
  const bandMin = -80 + bandIdx * 8, bandMax = bandIdx === 19 ? 84 : bandMin + 8;
  // The row letter repeats every 2000 km: pick the cycle whose latitude lies in the band.
  let best = null;
  for (let k = 0; k < 5; k++) {
    const northing = nPart + k * 2000000;
    const p = utmToLatLon(zone, easting, northing, north);
    // far outside the projection's domain the series diverges: discard such candidates
    if (!Number.isFinite(p.lat) || Math.abs(p.lat) > 90 || Math.abs(p.lon - ((zone - 1) * 6 - 177)) > 12) continue;
    const miss = p.lat < bandMin ? bandMin - p.lat : p.lat > bandMax ? p.lat - bandMax : 0;
    if (!best || miss < best.miss) best = { miss, p };
  }
  return best && best.miss < 1 ? best.p : null;
}

export function latLonToMaidenhead(lat, lon, pairs = 3) {
  let x = (lon + 180) / 20, y = (lat + 90) / 10, out = '';
  out += String.fromCharCode(65 + Math.floor(x)) + String.fromCharCode(65 + Math.floor(y));
  x = (x % 1) * 10; y = (y % 1) * 10;
  if (pairs > 1) { out += Math.floor(x) + '' + Math.floor(y); x = (x % 1) * 24; y = (y % 1) * 24; }
  if (pairs > 2) { out += String.fromCharCode(97 + Math.floor(x)) + String.fromCharCode(97 + Math.floor(y)); x = (x % 1) * 10; y = (y % 1) * 10; }
  if (pairs > 3) out += Math.floor(x) + '' + Math.floor(y);
  return out;
}
export function maidenheadToLatLon(loc) {
  const s = loc.trim().toUpperCase();
  if (!/^[A-R]{2}(\d{2}([A-X]{2}(\d{2})?)?)?$/.test(s)) return null;
  let lon = (s.charCodeAt(0) - 65) * 20 - 180, lat = (s.charCodeAt(1) - 65) * 10 - 90, w = 20, h = 10;
  if (s.length >= 4) { w = 2; h = 1; lon += +s[2] * w; lat += +s[3] * h; }
  if (s.length >= 6) { w = 2 / 24; h = 1 / 24; lon += (s.charCodeAt(4) - 65) * w; lat += (s.charCodeAt(5) - 65) * h; }
  if (s.length >= 8) { w /= 10; h /= 10; lon += +s[6] * w; lat += +s[7] * h; }
  return { lat: lat + h / 2, lon: lon + w / 2 };
}

const OLC = '23456789CFGHJMPQRVWX';
export function latLonToOlc(lat, lon) {
  let la = Math.min(179.999999, Math.max(0, lat + 90)), lo = ((lon + 180) % 360 + 360) % 360, res = 20, out = '';
  if (la >= 180) la = 179.999999;
  for (let i = 0; i < 5; i++) {
    const a = Math.floor(la / res), b = Math.floor(lo / res);
    out += OLC[a] + OLC[b];
    la -= a * res; lo -= b * res; res /= 20;
    if (i === 3) out += '+';
  }
  return out;
}
export function olcToLatLon(code) {
  const s = code.trim().toUpperCase();
  if (!/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,7}$/.test(s)) return null;
  const c = s.replace('+', '');
  let lat = -90, lon = -180, res = 20;
  for (let i = 0; i < 10; i += 2) { lat += OLC.indexOf(c[i]) * res; lon += OLC.indexOf(c[i + 1]) * res; res /= 20; }
  let h = res * 20, w = res * 20;
  for (let i = 10; i < c.length; i++) { // grid refinement: 5 rows x 4 columns
    const v = OLC.indexOf(c[i]); h /= 5; w /= 4;
    lat += Math.floor(v / 4) * h; lon += (v % 4) * w;
  }
  return { lat: lat + h / 2, lon: lon + w / 2 };
}

const valid = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

const HEMI_WORDS = { N: 'N', NORD: 'N', NORTH: 'N', S: 'S', SÜD: 'S', SUED: 'S', SOUTH: 'S',
  E: 'E', O: 'E', OST: 'E', EAST: 'E', W: 'W', WEST: 'W' };
const NOISE_WORDS = new Set(['LAT', 'LON', 'LNG', 'LONG', 'LATITUDE', 'LONGITUDE', 'BREITE', 'LÄNGE', 'LAENGE', 'DEG', 'MIN', 'SEC', 'D', 'M']);

/** Tokenise free-form lat/lon text into numbers and hemisphere letters. */
function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\d/.test(c) || (c === '-' && /\d/.test(s[i + 1] || ''))) {
      const m = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
      tokens.push({ n: parseFloat(m[0]), neg: m[0][0] === '-' });
      i += m[0].length;
    } else if (/\p{L}/u.test(c)) {
      const m = /^\p{L}+/u.exec(s.slice(i));
      const word = m[0].toUpperCase();
      if (HEMI_WORDS[word]) tokens.push({ h: HEMI_WORDS[word] });
      else if (!NOISE_WORDS.has(word)) return null;
      i += m[0].length;
    } else i++; // separators: space ° ' " : , etc.
  }
  return tokens;
}

function parseLatLonText(input) {
  let s = input.replace(/−/g, '-');
  // German decimal commas: "47,123; 16,456" or "47,123 16,456"
  if (s.includes(';')) s = s.replace(/,/g, '.');
  else if (/^\s*-?\d+,\d+\s+-?\d+,\d+\s*$/.test(s)) s = s.replace(/,/g, '.');
  const tokens = tokenize(s);
  if (!tokens || !tokens.length) return null;
  const hemis = tokens.filter((t) => t.h);
  const groups = [];
  if (hemis.length === 2) {
    const prefix = !!tokens[0].h;
    let cur = null;
    for (const t of tokens) {
      if (t.h) {
        if (prefix) { cur = { h: t.h, nums: [] }; groups.push(cur); }
        else if (cur) { cur.h = t.h; cur = null; }
        else return null;
      } else {
        if (!cur) { if (prefix) return null; cur = { nums: [] }; groups.push(cur); }
        cur.nums.push(t);
      }
    }
  } else if (hemis.length === 0) {
    if (tokens.length < 2 || tokens.length % 2 || tokens.length > 6) return null;
    groups.push({ nums: tokens.slice(0, tokens.length / 2) }, { nums: tokens.slice(tokens.length / 2) });
  } else return null;
  if (groups.length !== 2) return null;
  const val = (g) => {
    if (!g.nums.length || g.nums.length > 3) return NaN;
    const [d, mi = { n: 0 }, se = { n: 0 }] = g.nums;
    if (mi.neg || se.neg || mi.n >= 60 || se.n >= 60) return NaN;
    if (g.nums.length > 1 && !Number.isInteger(d.n)) return NaN;
    if (g.nums.length > 2 && !Number.isInteger(mi.n)) return NaN;
    if (d.neg && g.h) return NaN; // sign and hemisphere letter together are ambiguous
    const v = Math.abs(d.n) + mi.n / 60 + se.n / 3600;
    return d.neg || g.h === 'S' || g.h === 'W' ? -v : v;
  };
  let [a, b] = groups;
  const isLon = (g) => g.h === 'E' || g.h === 'W';
  if (a.h) {
    if (isLon(a) === isLon(b)) return null;
    if (isLon(a)) [a, b] = [b, a];
  }
  const lat = val(a), lon = val(b);
  return valid(lat, lon) ? { lat, lon } : null;
}

/**
 * Parse any supported coordinate notation.
 * @returns {{lat: number, lon: number, format: string} | null}
 */
export function parseCoordinate(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  let m;
  if ((m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(s))) {
    const lat = +m[1], lon = +m[2];
    return valid(lat, lon) ? { lat, lon, format: 'geo' } : null;
  }
  if (/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,7}$/i.test(s)) { const p = olcToLatLon(s); return p && { ...p, format: 'olc' }; }
  if (/^\d{1,2}\s*[C-HJ-NP-X]\s*[A-HJ-NP-Z]\s*[A-HJ-NP-V]\s*[\d\s]*$/i.test(s)) { const p = mgrsToLatLon(s); return p && { ...p, format: 'mgrs' }; }
  if ((m = /^(\d{1,2})\s*([C-HJ-NP-X])?\s+(\d{5,7}(?:[.,]\d+)?)\s*m?\s*E?[\s,;]+(\d{1,8}(?:[.,]\d+)?)\s*m?\s*N?$/i.exec(s))) {
    const zone = +m[1], band = (m[2] || 'N').toUpperCase();
    const e = parseFloat(m[3].replace(',', '.')), n = parseFloat(m[4].replace(',', '.'));
    if (zone >= 1 && zone <= 60 && e >= 100000 && e < 1000000 && n <= 10000000) {
      const p = utmToLatLon(zone, e, n, BANDS.indexOf(band) >= 10); // the letter is the latitude band, not N/S hemisphere
      if (valid(p.lat, p.lon)) return { ...p, format: 'utm' };
    }
    return null;
  }
  if (/^[A-R]{2}\d{2}([A-X]{2}(\d{2})?)?$/i.test(s)) { const p = maidenheadToLatLon(s); return p && { ...p, format: 'maidenhead' }; }
  const p = parseLatLonText(s);
  return p && { ...p, format: 'latlon' };
}

const hemi = (v, pos, neg) => (v < 0 ? neg : pos);
function dmm(v, degDigits) {
  const a = Math.abs(v); let d = Math.floor(a), mi = (a - d) * 60;
  if (+mi.toFixed(3) >= 60) { d += 1; mi = 0; }
  return `${String(d).padStart(degDigits, '0')}° ${mi.toFixed(3).padStart(6, '0')}'`;
}
function dms(v, degDigits) {
  const a = Math.abs(v); let d = Math.floor(a), mi = Math.floor((a - d) * 60), se = (a - d - mi / 60) * 3600;
  if (+se.toFixed(1) >= 60) { se = 0; mi += 1; }
  if (mi >= 60) { mi = 0; d += 1; }
  return `${String(d).padStart(degDigits, '0')}° ${String(mi).padStart(2, '0')}' ${se.toFixed(1).padStart(4, '0')}"`;
}

export const COORD_FORMATS = { dd: 'Dezimalgrad', dmm: 'Grad Minuten', dms: 'Grad Minuten Sekunden', utm: 'UTM', mgrs: 'MGRS', maidenhead: 'Maidenhead', olc: 'Plus Code' };

export function formatCoordinate(lat, lon, format = 'dd') {
  switch (format) {
    case 'dmm': return `${hemi(lat, 'N', 'S')} ${dmm(lat, 2)} ${hemi(lon, 'E', 'W')} ${dmm(lon, 3)}`;
    case 'dms': return `${hemi(lat, 'N', 'S')} ${dms(lat, 2)} ${hemi(lon, 'E', 'W')} ${dms(lon, 3)}`;
    case 'utm': {
      if (lat < -80 || lat > 84) return '–';
      const u = latLonToUtm(lat, lon);
      return `${u.zone}${u.band} ${Math.round(u.easting)} ${Math.round(u.northing)}`;
    }
    case 'mgrs': return lat < -80 || lat > 84 ? '–' : latLonToMgrs(lat, lon);
    case 'maidenhead': return latLonToMaidenhead(lat, lon);
    case 'olc': return latLonToOlc(lat, lon);
    default: return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }
}
