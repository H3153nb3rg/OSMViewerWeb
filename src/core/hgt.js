// SRTM .hgt elevation tiles: 1°x1°, big-endian int16, rows north->south.
// 1201x1201 (SRTM3, 3") or 3601x3601 (SRTM1/"skadi", 1"). -32768 = void.

const VOID = -32768;

/** Tile name for a position, e.g. N47E011 for 47.4 N / 11.2 E. */
export function hgtName(lat, lon) {
  const la = Math.floor(lat), lo = Math.floor(lon);
  return `${la < 0 ? 'S' : 'N'}${String(Math.abs(la)).padStart(2, '0')}${lo < 0 ? 'W' : 'E'}${String(Math.abs(lo)).padStart(3, '0')}`;
}

/** South-west corner of a tile name, or null. */
export function hgtOrigin(name) {
  const m = /^([NS])(\d{2})([EW])(\d{3})$/i.exec(name);
  if (!m) return null;
  return { lat: (m[1].toUpperCase() === 'S' ? -1 : 1) * +m[2], lon: (m[3].toUpperCase() === 'W' ? -1 : 1) * +m[4] };
}

/** Wrap raw bytes (Uint8Array / Buffer) as a tile. Throws on unknown size. */
export function hgtTile(bytes, name) {
  const n = Math.round(Math.sqrt(bytes.length / 2));
  if (n * n * 2 !== bytes.length || (n !== 1201 && n !== 3601)) throw new Error(`${name}: unbekannte HGT-Größe ${bytes.length} Bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { name, size: n, origin: hgtOrigin(name), at: (row, col) => view.getInt16((row * n + col) * 2, false) };
}

/**
 * Bilinear elevation (metres) inside a tile, NaN on voids.
 * Voids next to valid samples are bridged by averaging the valid corners.
 */
export function hgtElevation(tile, lat, lon) {
  const n = tile.size - 1;
  const x = (lon - tile.origin.lon) * n, y = (tile.origin.lat + 1 - lat) * n;
  if (x < -1e-9 || y < -1e-9 || x > n + 1e-9 || y > n + 1e-9) return NaN;
  const c0 = Math.min(n - 1, Math.max(0, Math.floor(x))), r0 = Math.min(n - 1, Math.max(0, Math.floor(y)));
  const fx = x - c0, fy = y - r0;
  const corners = [[tile.at(r0, c0), (1 - fx) * (1 - fy)], [tile.at(r0, c0 + 1), fx * (1 - fy)],
    [tile.at(r0 + 1, c0), (1 - fx) * fy], [tile.at(r0 + 1, c0 + 1), fx * fy]];
  let sum = 0, w = 0;
  for (const [v, k] of corners) if (v !== VOID) { sum += v * k; w += k; }
  if (w > 0.25) return sum / w;
  const valid = corners.filter(([v]) => v !== VOID);
  return valid.length ? valid.reduce((a, [v]) => a + v, 0) / valid.length : NaN;
}
