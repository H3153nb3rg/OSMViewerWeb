import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXml, serializeXml } from '../src/core/xml.js';
import { parseGpx, serializeGpx, pointCount, trackPoints } from '../src/core/gpx.js';
import { parseKml, serializeKml } from '../src/core/kml.js';
import { haversine, bearing, destination, mercX, mercY, invMercX, invMercY, groundResolution, zoomForResolution } from '../src/core/geo.js';
import { computeStats, ascentDescent, cumulativeDistance } from '../src/core/stats.js';
import * as ops from '../src/core/ops.js';
import { timeMs, isoTime } from '../src/core/time.js';

const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');
// deep comparison: ids ignored, numbers within 1e-7 (the writer rounds to 7 decimals)
function approx(a, b, path) {
  if (typeof a === 'number' && typeof b === 'number') return assert.ok(Math.abs(a - b) <= (path.endsWith('.ele') ? 0.0051 : 1e-7), `${path}: ${a} vs ${b}`);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => k !== 'id'), kb = Object.keys(b).filter((k) => k !== 'id');
    assert.deepEqual(ka.sort(), kb.sort(), path + ': keys');
    for (const k of ka) approx(a[k], b[k], path + '.' + k);
    return undefined;
  }
  return assert.equal(a, b, path);
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

test('xml: entities, CDATA, quoted ">" and round trip', () => {
  const src = '<?xml version="1.0"?><!-- c --><a x="1 &gt; 0" y=\'q"q\'><b>Tom &amp; Jerry &#228;&#x20AC;</b><c><![CDATA[<raw&>]]></c><d/></a>';
  const root = parseXml(src);
  assert.equal(root.attrs.x, '1 > 0'); assert.equal(root.attrs.y, 'q"q');
  assert.equal(root.children[0].children[0], 'Tom & Jerry ä€');
  assert.equal(root.children[1].children[0], '<raw&>');
  assert.deepEqual(parseXml(serializeXml(root)), root);
  assert.throws(() => parseXml('<a><b></a>'), /End-Tag/);
  assert.throws(() => parseXml('<a>'), /nicht geschlossen/);
});

for (const name of ['utah.gpx', 'sample.gpx', 'Kauritatahi.gpx', 'Startplätze.gpx']) {
  test(`gpx: legacy fixture ${name} survives a write/read round trip`, () => {
    const a = parseGpx(fx(name));
    assert.ok(a.waypoints.length + a.routes.length + a.tracks.length > 0, 'has content');
    const text = serializeGpx(a);
    const b = parseGpx(text);
    assert.equal(b.waypoints.length, a.waypoints.length);
    assert.equal(b.routes.length, a.routes.length);
    assert.equal(b.tracks.length, a.tracks.length);
    approx(b.waypoints, a.waypoints, 'wpt'); approx(b.routes, a.routes, 'rte'); approx(b.tracks, a.tracks, 'trk');
    assert.deepEqual(b.metadata, a.metadata);
    assert.equal(serializeGpx(b), text, 'second serialization is byte-identical');
  });
}

test('gpx: vendor extensions and colours are preserved', () => {
  const src = `<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">
   <wpt lat="47.5" lon="16.25"><ele>312.5</ele><name>A &amp; B</name><sym>Flag</sym><fix>3d</fix>
     <extensions><gpxx:WaypointExtension><gpxx:DisplayMode>SymbolAndName</gpxx:DisplayMode></gpxx:WaypointExtension></extensions></wpt>
   <trk><name>T</name><extensions><gpxx:TrackExtension><gpxx:DisplayColor>Blue</gpxx:DisplayColor></gpxx:TrackExtension></extensions>
     <trkseg><trkpt lat="1" lon="2"><ele>5</ele><time>2020-01-01T00:00:00Z</time><hdop>1.2</hdop></trkpt></trkseg></trk></gpx>`;
  const d = parseGpx(src);
  assert.equal(d.waypoints[0].name, 'A & B');
  assert.equal(d.tracks[0].color, '#0040ff');
  d.tracks[0].color = '#ff8800';
  const out = serializeGpx(d);
  assert.match(out, /xmlns:gpxx="http:\/\/www.garmin.com/);
  assert.match(out, /<gpxx:DisplayMode>SymbolAndName<\/gpxx:DisplayMode>/);
  assert.match(out, /<hdop>1.2<\/hdop>/); assert.match(out, /<fix>3d<\/fix>/);
  assert.match(out, /<osmv:color>#ff8800<\/osmv:color>/); assert.match(out, /xmlns:osmv=/);
  // schema order: ele, time, name ..., fix before extensions
  assert.ok(out.indexOf('<ele>312.5') < out.indexOf('<name>A') && out.indexOf('<sym>') < out.indexOf('<fix>') && out.indexOf('<fix>') < out.indexOf('<extensions>'));
  assert.equal(parseGpx(out).tracks[0].color, '#ff8800');
});

test('gpx: GPX 1.0 and invalid input', () => {
  const d = parseGpx('<gpx version="1.0" creator="old"><name>N</name><author>Me</author><wpt lat="1,5" lon="2"><name>w</name></wpt><wpt lat="99" lon="2"/><rte><rtept lat="1" lon="1"/></rte></gpx>');
  assert.equal(d.metadata.name, 'N'); assert.equal(d.metadata.author, 'Me');
  assert.equal(d.waypoints.length, 1); assert.equal(d.waypoints[0].lat, 1.5);
  assert.equal(d.routes[0].points.length, 1);
  assert.throws(() => parseGpx('<kml/>'), /Keine GPX/);
});

test('kml: legacy fixture import and export round trip', () => {
  const k = parseKml(fx('Startplätze.kml'));
  assert.ok(k.waypoints.length > 10, 'waypoints: ' + k.waypoints.length);
  const g = parseGpx(fx('utah.gpx'));
  const back = parseKml(serializeKml(g));
  assert.equal(back.waypoints.length, g.waypoints.length);
  assert.equal(back.tracks.length, g.routes.length + g.tracks.reduce((n, t) => n + t.segments.length, 0));
  const kt = parseKml('<kml xmlns:gx="x"><Placemark><name>t</name><gx:Track><when>2020-01-01T00:00:00Z</when><when>2020-01-01T00:00:10Z</when><gx:coord>16 48 200</gx:coord><gx:coord>16.1 48.1 210</gx:coord></gx:Track></Placemark></kml>');
  assert.equal(kt.tracks[0].segments[0].points[1].time, '2020-01-01T00:00:10Z');
  assert.equal(kt.tracks[0].segments[0].points[1].lat, 48.1);
});

test('geo: distances, bearings, mercator', () => {
  const vie = { lat: 48.2082, lon: 16.3738 }, sbg = { lat: 47.8095, lon: 13.0550 };
  near(haversine(vie, sbg), 251000, 1500, 'Wien-Salzburg');
  near(haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 111195, 5);
  near(bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 0, 1e-9); near(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 90, 1e-9);
  const d = destination(vie, 77, 12345); near(haversine(vie, d), 12345, 0.01); near(bearing(vie, d), 77, 0.01);
  near(invMercY(mercY(48.2)), 48.2, 1e-9); near(invMercX(mercX(16.37)), 16.37, 1e-9);
  near(mercY(0), 0.5, 1e-12); near(mercY(85.0511287798066), 0, 1e-9);
  near(groundResolution(0, 0), 156543.03, 0.01); near(zoomForResolution(48, groundResolution(48, 13.37)), 13.37, 1e-9);
});

test('stats: distance, hysteresis ascent, timing', () => {
  const pts = [0, 1, 2, 3].map((i) => ({ lat: 47, lon: 11 + i * 0.01, ele: [100, 103, 120, 110][i], time: `2024-05-01T10:0${i}:00Z` }));
  const s = computeStats([pts]);
  near(s.distance, haversine(pts[0], pts[3]), 0.5); assert.equal(s.count, 4);
  assert.equal(s.ascent, 20); assert.equal(s.descent, 10); assert.equal(s.durationMs, 180000);
  assert.deepEqual(ascentDescent([100, 102, 99, 103, 98].map((ele) => ({ ele })), 5), { ascent: 0, descent: 0 });
  assert.equal(cumulativeDistance(pts).length, 4);
  assert.equal(computeStats([[{ lat: 1, lon: 1 }]]).durationMs, undefined);
});

test('time: lenient parsing of real-world timestamps', () => {
  assert.equal(timeMs('2024-05-01T10:00:00Z'), Date.UTC(2024, 4, 1, 10));
  assert.equal(timeMs({ time: '2007-10-16T15:37.04Z' }), Date.UTC(2007, 9, 16, 15, 37, 4), 'legacy sample.gpx variant');
  assert.equal(timeMs('2007-10-16 15:37:04'), Date.UTC(2007, 9, 16, 15, 37, 4));
  assert.equal(timeMs('2024-05-01T12:00:00+02:00'), Date.UTC(2024, 4, 1, 10));
  assert.ok(Number.isNaN(timeMs('gestern'))); assert.ok(Number.isNaN(timeMs({}))); assert.ok(Number.isNaN(timeMs(undefined)));
  assert.equal(isoTime(Date.UTC(2024, 0, 2, 3, 4, 5)), '2024-01-02T03:04:05Z');
  const s = computeStats([parseGpx(fx('sample.gpx')).tracks.flatMap((t) => t.segments.flatMap((g) => g.points))]);
  assert.ok(s.durationMs > 0, 'legacy track has a duration');
});

test('ops: merge, extract, reverse, split/join, track<->route', () => {
  const a = parseGpx(fx('utah.gpx')), b = parseGpx(fx('sample.gpx'));
  const m = ops.mergeDocs(a, b);
  assert.equal(m.routes.length, a.routes.length + b.routes.length);
  assert.equal(m.tracks.length, a.tracks.length + b.tracks.length);
  assert.equal(ops.mergeDocs(a, a).waypoints.length, a.waypoints.length, 'duplicate waypoints skipped');
  assert.equal(new Set([...m.routes, ...m.tracks, ...m.waypoints].map((x) => x.id)).size, m.routes.length + m.tracks.length + m.waypoints.length, 'ids unique');
  const t = b.tracks.find((x) => pointCount(x) > 20) || a.tracks[0];
  const ex = ops.extractItems(m, [m.tracks[0].id]);
  assert.equal(ex.tracks.length, 1); assert.equal(ex.routes.length, 0);
  const rev = ops.reverseTrack(t);
  assert.deepEqual([trackPoints(rev)[0].lat, trackPoints(rev)[0].lon], [trackPoints(t).at(-1).lat, trackPoints(t).at(-1).lon]);
  assert.ok(trackPoints(rev).every((p) => !p.time));
  assert.ok(trackPoints(t).some((p) => p.time) === trackPoints(t).some((p) => p.time), 'original untouched');
  const joined = ops.joinSegments(t);
  const split = ops.splitSegmentAt(joined, 0, 5);
  assert.equal(split.segments.length, 2); assert.equal(split.segments[0].points.length, 6);
  assert.equal(pointCount(split), pointCount(joined) + 1);
  assert.equal(ops.segmentsToTracks(split).length, 2);
  const r = ops.trackToRoute(t, 12);
  assert.ok(r.points.length <= 12 && r.points.length >= 2);
  assert.equal(pointCount(ops.routeToTrack(r)), r.points.length);
  const np = ops.nearestPoint(joined, joined.segments[0].points[7]);
  assert.equal(np.pointIndex, 7);
});
