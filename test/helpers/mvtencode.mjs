// Independent MVT encoder for tests (protobuf written by hand, following the
// Mapbox Vector Tile specification 2.1) — the decoder under test never sees
// data produced by its own code.
const varint = (n) => { const out = []; let v = n; while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); } out.push(v); return out; };
const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const key = (field, wire) => varint(field * 8 + wire);
const bytesField = (field, bytes) => [...key(field, 2), ...varint(bytes.length), ...bytes];
const str = (field, s) => bytesField(field, [...new TextEncoder().encode(s)]);

function value(v) {
  if (typeof v === 'string') return str(1, v);
  if (typeof v === 'boolean') return [...key(7, 0), v ? 1 : 0];
  if (Number.isInteger(v)) return v >= 0 ? [...key(5, 0), ...varint(v)] : [...key(6, 0), ...varint(zz(v))];
  const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true);
  return [...key(3, 1), ...b];
}

/** geometry: point [[x,y],...]; line [[[x,y],...],...]; polygon rings (closed automatically). */
function geometry(type, geom) {
  const out = []; let cx = 0, cy = 0;
  const move = (x, y) => { out.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; };
  if (type === 1) { out.push((geom.length << 3) | 1); geom.forEach(([x, y]) => move(x, y)); return out; }
  for (const ring of geom) {
    const pts = type === 3 ? ring.slice(0, -1) : ring;
    out.push((1 << 3) | 1); move(pts[0][0], pts[0][1]);
    out.push(((pts.length - 1) << 3) | 2); pts.slice(1).forEach(([x, y]) => move(x, y));
    if (type === 3) out.push((1 << 3) | 7);
  }
  return out;
}

/** layers: { name: { extent?, features: [{type, props, geometry}] } } -> Uint8Array */
export function encodeTile(layers) {
  const tile = [];
  for (const [name, layer] of Object.entries(layers)) {
    const keys = [], values = [], body = [...key(15, 0), 2, ...str(1, name)];
    for (const f of layer.features) {
      const tags = [];
      for (const [k, v] of Object.entries(f.props || {})) {
        if (!keys.includes(k)) keys.push(k);
        let vi = values.findIndex((x) => x === v);
        if (vi < 0) { values.push(v); vi = values.length - 1; }
        tags.push(keys.indexOf(k), vi);
      }
      const feat = [...key(1, 0), ...varint(1), ...bytesField(2, tags.flatMap(varint)), ...key(3, 0), f.type, ...bytesField(4, geometry(f.type, f.geometry).flatMap(varint))];
      body.push(...bytesField(2, feat));
    }
    keys.forEach((k) => body.push(...str(3, k)));
    values.forEach((v) => body.push(...bytesField(4, value(v))));
    body.push(...key(5, 0), ...varint(layer.extent || 4096));
    tile.push(...bytesField(3, body));
  }
  return new Uint8Array(tile);
}
