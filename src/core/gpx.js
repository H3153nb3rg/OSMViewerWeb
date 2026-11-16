// GPX 1.0/1.1 reader and GPX 1.1 writer.
//
// Document model (plain JSON, structuredClone-safe):
//   doc      = { creator, metadata: {name, desc, author, time, keywords, extra[]},
//                waypoints: [pt], routes: [route], tracks: [track], ns: {prefix: uri}, extra[] }
//   pt       = { lat, lon, ele?, time?, name?, cmt?, desc?, src?, sym?, type?, extra? }
//   `src` (GPX "source of data") records where an item was taken over from.
//   route    = { id, name?, cmt?, desc?, src?, type?, number?, color?, points: [pt], extra? }
//   track    = { id, name?, ..., color?, segments: [{ points: [pt], extra? }], extra? }
// Everything the model does not understand (links, fixes, vendor extensions ...)
// is kept verbatim as raw XML nodes in `extra` and written back in schema order.

import { parseXml, serializeXml, el, localName, elementChildren, child, textOf, findDeep } from './xml.js';

export const GPX_NS = 'http://www.topografix.com/GPX/1/1';
export const OSMV_NS = 'urn:osmviewer:gpx:1';
export const CREATOR = 'OSMViewer Web';

const PT_ORDER = ['ele', 'time', 'magvar', 'geoidheight', 'name', 'cmt', 'desc', 'src', 'link', 'sym', 'type',
  'fix', 'sat', 'hdop', 'vdop', 'pdop', 'ageofdgpsdata', 'dgpsid', 'extensions'];
const PT_FIELDS = ['time', 'name', 'cmt', 'desc', 'src', 'sym', 'type'];
const LINE_ORDER = ['name', 'cmt', 'desc', 'src', 'link', 'number', 'type', 'extensions'];
const LINE_FIELDS = ['name', 'cmt', 'desc', 'src', 'type'];
const META_ORDER = ['name', 'desc', 'author', 'copyright', 'link', 'time', 'keywords', 'bounds', 'extensions'];

// Garmin gpxx:DisplayColor names
export const GARMIN_COLORS = {
  Black: '#000000', DarkRed: '#8b0000', DarkGreen: '#006400', DarkYellow: '#b5a000', DarkBlue: '#00008b',
  DarkMagenta: '#8b008b', DarkCyan: '#008b8b', LightGray: '#c0c0c0', DarkGray: '#606060', Red: '#e00000',
  Green: '#00b000', Yellow: '#e6d200', Blue: '#0040ff', Magenta: '#e000e0', Cyan: '#00c8e0', White: '#ffffff',
};

let idCounter = 0;
export const newId = (prefix) => `${prefix}${++idCounter}`;

export function newDoc() {
  return { creator: CREATOR, metadata: {}, waypoints: [], routes: [], tracks: [], ns: {}, extra: [] };
}

const num = (s) => { if (s === undefined || s === null || s === '') return undefined; const v = Number(String(s).replace(',', '.')); return Number.isFinite(v) ? v : undefined; };

function readPoint(node) {
  const lat = num(node.attrs.lat), lon = num(node.attrs.lon);
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const pt = { lat, lon };
  for (const c of elementChildren(node)) {
    const ln = localName(c.name);
    if (ln === 'ele') { const e = num(textOf(c)); if (e !== undefined) pt.ele = e; }
    else if (PT_FIELDS.includes(ln)) { const t = textOf(c); if (t) pt[ln] = t; }
    else (pt.extra || (pt.extra = [])).push(c);
  }
  return pt;
}

function readColor(extra) {
  const ext = (extra || []).find((n) => localName(n.name) === 'extensions');
  if (!ext) return undefined;
  const own = findDeep(ext, 'color');
  if (own && /^#[0-9a-fA-F]{6}$/.test(textOf(own) || '')) return textOf(own).toLowerCase();
  const garmin = findDeep(ext, 'DisplayColor');
  if (garmin) return GARMIN_COLORS[textOf(garmin)];
  return undefined;
}

function readLine(node, item) {
  for (const c of elementChildren(node)) {
    const ln = localName(c.name);
    if (LINE_FIELDS.includes(ln)) { const t = textOf(c); if (t) item[ln] = t; }
    else if (ln === 'number') { const v = num(textOf(c)); if (v !== undefined) item.number = v; }
    else if (ln !== 'rtept' && ln !== 'trkseg') (item.extra || (item.extra = [])).push(c);
  }
  const color = readColor(item.extra);
  if (color) item.color = color;
  return item;
}

/** Parse GPX text into the document model. Throws on malformed XML or wrong root. */
export function parseGpx(text) {
  const root = parseXml(text);
  if (localName(root.name) !== 'gpx') throw new Error('Keine GPX-Datei (Wurzelelement <' + root.name + '>)');
  const doc = newDoc();
  doc.creator = root.attrs.creator || CREATOR;
  for (const [k, v] of Object.entries(root.attrs)) {
    if (k.startsWith('xmlns:') && k !== 'xmlns:xsi') doc.ns[k.slice(6)] = v;
  }
  const meta = doc.metadata;
  const readMeta = (node) => {
    for (const c of elementChildren(node)) {
      const ln = localName(c.name);
      if (ln === 'name' || ln === 'desc' || ln === 'time' || ln === 'keywords') { const t = textOf(c); if (t) meta[ln] = t; }
      else if (ln === 'author') {
        // GPX 1.1: <author><name>..</name></author>; GPX 1.0: <author>text</author>
        const t = child(c, 'name') ? textOf(child(c, 'name')) : textOf(c);
        if (t) meta.author = t;
        const rest = elementChildren(c).filter((x) => localName(x.name) !== 'name');
        if (rest.length) meta.authorExtra = rest;
      } else if (ln !== 'bounds') (meta.extra || (meta.extra = [])).push(c);
    }
  };
  for (const c of elementChildren(root)) {
    const ln = localName(c.name);
    if (ln === 'metadata') readMeta(c);
    else if (ln === 'wpt') { const p = readPoint(c); if (p) doc.waypoints.push(p); }
    else if (ln === 'rte') {
      const r = readLine(c, { id: newId('r'), points: [] });
      for (const p of elementChildren(c)) if (localName(p.name) === 'rtept') { const pt = readPoint(p); if (pt) r.points.push(pt); }
      doc.routes.push(r);
    } else if (ln === 'trk') {
      const t = readLine(c, { id: newId('t'), segments: [] });
      for (const s of elementChildren(c)) {
        if (localName(s.name) !== 'trkseg') continue;
        const seg = { points: [] };
        for (const p of elementChildren(s)) {
          if (localName(p.name) === 'trkpt') { const pt = readPoint(p); if (pt) seg.points.push(pt); }
          else (seg.extra || (seg.extra = [])).push(p);
        }
        t.segments.push(seg);
      }
      doc.tracks.push(t);
    } else if (['name', 'desc', 'author', 'time', 'keywords'].includes(ln)) {
      readMeta({ children: [c] }); // GPX 1.0 top-level metadata
    } else if (ln === 'extensions') doc.extra.push(c);
    // GPX 1.0 leftovers (email, url, urlname, bounds) are intentionally dropped
  }
  for (const w of doc.waypoints) w.id = newId('w');
  return doc;
}

const fmtCoord = (v) => { const s = v.toFixed(7).replace(/0+$/, ''); return s.endsWith('.') ? s + '0' : s; };
const fmtEle = (v) => String(Math.round(v * 100) / 100);

function ordered(nodes, order) {
  const rank = (n) => { const i = order.indexOf(localName(n.name)); return i < 0 ? order.length - 1.5 : i; };
  return nodes.map((n, i) => [n, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}

function withColor(extra, color, used) {
  const list = (extra || []).filter((n) => localName(n.name) !== 'extensions');
  const ext = (extra || []).find((n) => localName(n.name) === 'extensions');
  const kids = ext ? ext.children.filter((c) => typeof c === 'string' || c.name !== 'osmv:color') : [];
  // Only write our own colour element when it says more than an existing Garmin DisplayColor.
  const inherent = kids.length ? readColor([el('extensions', {}, kids)]) : undefined;
  if (color && color !== inherent) { kids.push(el('osmv:color', {}, [color])); used.osmv = true; }
  if (kids.length) list.push(el('extensions', {}, kids));
  return list;
}

function writePoint(tag, p) {
  const kids = [];
  if (Number.isFinite(p.ele)) kids.push(el('ele', {}, [fmtEle(p.ele)]));
  for (const f of PT_FIELDS) if (p[f]) kids.push(el(f, {}, [p[f]]));
  if (p.extra) kids.push(...p.extra);
  return el(tag, { lat: fmtCoord(p.lat), lon: fmtCoord(p.lon) }, ordered(kids, PT_ORDER));
}

function writeLine(tag, item, used) {
  const kids = [];
  for (const f of LINE_FIELDS) if (item[f]) kids.push(el(f, {}, [item[f]]));
  if (Number.isFinite(item.number)) kids.push(el('number', {}, [String(Math.round(item.number))]));
  kids.push(...withColor(item.extra, item.color, used));
  return el(tag, {}, ordered(kids, LINE_ORDER));
}

/** Serialize the document model as GPX 1.1 text. */
export function serializeGpx(doc, { creator = CREATOR } = {}) {
  const used = {};
  const body = [];
  const m = doc.metadata || {};
  const metaKids = [];
  for (const f of ['name', 'desc', 'time', 'keywords']) if (m[f]) metaKids.push(el(f, {}, [m[f]]));
  if (m.author || m.authorExtra) metaKids.push(el('author', {}, [...(m.author ? [el('name', {}, [m.author])] : []), ...(m.authorExtra || [])]));
  if (m.extra) metaKids.push(...m.extra);
  const all = [...doc.waypoints, ...doc.routes.flatMap((r) => r.points), ...doc.tracks.flatMap((t) => t.segments.flatMap((s) => s.points))];
  if (all.length) {
    let a = 90, b = 180, c = -90, d = -180;
    for (const p of all) { if (p.lat < a) a = p.lat; if (p.lat > c) c = p.lat; if (p.lon < b) b = p.lon; if (p.lon > d) d = p.lon; }
    metaKids.push(el('bounds', { minlat: fmtCoord(a), minlon: fmtCoord(b), maxlat: fmtCoord(c), maxlon: fmtCoord(d) }));
  }
  if (metaKids.length) body.push(el('metadata', {}, ordered(metaKids, META_ORDER)));
  for (const w of doc.waypoints) body.push(writePoint('wpt', w));
  for (const r of doc.routes) {
    const node = writeLine('rte', r, used);
    for (const p of r.points) node.children.push(writePoint('rtept', p));
    body.push(node);
  }
  for (const t of doc.tracks) {
    const node = writeLine('trk', t, used);
    for (const s of t.segments) {
      const seg = el('trkseg', {}, s.points.map((p) => writePoint('trkpt', p)));
      if (s.extra) seg.children.push(...s.extra);
      node.children.push(seg);
    }
    body.push(node);
  }
  if (doc.extra && doc.extra.length) body.push(...doc.extra);
  const attrs = {
    xmlns: GPX_NS, version: '1.1', creator,
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xsi:schemaLocation': `${GPX_NS} http://www.topografix.com/GPX/1/1/gpx.xsd`,
  };
  for (const [p, uri] of Object.entries(doc.ns || {})) if (p !== 'osmv') attrs['xmlns:' + p] = uri;
  if (used.osmv) attrs['xmlns:osmv'] = OSMV_NS;
  return serializeXml(el('gpx', attrs, body));
}

/** All points of a track as one flat array. */
export const trackPoints = (track) => track.segments.flatMap((s) => s.points);
/** Points of a route or track. */
export const itemPoints = (item) => (item.segments ? trackPoints(item) : item.points);
export const pointCount = (item) => (item.segments ? item.segments.reduce((n, s) => n + s.points.length, 0) : item.points.length);
/** Assign fresh ids (needed after structuredClone-based copies or merges). */
export function reId(doc) {
  for (const w of doc.waypoints) w.id = newId('w');
  for (const r of doc.routes) r.id = newId('r');
  for (const t of doc.tracks) t.id = newId('t');
  return doc;
}
