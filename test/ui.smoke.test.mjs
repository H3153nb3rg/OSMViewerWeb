// End-to-end smoke test of the browser UI against a fake DOM (no browser needed):
// start-up, file drop, selection, editing gestures, undo, optimizer, repair,
// search, save and the print preview. It guards the wiring, not the pixels.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom } from './helpers/fakedom.mjs';
import { timeMs } from '../src/core/time.js';

const env = installDom(new URL('../index.html', import.meta.url));
const { document, window } = env;
const $ = (s) => document.querySelector(s);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const fileOf = (name) => ({ name, text: async () => fx(name) });
let store, state, map, act, editor, gpx, closeFileAsk;

const realFetch = globalThis.fetch;
before(async () => {
  // pretend serve.mjs is running: /api/info answers, everything else is offline
  globalThis.fetch = async (url) => (String(url) === '/api/info'
    ? { ok: true, json: async () => ({ app: 'osmviewer-web', cache: true, root: 'C:/Users/x/AppData/Roaming/JF/OSMViewer', archives: [{ store: 'My Topo', minZoom: 9, maxZoom: 16 }] }) }
    : Promise.reject(new TypeError('offline')));
  ({ closeFileAsk } = await import('../src/ui/app.js'));
  store = await import('../src/ui/store.js'); act = await import('../src/ui/actions.js');
  editor = await import('../src/ui/editor.js'); gpx = await import('../src/core/gpx.js');
  state = store.state; map = window.osmviewer.map;
});

afterEach(() => {
  // a null child passed to replaceChildren()/append() shows up as the literal text "null"
  for (const sel of ['#tree', '#props', '#toolbar', '#status', '#profile']) {
    assert.doesNotMatch($(sel).textContent, /null|undefined|NaN/, `stray text in ${sel}: ${$(sel).textContent.slice(0, 300)}`);
  }
});
const canvas = () => $('#map');
const pointer = (type, x, y, extra = {}) => canvas().fire(type, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, ...extra });
const clickAt = (x, y) => { pointer('pointerdown', x, y); pointer('pointerup', x, y); };
const screen = (p) => [map.transform.x(p.lon), map.transform.y(p.lat)];
const buttonByText = (root, text) => root.querySelectorAll('button').find((b) => b.textContent.trim() === text);
const openDialogEl = () => document.querySelectorAll('dialog').filter((d) => d.open).pop();

test('local server detected: disk cache for tiles, archive layers offered', async () => {
  await tick(10);
  assert.ok(state.localServer && state.localServer.cache);
  assert.match($('#base').textContent, /Archiv: My Topo/);
  assert.equal($('#cacheinfo').textContent, 'Cache: lokal'); assert.match($('#cacheinfo').title, /JF\/OSMViewer/);
  map.setView({ lat: 10, lon: 10 }, 9); map.render();
  assert.ok(env.tiles.some((u) => /^\/tiles\/osm\/9\/\d+\/\d+$/.test(u)), 'tiles via the local cache');
  const base = $('#base');
  base.value = 'archive-my-topo'; base.fire('change', { target: base });
  map.render();
  assert.ok(env.tiles.some((u) => /^\/archive\/My%20Topo\/9\//.test(u)), 'archive tiles from disk');
  base.value = 'osm'; base.fire('change', { target: base });
});

test('start-up: layers, toolbar and empty state', () => {
  assert.equal($('#base').children.length >= 8, true);
  assert.match($('#attribution').textContent, /OpenStreetMap/);
  assert.match($('#tree').textContent, /Noch keine Daten/);
  assert.equal($('[data-cmd="undo"]').disabled, true);
  assert.ok(env.tiles.length > 0, 'tiles requested');
  assert.match(env.tiles[0], /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/, 'before detection: direct');
  assert.match($('#zoominfo').textContent, /Zoom/);
});

test('single file: name is shown; "+ Route" appears in the list at once and vanishes if unused', async () => {
  assert.equal(state.files.length, 1);
  assert.match($('#tree').querySelector('.file-head').textContent, /unbenannt\.gpx/, 'file name visible with one file');
  assert.match($('#tree').textContent, /Routen \(0\)/); assert.match($('#tree').textContent, /Wegpunkte \(0\)/);
  const undoDepth = state.undoStack.length;
  $('[data-cmd="tool-route"]').click();
  assert.equal(state.doc.routes.length, 1, 'route exists before the first click');
  assert.match($('#tree').textContent, /Routen \(1\)/); assert.match($('#tree').textContent, /Route 1/); assert.match($('#tree').textContent, /wird gezeichnet · 0 Pkt/);
  assert.equal(state.selection.type, 'route'); assert.match($('#props').textContent, /Route/);
  assert.equal($('#maphint').hidden, false); assert.match($('#maphint-text').textContent, /Route zeichnen/);
  // rubber band preview follows the mouse
  canvas().fire('pointermove', { clientX: 150, clientY: 150, pointerId: 9 });
  assert.equal(editor.ghost().label, 'Startpunkt setzen');
  clickAt(150, 150);
  canvas().fire('pointermove', { clientX: 400, clientY: 150, pointerId: 9 });
  const g = editor.ghost();
  assert.ok(g.from && /km|m$/.test(g.label), 'distance to the next point: ' + g.label);
  assert.match($('#tree').textContent, /wird gezeichnet · 1 Pkt/);
  map.render(); assert.ok(canvas().getContext('2d').calls.setLineDash > 0);
  store.undo(); store.undo();
  assert.equal(state.doc.routes.length, 0);
  document.fire('keydown', { key: 'Escape', target: document.body });
  assert.equal(state.tool, 'select');
  // start again and leave without a point: nothing remains, no undo step either
  buttonByText($('#tree'), '＋').click();
  assert.equal(state.tool, 'route'); assert.equal(state.doc.routes.length, 1);
  const depth = state.undoStack.length;
  buttonByText($('#maphint'), 'Fertig (Esc)').click();
  assert.equal(state.tool, 'select'); assert.equal(state.doc.routes.length, 0, 'unused route discarded');
  assert.equal(state.undoStack.length, depth - 1); assert.equal($('#maphint').hidden, true); assert.equal(editor.ghost(), null);
  // waypoint tool via the list "+"
  const plus = $('#tree').querySelectorAll('button').filter((b) => b.textContent === '＋')[1];
  plus.click(); assert.equal(state.tool, 'waypoint'); assert.match($('#tree').textContent, /Jeder Klick in die Karte/);
  canvas().fire('pointermove', { clientX: 200, clientY: 200, pointerId: 9 });
  assert.equal(editor.ghost().kind, 'waypoint');
  document.fire('keydown', { key: 'Escape', target: document.body });
  assert.equal(state.tool, 'select');
  while (state.undoStack.length > undoDepth) store.undo();
  state.redoStack.length = 0; state.active.dirty = false;
});

test('coordinate grid on the map follows the chosen format', async () => {
  map.setView({ lat: 47.26, lon: 11.4 }, 12); await tick();
  const ctx = canvas().getContext('2d');
  const grid = $('#grid');
  const draw = (mode, fmt) => {
    grid.value = mode; grid.fire('change', { target: grid }); state.settings.coordFormat = fmt;
    ctx.texts.length = 0; map.render();
    return ctx.texts.slice();
  };
  assert.ok(draw('grid', 'dd').some((t) => /^\d+\.\d+° [NE]$/.test(t)), 'degree labels');
  assert.ok(draw('grid', 'utm').some((t) => /^[EN] \d+ km$/.test(t)), 'UTM labels');
  const corners = draw('corners', 'utm').filter((t) => /^32T \d{6} \d{7}$/.test(t));
  assert.equal(corners.length, 4, 'four corner coordinates');
  assert.ok(!draw('none', 'dd').some((t) => /° [NE]$/.test(t)));
  assert.match(env.storage.get('osmviewer-web.settings.v1'), /"grid":"none"/);
});

test('drop a legacy GPX file, then compare two more and take data over', async () => {
  window.fire('drop', { dataTransfer: { files: [fileOf('sample.gpx')] } });
  await tick();
  const n = { w: state.doc.waypoints.length, r: state.doc.routes.length, t: state.doc.tracks.length };
  assert.ok(n.w + n.r + n.t > 0);
  assert.equal(state.fileName, 'sample.gpx'); assert.equal(state.dirty, false); assert.equal(state.files.length, 1);
  const work = state.active;
  // dropping onto a workspace with data opens the files for comparison only
  window.fire('drop', { dataTransfer: { files: [fileOf('utah.gpx'), fileOf('Startplätze.kml')] } });
  await tick();
  assert.equal(state.files.length, 3); assert.equal(state.active, work, 'working file stays active');
  assert.deepEqual(state.files.slice(1).map((f) => f.temp), [true, true]);
  assert.equal(state.doc.routes.length, n.r, 'nothing merged unasked'); assert.equal(work.dirty, false);
  assert.match($('#tree').textContent, /temporär/); assert.match($('#tree').textContent, /Arbeitsdatei/);
  assert.match($('#tree').textContent, /\d+ neu · \d+ teilweise · \d+ vorhanden/);
  map.render();
  assert.ok(canvas().getContext('2d').calls.setLineDash > 0, 'comparison files drawn dashed');
  // take all of utah.gpx over via the file header button
  const utahHead = $('#tree').querySelectorAll('.file-head').find((el) => /utah\.gpx/.test(el.textContent));
  buttonByText(utahHead, 'Alles').click();
  assert.equal(state.active, work); assert.ok(state.doc.routes.length > n.r, 'routes taken over');
  assert.ok(state.doc.routes.every((r) => r.src === 'utah.gpx'), 'data source recorded');
  assert.equal(work.dirty, true);
  assert.match($('#tree').textContent, /← utah\.gpx/);
  // utah is now fully contained in the working file
  const utah = state.files.find((f) => f.name === 'utah.gpx');
  assert.match($('#tree').querySelectorAll('.file-head').find((el) => /utah\.gpx/.test(el.textContent)).textContent, /^.*0 neu · 0 teilweise/s);
  // only the new waypoints of the KML file
  const kmlHead = $('#tree').querySelectorAll('.file-head').find((el) => /Startplätze/.test(el.textContent));
  const before = state.doc.waypoints.length;
  buttonByText(kmlHead, 'Neue übernehmen').click();
  assert.ok(state.doc.waypoints.length > before);
  const again = state.doc.waypoints.length;
  buttonByText($('#tree').querySelectorAll('.file-head').find((el) => /Startplätze/.test(el.textContent)), 'Alles').click();
  store.undo(); assert.equal(state.doc.waypoints.length, again, 'undo of a transfer');
  // close the temporary files: no question asked
  await closeFileAsk(utah.id);
  assert.equal(state.files.length, 2);
  assert.equal($('[data-cmd="undo"]').disabled, false);
  assert.ok(canvas().getContext('2d').calls.stroke > 0, 'vector overlay drawn');
});

test('select in another file, copy and move items between files', async () => {
  const kml = state.files.find((f) => f.temp);
  const w = kml.doc.waypoints[0];
  map.setView(w, 15); await tick();
  // the same waypoint now also exists in the working file, which wins the click — hide it for this test
  const home = state.active; home.visible = false;
  // click on a waypoint of the comparison file: its file becomes active, no drag
  const [x, y] = screen(w);
  pointer('pointerdown', x, y - 10); pointer('pointermove', x + 40, y); pointer('pointerup', x + 40, y);
  assert.equal(state.active, kml); assert.equal(state.selection.id, w.id);
  home.visible = true;
  assert.deepEqual([w.lat, w.lon], [kml.doc.waypoints[0].lat, kml.doc.waypoints[0].lon], 'first click does not move data of another file');
  const panel = $('#props');
  assert.match(panel.textContent, /Datei & Herkunft/); assert.match(panel.textContent, /Vergleich mit/);
  const work = store.workFile();
  assert.notEqual(work, kml);
  const nw = work.doc.waypoints.length, nk = kml.doc.waypoints.length;
  buttonByText(panel, 'Verschieben').click();
  assert.equal(work.doc.waypoints.length, nw + 1); assert.equal(kml.doc.waypoints.length, nk - 1);
  assert.equal(work.doc.waypoints.at(-1).src, kml.name);
  store.undo();
  assert.equal(work.doc.waypoints.length, nw); assert.equal(kml.doc.waypoints.length, nk, 'one undo step covers both files');
  // back to the working file via the file header
  store.activate(work.id);
  assert.equal(state.active, work);
  store.closeFile(kml.id);
  assert.equal(state.files.length, 1);
});

test('select a track: properties, statistics and elevation profile', async () => {
  const track = state.doc.tracks.slice().sort((a, b) => gpx.pointCount(b) - gpx.pointCount(a))[0];
  store.select({ type: 'track', id: track.id });
  assert.match($('#props').textContent, /Track/); assert.match($('#props').textContent, /Länge/);
  assert.equal($('#profile').hidden, false);
  $('#profile-canvas').fire('pointermove', { clientX: 300, clientY: 50 });
  assert.ok(state.hoverPoint, 'profile hover highlights a point'); assert.match($('#profile-info').textContent, /km|m/);
  act.zoomToSelection(); await tick();
  const [x, y] = screen(track.segments[0].points[0]);
  assert.ok(x > 0 && x < map.width && y > 0 && y < map.height, 'track start is in view after zoom');
  const name = $('#props').querySelector('[name="name"]');
  name.value = 'Umbenannt'; name.fire('change');
  assert.equal(store.findItem().item.name, 'Umbenannt');
  store.undo(); assert.notEqual(store.findItem().item.name, 'Umbenannt');
});

test('drag a vertex, insert and delete points, undo', async () => {
  const f = store.findItem(); const pts = f.item.segments[0].points;
  const before = { lat: pts[3].lat, lon: pts[3].lon }, count = pts.length;
  map.setView(pts[3], 17); await tick();
  const [x, y] = screen(pts[3]);
  pointer('pointerdown', x, y); pointer('pointermove', x + 30, y + 20); pointer('pointerup', x + 30, y + 20);
  const moved = store.findItem().item.segments[0].points[3];
  assert.equal(state.selection.pointIndex, 3);
  assert.ok(Math.abs(moved.lat - before.lat) > 1e-6 && Math.abs(moved.lon - before.lon) > 1e-6, 'vertex moved');
  const back = screen(moved); assert.ok(Math.abs(back[0] - (x + 30)) < 0.5 && Math.abs(back[1] - (y + 20)) < 0.5, 'vertex is under the cursor');
  store.undo();
  const restored = store.findItem().item.segments[0].points[3];
  assert.deepEqual([restored.lat, restored.lon], [before.lat, before.lon]);
  // double click on the selected line between two vertices inserts a point
  map.setView(pts[3], 21); await tick(); // zoom in until neighbouring vertices are clearly apart
  const p = store.findItem().item.segments[0].points; const a = screen(p[3]), b = screen(p[4]);
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) > 30, 'vertices far enough apart for the test');
  canvas().fire('dblclick', { clientX: (a[0] + b[0]) / 2, clientY: (a[1] + b[1]) / 2 });
  assert.equal(store.findItem().item.segments[0].points.length, count + 1);
  assert.equal(state.selection.pointIndex, 4);
  const ins = store.findItem().item.segments[0].points[4];
  if (p[3].time && p[5].time) assert.ok(timeMs(ins) >= timeMs(p[3]) && timeMs(ins) <= timeMs(p[5]) && Number.isFinite(timeMs(ins)), 'time interpolated');
  document.fire('keydown', { key: 'Delete', target: document.body });
  assert.equal(store.findItem().item.segments[0].points.length, count);
});

test('waypoint and route tools', async () => {
  const w0 = state.doc.waypoints.length, r0 = state.doc.routes.length;
  store.select(null);
  $('[data-cmd="tool-waypoint"]').click();
  assert.equal($('[data-cmd="tool-waypoint"]').getAttribute('aria-pressed'), 'true');
  clickAt(200, 200);
  assert.equal(state.doc.waypoints.length, w0 + 1); assert.equal(state.selection.type, 'waypoint');
  const coord = $('#props').querySelector('[name="coord"]');
  coord.value = 'N 48° 12.492\' E 016° 22.428\''; coord.fire('change');
  assert.ok(Math.abs(store.findItem().item.lat - 48.2082) < 1e-5);
  coord.value = 'Unsinn'; coord.fire('change');
  assert.ok(Math.abs(store.findItem().item.lat - 48.2082) < 1e-5, 'invalid input rejected');
  store.select(null);
  document.fire('keydown', { key: 'r', target: document.body });
  assert.equal(state.tool, 'route');
  clickAt(100, 100); clickAt(200, 150); clickAt(300, 120); clickAt(300, 120);
  canvas().fire('dblclick', { clientX: 300, clientY: 120 });
  assert.equal(state.tool, 'select'); assert.equal(state.doc.routes.length, r0 + 1);
  assert.equal(state.doc.routes.at(-1).points.length, 3, 'double click does not leave a duplicate point');
  act.routeToTrackSelected();
  assert.equal(state.selection.type, 'track');
});

test('route points by coordinate input: append, insert after selection, several lines, errors', async () => {
  document.fire('keydown', { key: 'r', target: document.body });
  document.fire('keydown', { key: 'Escape', target: document.body }); // empty route is discarded …
  $('[data-cmd="tool-route"]').click();                               // … so keep the tool on while typing
  const id = state.selection.id;
  const form = () => $('#props').querySelector('.addpoint');
  const type = (text, name = '') => { form().querySelector('[name="addcoord"]').value = text; form().querySelector('[name="addname"]').value = name; buttonByText(form(), 'Hinzufügen').click(); };
  assert.match(form().textContent, /Anhängen als Punkt 1/);
  type('47.2692, 11.4041', 'Innsbruck');
  let pts = store.findItem().item.points;
  assert.equal(pts.length, 1); assert.equal(pts[0].name, 'Innsbruck'); assert.ok(Math.abs(pts[0].lat - 47.2692) < 1e-9);
  assert.equal(state.selection.pointIndex, 0);
  const [x, y] = screen(pts[0]); assert.ok(x > 0 && x < map.width && y > 0 && y < map.height, 'map shows the new point');
  // several notations at once; inserted after the selected point
  type("N 47° 23.340' E 011° 15.840'\n32T 681960 5237970\n47°30'00\"N 11°06'00\"E");
  pts = store.findItem().item.points;
  assert.equal(pts.length, 4); assert.ok(Math.abs(pts[1].lat - 47.389) < 1e-6 && Math.abs(pts[1].lon - 11.264) < 1e-6);
  assert.ok(Math.abs(pts[3].lat - 47.5) < 1e-9 && Math.abs(pts[3].lon - 11.1) < 1e-9);
  assert.equal(state.selection.pointIndex, 3);
  // select point 1 -> next input goes between 1 and 2
  store.select({ type: 'route', id, pointIndex: 0 });
  assert.match(form().textContent, /Einfügen nach Punkt 1/);
  type('JN57qg');
  pts = store.findItem().item.points;
  assert.equal(pts.length, 5); assert.equal(state.selection.pointIndex, 1); assert.equal(pts[0].name, 'Innsbruck'); assert.ok(Math.abs(pts[2].lat - 47.389) < 1e-6);
  // one bad line: nothing is added
  type('47.1, 11.2\nirgendwo\n47.2 11.3');
  assert.equal(store.findItem().item.points.length, 5);
  assert.match($('#toast').textContent, /Nicht erkannt: irgendwo/);
  // Enter in the field adds, one undo step per input
  const ta = form().querySelector('[name="addcoord"]'); ta.value = '47.3 11.5';
  ta.fire('keydown', { key: 'Enter' });
  assert.equal(store.findItem().item.points.length, 6);
  store.undo(); assert.equal(store.findItem().item.points.length, 5);
  assert.match($('#props').querySelector('table.points').textContent, /47\.269200, 11\.404100/, 'coordinates listed per point');
  document.fire('keydown', { key: 'Escape', target: document.body });
  assert.equal(state.doc.routes.some((r) => r.id === id), true, 'route with typed points is kept');
});

test('"Punkt zeigen" centres on the point, "Ganze Route zeigen" returns to the overview', async () => {
  const route = state.doc.routes.find((r) => r.points.length > 3);
  store.select({ type: 'route', id: route.id, pointIndex: 1 });
  const inView = (p) => { const [x, y] = screen(p); return x >= 0 && x <= map.width && y >= 0 && y <= map.height; };
  buttonByText($('#props'), 'Punkt zeigen').click(); await tick();
  const [px, py] = screen(route.points[1]);
  assert.ok(Math.abs(px - map.width / 2) < 1 && Math.abs(py - map.height / 2) < 1, 'point centred');
  const zoomedIn = map.zoom;
  assert.ok(zoomedIn >= 15);
  assert.ok(!route.points.every(inView), 'precondition: zoomed in so far that the route is not completely visible');
  assert.equal(state.selection.pointIndex, 1, 'point still selected');
  buttonByText($('#props'), 'Ganze Route zeigen').click(); await tick();
  assert.ok(route.points.every(inView), 'whole route visible again');
  assert.ok(map.zoom < zoomedIn, 'zoomed out to the overview');
  const xs = route.points.map((p) => screen(p)[0]), ys = route.points.map((p) => screen(p)[1]);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - map.width / 2) < 2 && Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - map.height / 2) < 2, 'route centred');
  assert.equal(state.selection.pointIndex, 1, 'selection untouched');
  // same for tracks
  const track = state.doc.tracks.slice().sort((a, b) => gpx.pointCount(b) - gpx.pointCount(a))[0];
  store.select({ type: 'track', id: track.id, segIndex: 0, pointIndex: 2 });
  buttonByText($('#props'), 'Punkt zeigen').click(); await tick();
  buttonByText($('#props'), 'Ganzen Track zeigen').click(); await tick();
  assert.ok(track.segments.flatMap((g) => g.points).every(inView), 'whole track visible');
});

test('optimizer with live preview', async () => {
  const track = state.doc.tracks.slice().sort((a, b) => gpx.pointCount(b) - gpx.pointCount(a))[0];
  const total = gpx.pointCount(track);
  store.select({ type: 'track', id: track.id });
  act.openOptimizer();
  const dlg = openDialogEl();
  assert.ok(state.preview && state.preview.segments.length, 'preview shown');
  dlg.querySelector('select').value = 'percent'; // switch mode through the control's handler
  dlg.querySelector('select').fire('change', { target: dlg.querySelector('select') });
  const number = dlg.querySelector('input[type="number"]');
  number.value = '20'; number.fire('input');
  assert.match(dlg.querySelector('.result').textContent, /→/);
  buttonByText(dlg, 'Übernehmen').click(); await tick();
  assert.equal(state.preview, null, 'preview removed on close');
  const after = gpx.pointCount(store.findItem().item);
  assert.ok(after < total && after >= 2, `${total} -> ${after}`);
  store.undo();
  assert.equal(gpx.pointCount(store.findItem({ type: 'track', id: track.id }).item), total);
});

test('repair dialog and conversions', async () => {
  const track = state.doc.tracks.slice().sort((a, b) => gpx.pointCount(b) - gpx.pointCount(a))[0];
  store.select({ type: 'track', id: track.id });
  act.openRepair();
  buttonByText(openDialogEl(), 'Anwenden').click(); await tick();
  assert.ok(store.findItem().item.segments.length >= 1);
  act.reverseSelected(); act.duplicateSelected();
  assert.match(store.findItem().item.name, /Kopie/);
  act.trackToRouteDialog();
  buttonByText(openDialogEl(), 'Umwandeln').click(); await tick();
  assert.equal(state.selection.type, 'route'); assert.ok(store.findItem().item.points.length <= 50);
});

test('search box understands coordinates', async () => {
  $('#search').value = '33U 601938 5340376';
  $('#searchform').fire('submit');
  assert.ok(state.marker && Math.abs(state.marker.lat - 48.2084) < 1e-3);
  assert.equal($('#results').hidden, false);
  const w0 = state.doc.waypoints.length;
  $('#results').querySelectorAll('button')[1].click();
  assert.equal(state.doc.waypoints.length, w0 + 1);
});

test('search marker can be removed in every obvious way', async () => {
  const find = (q) => { $('#search').value = q; $('#searchform').fire('submit'); };
  const markerPos = () => screen(state.marker);
  store.select(null);
  find('47.2692, 11.4041');
  assert.ok(state.marker); assert.equal($('#clearmarker').hidden, false, 'remove button appears next to the search field');
  $('#clearmarker').click();
  assert.equal(state.marker, null); assert.equal($('#clearmarker').hidden, true); assert.equal($('#search').value, '');
  // emptying the search field (e.g. with its ✕)
  find('47.2692, 11.4041'); $('#search').value = ''; $('#search').fire('input');
  assert.equal(state.marker, null);
  // Entf and Esc on the map
  find('47.2692, 11.4041'); document.fire('keydown', { key: 'Delete', target: document.body });
  assert.equal(state.marker, null, 'Entf removes the marker when nothing is selected');
  find('47.2692, 11.4041'); document.fire('keydown', { key: 'Escape', target: document.body });
  assert.equal(state.marker, null);
  // click on the marker opens its menu
  find('47.2692, 11.4041'); await tick();
  let [x, y] = markerPos();
  assert.equal(editor.hoverCursor(map, x, y - 12), 'pointer');
  clickAt(x, y - 12);
  assert.match($('#ctxmenu').textContent, /Suchmarker entfernen/); assert.match($('#ctxmenu').textContent, /Route von hier/);
  buttonByText($('#ctxmenu'), 'Suchmarker entfernen').click();
  assert.equal(state.marker, null);
  // right click works too; adopting turns it into a real waypoint and removes the mark
  find('47.2692, 11.4041'); await tick(); [x, y] = markerPos();
  const n = state.doc.waypoints.length;
  canvas().fire('contextmenu', { clientX: x, clientY: y - 12 });
  buttonByText($('#ctxmenu'), 'Als Wegpunkt übernehmen').click();
  assert.equal(state.marker, null); assert.equal(state.doc.waypoints.length, n + 1);
  assert.equal(state.selection.type, 'waypoint');
  document.fire('keydown', { key: 'Delete', target: document.body });
  assert.equal(state.doc.waypoints.length, n, 'the adopted waypoint is a normal, deletable waypoint');
});

test('navigation route between any two points', async () => {
  const requests = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const m = /route\/v1\/driving\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)\?/.exec(String(url));
    if (!m) throw new TypeError('offline');
    const [lon1, lat1, lon2, lat2] = m.slice(1).map(Number);
    return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 12345, duration: 900,
      geometry: { coordinates: [[lon1, lat1], [(lon1 + lon2) / 2, lat1], [lon2, lat2]] } }], waypoints: [] }) };
  };
  try {
    store.select(null);
    map.setView({ lat: 47.27, lon: 11.4 }, 12); await tick();
    const r0 = state.doc.routes.length, t0 = state.doc.tracks.length;
    // start: any map position via right click
    canvas().fire('contextmenu', { clientX: 200, clientY: 300 });
    buttonByText($('#ctxmenu'), 'Route von hier (Start)').click();
    assert.ok(state.nav.start && !state.nav.end);
    assert.equal($('#navhint').hidden, false); assert.match($('#navhint-text').textContent, /Start gesetzt/);
    assert.equal(state.doc.routes.length, r0, 'nothing created yet');
    map.render(); assert.ok(canvas().getContext('2d').texts.includes('Start'), 'start flag drawn');
    const prof = $('#navprofile'); prof.value = 'foot'; prof.fire('change', { target: prof });
    // destination: a search result
    $('#search').value = '47.30, 11.60'; $('#searchform').fire('submit');
    buttonByText($('#results'), 'Ziel').click();
    await tick(20);
    assert.equal(state.doc.routes.length, r0 + 1); assert.equal(state.doc.tracks.length, t0 + 1);
    const route = state.doc.routes.at(-1), track = state.doc.tracks.at(-1);
    assert.equal(route.points.length, 2); assert.ok(Math.abs(route.points[1].lat - 47.3) < 1e-9 && Math.abs(route.points[1].lon - 11.6) < 1e-9);
    assert.match(route.name, / → /); assert.match(track.name, /Zu Fuß/); assert.match(track.desc, /12,3 km/);
    assert.equal(track.segments[0].points.length, 3);
    assert.equal(requests.filter((u) => /routed-foot\/route/.test(u)).length, 1, 'profile from the banner is used');
    assert.deepEqual(state.nav, { start: null, end: null }); assert.equal($('#navhint').hidden, true); assert.equal(state.marker, null);
    // other order: destination first (a waypoint from its properties), start second; Esc cancels
    editor.addWaypoint({ lat: 47.25, lon: 11.35 }, 'Hütte');
    buttonByText($('#props'), 'Route hierher').click();
    assert.ok(state.nav.end && state.nav.end.name === 'Hütte'); assert.match($('#navhint-text').textContent, /Ziel gesetzt/);
    document.fire('keydown', { key: 'Escape', target: document.body });
    assert.deepEqual(state.nav, { start: null, end: null }, 'Esc cancels');
    buttonByText($('#props'), 'Route hierher').click();
    canvas().fire('contextmenu', { clientX: 500, clientY: 100 });
    buttonByText($('#ctxmenu'), 'Route von hier (Start)').click();
    await tick(20);
    assert.equal(state.doc.routes.length, r0 + 2); assert.match(state.doc.routes.at(-1).name, / → Hütte$/);
    assert.equal(state.doc.routes.at(-1).points[1].name, 'Hütte');
    // routing service down: the route stays so it can be recomputed
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    canvas().fire('contextmenu', { clientX: 100, clientY: 100 }); buttonByText($('#ctxmenu'), 'Route von hier (Start)').click();
    canvas().fire('contextmenu', { clientX: 600, clientY: 400 }); buttonByText($('#ctxmenu'), 'Route hierher (Ziel)').click();
    await tick(20);
    assert.equal(state.doc.routes.length, r0 + 3); assert.equal(state.doc.tracks.length, t0 + 2, 'no track without the service');
    assert.match($('#toast').textContent, /Routing/);
  } finally { globalThis.fetch = prev; }
});

test('poster export: designs, styles, editable figures, topo, raster fallback, SVG and PNG', async () => {
  const { encodeTile } = await import('./helpers/mvtencode.mjs');
  const { parseXml } = await import('../src/core/xml.js');
  const { forgetBasemap } = await import('../src/services/vectortiles.js');
  const tile = encodeTile({ water: { features: [{ type: 3, props: {}, geometry: [[[0, 0], [4096, 0], [4096, 900], [0, 900], [0, 0]]] }] },
    transportation: { features: [{ type: 2, props: { class: 'motorway' }, geometry: [[[0, 2000], [4096, 2100]]] }, { type: 2, props: { class: 'path' }, geometry: [[[0, 3000], [4096, 3100]]] }] },
    mountain_peak: { features: [{ type: 1, props: { name: 'Testspitze', ele: 2345, rank: 1 }, geometry: [[2048, 1500]] }] },
    place: { features: [{ type: 1, props: { class: 'city', name: 'Teststadt', rank: 3 }, geometry: [[2048, 2048]] }] } });
  const requested = [];
  const prev = globalThis.fetch;
  let failVector = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    requested.push(u);
    if (u.startsWith('/api/elevgrid')) {
      const q = new URL(u, 'http://x').searchParams, cols = +q.get('cols'), rows = +q.get('rows');
      return { ok: true, status: 200, json: async () => ({ south: +q.get('south'), west: +q.get('west'), north: +q.get('north'), east: +q.get('east'), cols, rows, known: cols * rows,
        data: Array.from({ length: cols * rows }, (_, i) => 500 + 900 * (Math.floor(i / cols) / rows) + 300 * ((i % cols) / cols)) }) };
    }
    if (!/^\/vector\/(\d+)\/(\d+)\/(\d+)$/.test(u) || failVector) throw new TypeError('offline');
    return { ok: true, status: 200, arrayBuffer: async () => tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength) };
  };
  const blobs = [];
  const origCreate = URL.createObjectURL; URL.createObjectURL = (b) => { blobs.push(b); return 'blob:poster' + blobs.length; };
  const current = async () => { await tick(40); const svg = await blobs.at(-1).text(); parseXml(svg); return svg; };
  try {
    forgetBasemap();
    // a route has no times: no duration is invented, but one can be typed in
    const route = state.doc.routes.find((r) => r.points.length > 3);
    store.select({ type: 'route', id: route.id });
    buttonByText($('#props'), 'Poster …').click();
    let dlg = openDialogEl();
    let svg = await current();
    const stats = dlg.querySelector('[name="pstats"]');
    assert.match(stats.value, /^Distanz: /); assert.doesNotMatch(stats.value, /Dauer|Tage/, 'route: no duration from data');
    assert.doesNotMatch(svg, />DAUER</);
    stats.value += '\nDauer: 3 Tage\nUnterwegs mit: Rad'; stats.fire('change');
    svg = await current();
    assert.match(svg, />3 Tage</); assert.match(svg, />DAUER</); assert.match(svg, />UNTERWEGS MIT</);
    stats.value = ''; stats.fire('change'); svg = await current();
    assert.doesNotMatch(svg, /id="stats"/, 'figures can be removed entirely');
    buttonByText(dlg, 'Kennzahlen aus Daten').click(); svg = await current();
    assert.match(svg, />DISTANZ</); assert.match(stats.value, /^Distanz: /);
    dlg.close();

    const track = state.doc.tracks.slice().sort((a, b) => gpx.pointCount(b) - gpx.pointCount(a))[0];
    store.select({ type: 'track', id: track.id });
    buttonByText($('#props'), 'Poster …').click();
    dlg = openDialogEl();
    svg = await current();
    assert.match(dlg.querySelector('.poster-preview').src, /^blob:poster/);
    assert.match(dlg.querySelector('.result').textContent, /A3 (hoch|quer) · Maßstab ca\. 1 : [\d.]+ · \d+ Kartenkacheln \(Zoom \d+\)/);
    assert.ok(requested.some((u) => /^\/vector\/\d+\/\d+\/\d+$/.test(u)), 'vector tiles via the local disk cache');
    assert.match(svg, /id="route"/); assert.match(svg, />Teststadt</); assert.match(svg, /id="attribution"/); assert.doesNotMatch(svg, />Testspitze/);
    // design picker: one thumbnail per layout, each a complete little poster of this track
    const designs = dlg.querySelectorAll('.designs button');
    assert.deepEqual(designs.map((b) => b.dataset.design), ['galerie', 'karte', 'atlas', 'kompass', 'horizont']);
    for (const b of designs) assert.match(decodeURIComponent(b.querySelector('img').getAttribute('src')), /^data:image\/svg\+xml;charset=utf-8,<\?xml[\s\S]*id="route"/);
    assert.equal(designs[0].getAttribute('aria-checked'), 'true');
    for (const [id, mark] of [['karte', /id="card"/], ['atlas', /id="atlas"/], ['kompass', /id="ring"/], ['horizont', /id="fadeout"/]]) {
      dlg.querySelectorAll('.designs button').find((b) => b.dataset.design === id).click();
      svg = await current();
      assert.match(svg, mark, id); assert.match(svg, /id="route"/); assert.match(svg, /id="title"/);
      assert.equal(dlg.querySelectorAll('.designs button').find((b) => b.dataset.design === id).getAttribute('aria-checked'), 'true');
    }
    // style picker and font
    const n = requested.length;
    assert.equal(dlg.querySelectorAll('.themes button').length, 7);
    dlg.querySelectorAll('.themes button').find((b) => b.dataset.theme === 'nacht').click();
    const title = dlg.querySelector('[name="ptitle"]'); title.value = 'Mein Sommer'; title.fire('change');
    const fontSel = dlg.querySelectorAll('select').find((s) => s.children.some((o) => o.value === 'journal')); fontSel.value = 'journal'; fontSel.fire('change');
    svg = await current();
    assert.match(svg, /fill="#111315"/); assert.match(svg, /<text id="title"[^>]*font-family="Georgia[^>]*font-style="italic"[^>]*>Mein Sommer</, 'journal font keeps the case');
    assert.equal(requested.length, n, 'no reload of map data while style, text and font change');
    // topo: contour lines from the elevation grid, peaks and paths from the tiles
    const mapSel = dlg.querySelector('[name="pmap"]');
    mapSel.value = 'topo'; mapSel.fire('change'); svg = await current();
    assert.ok(requested.some((u) => /^\/api\/elevgrid\?south=[\d.-]+&west=[\d.-]+&north=[\d.-]+&east=[\d.-]+&cols=\d+&rows=\d+$/.test(u)));
    assert.match(svg, /class="contour"/); assert.match(svg, /class="contour index"/); assert.match(svg, />Testspitze 2345</); assert.match(svg, /Höhen: SRTM/);
    assert.match(dlg.querySelector('.result').textContent, /Höhenlinien alle \d+ m/);
    // vector data unavailable: the note offers the raster map
    failVector = true; forgetBasemap();
    mapSel.value = 'vector'; mapSel.fire('change'); svg = await current();
    assert.match(dlg.querySelector('.poster-note').textContent, /Vektorkarte ist nicht erreichbar/);
    assert.match(svg, /id="route"/); assert.doesNotMatch(svg, /id="attribution"/);
    const tilesBefore = env.tiles.length;
    buttonByText(dlg, 'Stattdessen eine Rasterkarte verwenden').click(); svg = await current();
    assert.equal(mapSel.value, 'raster');
    assert.match(svg, /<image id="backdrop"[^>]*href="data:image\/jpeg;base64,AAAA"/); assert.match(svg, /id="route"/);
    assert.ok(env.tiles.slice(tilesBefore).some((u) => /^\/tiles\/opentopo\/\d+\/\d+\/\d+$/.test(u)), 'raster tiles of the chosen source via the local cache');
    assert.match(svg, /id="attribution"[^>]*>[^<]*OpenTopoMap/);
    assert.match(dlg.querySelector('.result').textContent, /OpenTopoMap: \d+ × \d+ px ≈ \d+ dpi/);
    // large format: the raster map is flagged as too coarse, the vector route stays sharp
    const size = dlg.querySelectorAll('select').find((s) => s.children.some((o) => o.value === 'A0')); size.value = 'A0'; size.fire('change');
    svg = await current();
    assert.match(svg, /width="(841|1189)mm" height="(1189|841)mm"/);
    // save
    buttonByText(dlg, 'SVG speichern').click(); await tick();
    assert.equal(blobs.at(-1).type, 'image/svg+xml'); assert.equal(await blobs.at(-1).text(), svg, 'saved file is what the preview shows');
    assert.ok(dlg.open, 'dialog stays open after saving');
    buttonByText(dlg, 'PNG speichern').click(); await tick(30);
    assert.equal(blobs.at(-1).type, '', 'png blob from the canvas');
    dlg.close();
  } finally { globalThis.fetch = prev; URL.createObjectURL = origCreate; }
});

test('save produces GPX that reads back identically', async () => {
  let saved = null;
  const orig = URL.createObjectURL; URL.createObjectURL = (blob) => { saved = blob; return 'blob:x'; };
  $('[data-cmd="save"]').click(); await tick();
  URL.createObjectURL = orig;
  const doc = gpx.parseGpx(await saved.text());
  assert.equal(doc.tracks.length, state.doc.tracks.length); assert.equal(doc.routes.length, state.doc.routes.length);
  assert.equal(doc.waypoints.length, state.doc.waypoints.length);
  assert.equal(state.dirty, false);
});

test('print: layout dialog, preview pages, browser print', async () => {
  const route = state.doc.routes.find((r) => r.points.length > 3);
  store.select({ type: 'route', id: route.id });
  $('[data-cmd="print"]').click();
  const dlg = openDialogEl();
  assert.equal(state.printPages.length, 1); assert.match(dlg.querySelector('.result').textContent, /1 Seite A4 (hoch|quer)/);
  const gridSel = dlg.querySelectorAll('select').find((s) => s.children.some((o) => o.value === 'both'));
  assert.equal(gridSel.value, 'corners', 'corner coordinates are printed by default');
  gridSel.value = 'both'; gridSel.fire('change');
  const fmtSel = dlg.querySelectorAll('select').find((s) => s.children.some((o) => o.value === 'mgrs'));
  fmtSel.value = 'utm'; fmtSel.fire('change');
  const selects = dlg.querySelectorAll('select');
  const modeSel = selects.find((s) => s.children.some((o) => o.value === 'pages'));
  modeSel.value = 'pages'; modeSel.fire('change');
  const scaleSel = selects.find((s) => s.children.some((o) => o.value === '25000'));
  scaleSel.value = '10000'; scaleSel.fire('change');
  const pages = state.printPages.length;
  assert.ok(pages >= 2, 'multi page layout: ' + pages);
  const tilesBefore = env.tiles.length;
  buttonByText(dlg, 'Druckvorschau').click();
  for (let i = 0; i < 200 && !/bereit/.test($('#print-root').textContent); i++) await tick(10);
  const sheets = $('#print-root').querySelectorAll('section');
  assert.equal(sheets.length, pages);
  assert.ok(env.tiles.length > tilesBefore, 'print tiles requested');
  for (const sh of sheets) {
    const c = sh.querySelector('canvas').getContext('2d').calls;
    assert.ok(c.drawImage > 0 && c.stroke > 0 && c.fillText > 0, 'page has tiles, route and labels');
    const printed = sh.querySelector('canvas').getContext('2d').texts;
    assert.ok(printed.some((t) => /^[EN] \d+(\.\d+)? (km|m)$/.test(t.replace(/\./g, ''))), 'UTM grid labels on the page');
    assert.equal(printed.filter((t) => /^\d{1,2}[C-X] \d{6} \d{7}$/.test(t)).length, 4, 'four corner coordinates on the page');
    assert.match(sh.getAttribute('style'), /width:(210|297)mm;height:(296\.6|209\.6)mm/);
  }
  assert.match($('#print-root').querySelector('style').textContent, /@page pp \{ size: 210mm 297mm/);
  assert.ok(document.body.classList.contains('previewing'));
  buttonByText($('#print-root'), 'Drucken / als PDF speichern').click();
  assert.equal(window.printed, 1);
  buttonByText($('#print-root'), 'Schließen').click();
  assert.equal($('#print-root').hidden, true); assert.ok(!document.body.classList.contains('previewing'));
  dlg.close();
  assert.equal(state.printPages, null);
});

test('context menu and settings dialog', async () => {
  const w = state.doc.waypoints[0];
  map.setView(w, 15); await tick();
  const [x, y] = screen(w);
  canvas().fire('contextmenu', { clientX: x, clientY: y - 10 });
  const menu = $('#ctxmenu');
  assert.ok(menu, 'menu shown'); assert.match(menu.textContent, /Wegpunkt löschen/);
  const n = state.doc.waypoints.length;
  buttonByText(menu, 'Wegpunkt löschen').click();
  assert.equal(state.doc.waypoints.length, n - 1); assert.equal($('#ctxmenu'), null);
  $('[data-cmd="settings"]').click();
  const dlg = openDialogEl();
  dlg.querySelector('select').value = 'utm';
  buttonByText(dlg, 'Speichern').click(); await tick();
  assert.equal(state.settings.coordFormat, 'utm');
  canvas().fire('pointermove', { clientX: 100, clientY: 100, pointerId: 9 });
  assert.match($('#coords').textContent, /^\d{1,2}[C-X] \d+ \d+$/);
  assert.match(env.storage.get('osmviewer-web.settings.v1'), /"coordFormat":"utm"/);
});
