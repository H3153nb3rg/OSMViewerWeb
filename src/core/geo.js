// Geodesy helpers (spherical earth for distances, Web Mercator for map math).

export const EARTH_RADIUS = 6371008.8;       // mean radius, metres
export const WGS84_A = 6378137;              // equatorial radius, metres
export const TILE_SIZE = 256;
export const MAX_MERC_LAT = 85.0511287798066;

export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Great-circle distance in metres between two {lat, lon}. */
export function haversine(a, b) {
  const p1 = rad(a.lat), p2 = rad(b.lat);
  const dp = p2 - p1, dl = rad(b.lon - a.lon);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a->b in degrees [0, 360). */
export function bearing(a, b) {
  const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
  const x = Math.sin(dl) * Math.cos(p2);
  const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(x, y)) + 360) % 360;
}

/** Destination point from p along bearing (deg) for dist metres. */
export function destination(p, bearingDeg, dist) {
  const d = dist / EARTH_RADIUS, t = rad(bearingDeg), p1 = rad(p.lat), l1 = rad(p.lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
}

/** Total polyline length in metres. */
export function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}

export function emptyBbox() {
  return { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity };
}
export function extendBbox(b, p) {
  if (p.lat < b.minLat) b.minLat = p.lat;
  if (p.lat > b.maxLat) b.maxLat = p.lat;
  if (p.lon < b.minLon) b.minLon = p.lon;
  if (p.lon > b.maxLon) b.maxLon = p.lon;
  return b;
}
export function bboxOf(points) {
  if (!points || points.length === 0) return null;
  const b = emptyBbox();
  for (const p of points) extendBbox(b, p);
  return b;
}
export function unionBbox(a, b) {
  if (!a) return b; if (!b) return a;
  return { minLat: Math.min(a.minLat, b.minLat), minLon: Math.min(a.minLon, b.minLon),
           maxLat: Math.max(a.maxLat, b.maxLat), maxLon: Math.max(a.maxLon, b.maxLon) };
}
export const bboxCenter = (b) => ({ lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 });

// --- Web Mercator: world coordinates in [0,1) x [0,1), origin top-left -------
export const mercX = (lon) => (lon + 180) / 360;
export function mercY(lat) {
  const s = Math.sin(rad(clamp(lat, -MAX_MERC_LAT, MAX_MERC_LAT)));
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
export const invMercX = (x) => x * 360 - 180;
export const invMercY = (y) => deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y))));
export const worldSize = (zoom) => TILE_SIZE * 2 ** zoom;

/** Metres per pixel at latitude for a (fractional) zoom level. */
export function groundResolution(lat, zoom) {
  return (Math.cos(rad(lat)) * 2 * Math.PI * WGS84_A) / worldSize(zoom);
}
/** Inverse: zoom level that yields the given metres/pixel at latitude. */
export function zoomForResolution(lat, metresPerPixel) {
  return Math.log2((Math.cos(rad(lat)) * 2 * Math.PI * WGS84_A) / (TILE_SIZE * metresPerPixel));
}
