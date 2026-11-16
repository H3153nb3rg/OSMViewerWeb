// KML 2.2 import/export (Placemarks: Point, LineString, MultiGeometry, gx:Track).
import { parseXml, serializeXml, el, localName, elementChildren, child, childText, textOf } from './xml.js';
import { newDoc, newId, CREATOR } from './gpx.js';

function parseCoordList(text) {
  const pts = [];
  for (const tok of (text || '').trim().split(/\s+/)) {
    if (!tok) continue;
    const [lon, lat, ele] = tok.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const p = { lat, lon };
    if (Number.isFinite(ele) && ele !== 0) p.ele = ele;
    pts.push(p);
  }
  return pts;
}

function stripHtml(s) { return s ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : s; }

export function parseKml(text) {
  const root = parseXml(text);
  if (localName(root.name) !== 'kml') throw new Error('Keine KML-Datei');
  const doc = newDoc();
  const visit = (node) => {
    for (const c of elementChildren(node)) {
      const ln = localName(c.name);
      if (ln === 'Placemark') placemark(c);
      else if (ln === 'Document' || ln === 'Folder') {
        if (ln === 'Document' && !doc.metadata.name && childText(c, 'name')) doc.metadata.name = childText(c, 'name');
        visit(c);
      }
    }
  };
  const placemark = (pm) => {
    const name = childText(pm, 'name');
    const desc = stripHtml(childText(pm, 'description'));
    const geom = (g) => {
      const ln = localName(g.name);
      if (ln === 'Point') {
        const [p] = parseCoordList(childText(g, 'coordinates'));
        if (p) doc.waypoints.push({ id: newId('w'), ...p, ...(name && { name }), ...(desc && { desc }) });
      } else if (ln === 'LineString' || ln === 'LinearRing') {
        const points = parseCoordList(childText(g, 'coordinates'));
        if (points.length) doc.tracks.push({ id: newId('t'), ...(name && { name }), ...(desc && { desc }), segments: [{ points }] });
      } else if (ln === 'Polygon') {
        const ring = child(g, 'outerBoundaryIs'); if (ring) elementChildren(ring).forEach(geom);
      } else if (ln === 'MultiGeometry' || ln === 'MultiTrack') {
        elementChildren(g).forEach(geom);
      } else if (ln === 'Track') { // gx:Track -> <when> + <gx:coord> ("lon lat ele")
        const whens = [], coords = [];
        for (const k of elementChildren(g)) {
          if (localName(k.name) === 'when') whens.push(textOf(k));
          else if (localName(k.name) === 'coord') coords.push(textOf(k));
        }
        const points = [];
        coords.forEach((s, i) => {
          const [lon, lat, ele] = s.trim().split(/\s+/).map(Number);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          const p = { lat, lon };
          if (Number.isFinite(ele)) p.ele = ele;
          if (whens[i]) p.time = whens[i];
          points.push(p);
        });
        if (points.length) doc.tracks.push({ id: newId('t'), ...(name && { name }), ...(desc && { desc }), segments: [{ points }] });
      }
    };
    elementChildren(pm).forEach(geom);
  };
  visit(root);
  return doc;
}

const coordStr = (p) => `${+p.lon.toFixed(7)},${+p.lat.toFixed(7)}${Number.isFinite(p.ele) ? ',' + (+p.ele.toFixed(1)) : ''}`;
const kmlColor = (hex) => (hex ? 'ff' + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3) : 'ff0000ff'); // aabbggrr

export function serializeKml(doc) {
  const text = (tag, v) => (v ? [el(tag, {}, [v])] : []);
  const line = (item, points, width) => el('Placemark', {}, [
    ...text('name', item.name), ...text('description', item.desc),
    el('Style', {}, [el('LineStyle', {}, [el('color', {}, [kmlColor(item.color)]), el('width', {}, [String(width)])])]),
    el('LineString', {}, [el('tessellate', {}, ['1']), el('coordinates', {}, [points.map(coordStr).join(' ')])]),
  ]);
  const folders = [];
  if (doc.waypoints.length) folders.push(el('Folder', {}, [el('name', {}, ['Waypoints']),
    ...doc.waypoints.map((w) => el('Placemark', {}, [...text('name', w.name), ...text('description', w.desc || w.cmt),
      el('Point', {}, [el('coordinates', {}, [coordStr(w)])])]))]));
  if (doc.routes.length) folders.push(el('Folder', {}, [el('name', {}, ['Routes']), ...doc.routes.map((r) => line(r, r.points, 3))]));
  if (doc.tracks.length) folders.push(el('Folder', {}, [el('name', {}, ['Tracks']),
    ...doc.tracks.flatMap((t) => t.segments.filter((s) => s.points.length).map((s) => line(t, s.points, 3)))]));
  const root = el('kml', { xmlns: 'http://www.opengis.net/kml/2.2' }, [
    el('Document', {}, [el('name', {}, [doc.metadata.name || CREATOR]), ...folders])]);
  return serializeXml(root);
}
