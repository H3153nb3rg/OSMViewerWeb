// Contour lines from a regular elevation grid (marching squares).
// Pure geometry: grid in, polylines out. Used by the poster's topo mode.
//
// grid = { cols, rows, data: number[] }  row 0 = north, col 0 = west; NaN/null = no data
// Result coordinates are grid units: x in [0, cols-1], y in [0, rows-1].

const NICE = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

/** Contour interval so that roughly `target` lines cross the relief. */
export function contourInterval(min, max, target = 14) {
  const raw = (max - min) / target;
  return NICE.find((s) => s >= raw) || 1000;
}

/**
 * @returns {{level: number, lines: number[][][]}[]}  lines = [[x, y], ...] per polyline, per level
 */
export function contourLines(grid, levels) {
  const { cols, rows, data } = grid;
  const v = (c, r) => { const x = data[r * cols + c]; return x === null || x === undefined ? NaN : x; };
  const out = [];
  for (const level of levels) {
    // segments keyed by their end points on cell edges; edge id = unique per grid edge
    const next = new Map(); // endpoint key -> [other endpoint key, ...]
    const pos = new Map();
    const link = (a, b) => { (next.get(a) || next.set(a, []).get(a)).push(b); (next.get(b) || next.set(b, []).get(b)).push(a); };
    const hEdge = (c, r) => { // crossing on the horizontal edge (c,r)-(c+1,r)
      const k = 'h' + c + ',' + r;
      if (!pos.has(k)) { const a = v(c, r), b = v(c + 1, r); pos.set(k, [c + (level - a) / (b - a), r]); }
      return k;
    };
    const vEdge = (c, r) => { // crossing on the vertical edge (c,r)-(c,r+1)
      const k = 'v' + c + ',' + r;
      if (!pos.has(k)) { const a = v(c, r), b = v(c, r + 1); pos.set(k, [c, r + (level - a) / (b - a)]); }
      return k;
    };
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      const tl = v(c, r), tr = v(c + 1, r), br = v(c + 1, r + 1), bl = v(c, r + 1);
      if (Number.isNaN(tl + tr + br + bl)) continue;
      // a value exactly on the level counts as above, so no crossing is lost or doubled
      const idx = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = () => hEdge(c, r), B = () => hEdge(c, r + 1), Lf = () => vEdge(c, r), R = () => vEdge(c + 1, r);
      switch (idx) {
        case 1: case 14: link(Lf(), B()); break;
        case 2: case 13: link(B(), R()); break;
        case 3: case 12: link(Lf(), R()); break;
        case 4: case 11: link(T(), R()); break;
        case 6: case 9: link(T(), B()); break;
        case 7: case 8: link(Lf(), T()); break;
        case 5: case 10: { // saddle: decide by the cell centre
          const high = (tl + tr + br + bl) / 4 >= level;
          if ((idx === 5) === high) { link(Lf(), T()); link(B(), R()); } else { link(Lf(), B()); link(T(), R()); }
          break;
        }
        default:
      }
    }
    // chain segments into polylines: start at open ends first, closed rings afterwards
    const used = new Set();
    const lines = [];
    const walk = (start) => {
      const line = [pos.get(start)];
      let prev = null, cur = start;
      for (;;) {
        const nb = next.get(cur).find((n) => n !== prev && !used.has(cur < n ? cur + '|' + n : n + '|' + cur));
        if (nb === undefined) break;
        used.add(cur < nb ? cur + '|' + nb : nb + '|' + cur);
        line.push(pos.get(nb));
        prev = cur; cur = nb;
        if (cur === start) break;
      }
      if (line.length > 1) lines.push(line);
    };
    for (const [k, nb] of next) if (nb.length === 1) walk(k);
    for (const k of next.keys()) walk(k);
    if (lines.length) out.push({ level, lines });
  }
  return out;
}

/**
 * Contours for a geographic grid, as lat/lon polylines.
 * @param {object} grid    {cols, rows, data, south, west, north, east}
 * @param {object} [o]     interval (m, default: chosen from the relief), target (number of lines aimed at), indexEvery
 * @returns {{interval: number, min: number, max: number, contours: {level, index, lines: {lat, lon}[][]}[]}}
 */
export function geoContours(grid, { interval, target = 14, indexEvery = 5 } = {}) {
  let min = Infinity, max = -Infinity;
  for (const e of grid.data) if (typeof e === 'number' && Number.isFinite(e)) { if (e < min) min = e; if (e > max) max = e; }
  if (!(max > min)) return { interval: 0, min, max, contours: [] };
  const step = interval || contourInterval(min, max, target);
  const levels = [];
  for (let l = Math.ceil((min + 1e-6) / step) * step; l < max; l += step) levels.push(l);
  const dx = (grid.east - grid.west) / (grid.cols - 1), dy = (grid.north - grid.south) / (grid.rows - 1);
  const contours = contourLines(grid, levels).map(({ level, lines }) => ({
    level, index: Math.round(level / step) % indexEvery === 0,
    lines: lines.map((line) => line.map(([x, y]) => ({ lat: grid.north - y * dy, lon: grid.west + x * dx }))),
  }));
  return { interval: step, min, max, contours };
}
