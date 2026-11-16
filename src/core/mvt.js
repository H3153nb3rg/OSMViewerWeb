// Mapbox Vector Tile (MVT 2.x) decoder — protobuf wire format read by hand,
// no dependencies. Only what the poster export needs: layers, feature
// properties and geometry in tile units.
//
// decodeTile(bytes, wanted?) -> { [layerName]: { extent, features: [{ type, props, geometry }] } }
//   type      1 = point, 2 = line, 3 = polygon
//   geometry  point: [[x, y], ...]      line/polygon: [[[x, y], ...], ...] (one array per line / ring)

const utf8 = new TextDecoder();

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) { this.b = bytes; this.p = pos; this.end = end; }
  varint() { // up to 64 bit; values beyond 2^53 lose precision, which never matters for map data
    let result = 0, mul = 1;
    for (;;) {
      if (this.p >= this.end) throw new Error('MVT: unerwartetes Ende');
      const byte = this.b[this.p++];
      result += (byte & 0x7f) * mul;
      if (byte < 0x80) return result;
      mul *= 128;
    }
  }
  /** Calls fn(field, wireType) for every field; fn must consume the value or return false to skip it. */
  fields(fn) {
    while (this.p < this.end) {
      const key = this.varint(), field = Math.floor(key / 8), wire = key & 7;
      if (fn(field, wire) === false) this.skip(wire);
    }
  }
  sub() { const len = this.varint(); const r = new Reader(this.b, this.p, this.p + len); this.p += len; if (this.p > this.end) throw new Error('MVT: Längenfeld zu groß'); return r; }
  string() { const len = this.varint(); const s = utf8.decode(this.b.subarray(this.p, this.p + len)); this.p += len; return s; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) { const len = this.varint(); this.p += len; } // two statements: `p += varint()` would read p too early
    else if (wire === 5) this.p += 4;
    else throw new Error('MVT: unbekannter Wire-Typ ' + wire);
  }
}

const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function readValue(r) {
  let value = null;
  r.fields((f, w) => {
    if (f === 1 && w === 2) value = r.string();
    else if (f === 2 && w === 5) { value = new DataView(r.b.buffer, r.b.byteOffset + r.p, 4).getFloat32(0, true); r.p += 4; }
    else if (f === 3 && w === 1) { value = new DataView(r.b.buffer, r.b.byteOffset + r.p, 8).getFloat64(0, true); r.p += 8; }
    else if (f === 4 && w === 0) { const v = r.varint(); value = v >= 2 ** 63 ? v - 2 ** 64 : v; }
    else if (f === 5 && w === 0) value = r.varint();
    else if (f === 6 && w === 0) value = zigzag(r.varint());
    else if (f === 7 && w === 0) value = r.varint() !== 0;
    else return false;
    return true;
  });
  return value;
}

/** Decode the command stream (MoveTo/LineTo/ClosePath with zigzag deltas). */
export function decodeGeometry(type, ints) {
  const out = [];
  let x = 0, y = 0, ring = null, i = 0;
  while (i < ints.length) {
    const cmd = ints[i] & 7, count = ints[i] >>> 3; i++;
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < count && i + 1 < ints.length; k++) {
        x += zigzag(ints[i++]); y += zigzag(ints[i++]);
        if (type === 1) out.push([x, y]);
        else if (cmd === 1) { ring = [[x, y]]; out.push(ring); }
        else if (ring) ring.push([x, y]);
      }
    } else if (cmd === 7) { if (ring && ring.length) ring.push([ring[0][0], ring[0][1]]); }
    else throw new Error('MVT: unbekanntes Geometrie-Kommando ' + cmd);
  }
  return out;
}

function readLayer(r) {
  const keys = [], values = [], raw = [];
  let name = '', extent = 4096;
  r.fields((f, w) => {
    if (f === 1 && w === 2) name = r.string();
    else if (f === 2 && w === 2) raw.push(r.sub());
    else if (f === 3 && w === 2) keys.push(r.string());
    else if (f === 4 && w === 2) values.push(readValue(r.sub()));
    else if (f === 5 && w === 0) extent = r.varint();
    else return false;
    return true;
  });
  const features = raw.map((fr) => {
    let type = 0, tags = [], geom = [];
    const packed = (rr) => { const a = []; const s = rr.sub(); while (s.p < s.end) a.push(s.varint()); return a; };
    fr.fields((f, w) => {
      if (f === 2 && w === 2) tags = packed(fr);
      else if (f === 3 && w === 0) type = fr.varint();
      else if (f === 4 && w === 2) geom = packed(fr);
      else return false;
      return true;
    });
    const props = {};
    for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
    return { type, props, geometry: decodeGeometry(type, geom) };
  });
  return { name, extent, features };
}

/**
 * @param {Uint8Array} bytes  uncompressed tile
 * @param {Set<string>|string[]} [wanted]  layer names to decode (others are skipped cheaply)
 */
export function decodeTile(bytes, wanted) {
  const want = wanted ? new Set(wanted) : null;
  const layers = {};
  const r = new Reader(bytes);
  r.fields((f, w) => {
    if (f !== 3 || w !== 2) return false;
    const sub = r.sub();
    if (want) { // peek the name (field 1) before decoding everything
      let name = null;
      const peek = new Reader(sub.b, sub.p, sub.end);
      peek.fields((ff, ww) => { if (ff === 1 && ww === 2 && name === null) { name = peek.string(); return true; } return false; });
      if (!want.has(name)) return true;
    }
    const l = readLayer(sub);
    layers[l.name] = { extent: l.extent, features: l.features };
    return true;
  });
  return layers;
}
