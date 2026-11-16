import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeTile, decodeGeometry } from '../src/core/mvt.js';
import { encodeTile } from './helpers/mvtencode.mjs';
import { posterLayout, posterTiles, backdropSpec, buildPosterSvg, POSTER_SIZES, POSTER_THEMES, POSTER_LAYERS, POSTER_DESIGNS, POSTER_FONTS } from '../src/core/poster.js';
import { geoContours } from '../src/core/contours.js';
import { parseXml, childrenNamed, findDeep } from '../src/core/xml.js';
import { parseGpx, trackPoints } from '../src/core/gpx.js';
import { mercX, mercY, destination, haversine } from '../src/core/geo.js';

const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');

test('mvt: geometry commands from the specification', () => {
  // examples of the MVT spec, section 4.3.5
  assert.deepEqual(decodeGeometry(1, [9, 50, 34]), [[25, 17]]);
  assert.deepEqual(decodeGeometry(1, [17, 10, 14, 3, 9]), [[5, 7], [3, 2]]);
  assert.deepEqual(decodeGeometry(2, [9, 4, 4, 18, 0, 16, 16, 0]), [[[2, 2], [2, 10], [10, 10]]]);
  assert.deepEqual(decodeGeometry(2, [9, 4, 4, 18, 0, 16, 16, 0, 9, 17, 17, 10, 4, 8]), [[[2, 2], [2, 10], [10, 10]], [[1, 1], [3, 5]]]);
  assert.deepEqual(decodeGeometry(3, [9, 6, 12, 18, 10, 12, 24, 44, 15]), [[[3, 6], [8, 12], [20, 34], [3, 6]]]);
});

test('mvt: tile round trip against an independent encoder, layer filter, property types', () => {
  const src = {
    water: { features: [{ type: 3, props: { class: 'lake' }, geometry: [[[0, 0], [4096, 0], [4096, 2000], [0, 2000], [0, 0]], [[100, 100], [100, 300], [300, 300], [100, 100]]] }] },
    transportation: { extent: 2048, features: [
      { type: 2, props: { class: 'motorway', ref: 'A12', layer: -1, oneway: true, ratio: 0.25, big: 5000000000 }, geometry: [[[-64, 500], [1000, 520], [2112, 480]]] },
      { type: 2, props: { class: 'path' }, geometry: [[[1, 1], [2, 2]], [[10, 10], [20, 5], [30, 40]]] }] },
    place: { features: [{ type: 1, props: { class: 'city', name: 'Innsbruck', 'name:de': 'Innsbruck', rank: 6 }, geometry: [[2000, 2100]] }] },
    poi: { features: [{ type: 1, props: { class: 'cafe' }, geometry: [[1, 2]] }] },
  };
  const bytes = encodeTile(src);
  const all = decodeTile(bytes);
  assert.deepEqual(Object.keys(all).sort(), ['place', 'poi', 'transportation', 'water']);
  for (const [name, layer] of Object.entries(src)) {
    assert.equal(all[name].extent, layer.extent || 4096);
    assert.deepEqual(all[name].features.map((f) => f.geometry), layer.features.map((f) => f.geometry), name + ' geometry');
    assert.deepEqual(all[name].features.map((f) => f.props), layer.features.map((f) => f.props), name + ' properties');
    assert.deepEqual(all[name].features.map((f) => f.type), layer.features.map((f) => f.type));
  }
  const some = decodeTile(bytes, POSTER_LAYERS);
  assert.ok(!('poi' in some) && 'water' in some, 'unwanted layers are skipped');
  assert.deepEqual(decodeTile(new Uint8Array(0)), {});
  assert.throws(() => decodeTile(bytes.subarray(0, bytes.length - 7)), /MVT/);
});

test('poster layout: route fits the frame, orientation, scale, tiles', () => {
  const wide = [{ lat: 47.2, lon: 11.0 }, { lat: 47.3, lon: 12.2 }], tall = [{ lat: 46.5, lon: 11.3 }, { lat: 47.6, lon: 11.5 }];
  const Lw = posterLayout(wide, { size: POSTER_SIZES.A3 }), Lt = posterLayout(tall, { size: POSTER_SIZES.A3 });
  assert.equal(Lw.orientation, 'landscape'); assert.deepEqual([Lw.W, Lw.H], [420, 297]);
  assert.equal(Lt.orientation, 'portrait'); assert.deepEqual([Lt.W, Lt.H], [297, 420]);
  for (const [pts, L] of [[wide, Lw], [tall, Lt]]) {
    const xs = pts.map((p) => L.x(p.lon)), ys = pts.map((p) => L.y(p.lat)), F = L.frame;
    assert.ok(Math.min(...xs) > F.x && Math.max(...xs) < F.x + F.w && Math.min(...ys) > F.y && Math.max(...ys) < F.y + F.h, 'inside the frame');
    assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - (F.x + F.w / 2)) < 1e-6, 'centred');
    const fill = Math.max((Math.max(...xs) - Math.min(...xs)) / F.w, (Math.max(...ys) - Math.min(...ys)) / F.h);
    assert.ok(Math.abs(fill - 0.76) < 1e-6, 'route uses the frame minus padding: ' + fill);
    assert.ok(F.y + F.h + L.textH <= L.H - L.margin + 1e-9, 'text block fits below the map');
    // scale: distance on paper matches the ground distance
    const mm = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
    assert.ok(Math.abs(mm * L.metresPerMm / haversine(pts[0], pts[1]) - 1) < 0.01, 'metresPerMm');
    assert.ok(L.bounds.minLat < Math.min(pts[0].lat, pts[1].lat) && L.bounds.maxLon > Math.max(pts[0].lon, pts[1].lon));
  }
  // larger paper = same picture, larger scale factor
  const big = posterLayout(wide, { size: POSTER_SIZES['70 × 100 cm'] });
  assert.ok(Math.abs(big.k / Lw.k - 1000 / 420) < 0.01); assert.ok(Math.abs(big.unit / Lw.unit - 700 / 297) < 1e-9);
  assert.equal(posterLayout(wide, { orientation: 'portrait' }).orientation, 'portrait');
  assert.ok(posterLayout([{ lat: 47, lon: 11 }], {}).scale >= 1999, 'single point does not zoom in endlessly');
  assert.equal(posterLayout([], {}), null);
  const noText = posterLayout(wide, { textBlock: false }); assert.equal(noText.textH, 0); assert.ok(noText.frame.h > Lw.frame.h);

  const t = posterTiles(Lw, 4);
  assert.ok(t.z >= 9 && t.z <= 11, 'zoom ' + t.z); assert.ok(t.tiles.length >= 4 && t.tiles.length <= 48);
  const n = 2 ** t.z;
  const cover = (lat, lon) => t.tiles.some((q) => q.x === Math.floor(mercX(lon) * n) && q.y === Math.floor(mercY(lat) * n));
  assert.ok(cover(Lw.bounds.maxLat - 1e-6, Lw.bounds.minLon + 1e-6) && cover(Lw.bounds.minLat + 1e-6, Lw.bounds.maxLon - 1e-6) && cover(47.25, 11.6), 'tiles cover the whole frame');
  assert.ok(posterTiles(Lw, 16, 14, 400).z > t.z, 'more detail = higher zoom'); assert.ok(posterTiles(Lw, 16).z >= t.z); assert.ok(posterTiles(Lw, 64, 14, 48).tiles.length <= 48);
  assert.equal(posterTiles(posterLayout([{ lat: 47, lon: 11 }, { lat: 47.001, lon: 11.001 }], {}), 4).z, 14, 'capped at the tile source maximum');
});

test('poster svg: valid XML, real-size, route inside the frame, text, themes', () => {
  const track = parseGpx(fx('sample.gpx')).tracks.sort((a, b) => trackPoints(b).length - trackPoints(a).length)[0];
  const pts = trackPoints(track);
  const L = posterLayout(pts, { size: POSTER_SIZES.A3, profile: true });
  const profile = pts.map((p, i) => ({ d: i * 10, ele: 500 + Math.sin(i / 20) * 80 }));
  const svg = buildPosterSvg({ layout: L, lines: [pts], title: 'Karwendel <Runde> & mehr', subtitle: 'Juni 2024',
    stats: [{ label: 'Distanz', value: '12,3 km' }, { label: 'Aufstieg', value: '840 m' }], waypoints: [{ ...pts[40], name: 'Hütte "Alm"' }],
    options: { profile, coords: true } });
  const root = parseXml(svg);
  assert.equal(root.name, 'svg'); assert.equal(root.attrs.width, `${L.W}mm`); assert.equal(root.attrs.viewBox, `0 0 ${L.W} ${L.H}`);
  const route = findDeep(root, 'path') && [...svg.matchAll(/<path d="([^"]+)" id="route"/g)][0][1];
  const coords = [...route.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  assert.ok(coords.length > 20 && coords.length <= pts.length, 'route simplified for print: ' + coords.length + ' of ' + pts.length);
  for (const [x, y] of coords) assert.ok(x >= L.frame.x && x <= L.frame.x + L.frame.w && y >= L.frame.y && y <= L.frame.y + L.frame.h);
  assert.ok(Math.abs(coords[0][0] - L.x(pts[0].lon)) < 0.01 && Math.abs(coords.at(-1)[1] - L.y(pts.at(-1).lat)) < 0.01, 'start and end exact');
  assert.match(svg, /<text id="title"[^>]*>KARWENDEL &lt;RUNDE&gt; &amp; MEHR<\/text>/, 'title upper-cased and escaped');
  assert.match(svg, /Juni 2024/); assert.match(svg, />12,3 km</); assert.match(svg, />DISTANZ</); assert.match(svg, /Hütte &quot;Alm&quot;/);
  assert.match(svg, /<g id="profile">/); assert.match(svg, /<g id="compass">/); assert.match(svg, /<g id="scalebar">/); assert.match(svg, /<text id="coords"/);
  assert.doesNotMatch(svg, /NaN|undefined|null/); assert.doesNotMatch(svg, /id="attribution"/, 'no map data, no attribution line');
  // scale bar: its length in mm times metres-per-mm is the labelled distance
  const sb = /<g id="scalebar"><path d="M([\d.]+) [\d.]+V[\d.]+H([\d.]+)V[\d.]+"[^>]*\/><text[^>]*>([\d.]+) (km|m)</.exec(svg);
  const labelled = +sb[3] * (sb[4] === 'km' ? 1000 : 1);
  assert.ok(Math.abs((+sb[2] - +sb[1]) * L.metresPerMm / labelled - 1) < 0.01, 'scale bar is true to scale');
  // all text stays on the sheet
  for (const m of svg.matchAll(/<text[^>]* x="([\d.]+)" y="([\d.]+)"/g)) assert.ok(+m[1] >= 0 && +m[1] <= L.W && +m[2] > 0 && +m[2] < L.H);
  for (const id of Object.keys(POSTER_THEMES)) {
    const s = buildPosterSvg({ layout: L, lines: [pts], theme: id, title: 'T' });
    assert.ok(s.includes(`fill="${POSTER_THEMES[id].paper}"`) && s.includes(`stroke="${POSTER_THEMES[id].route}"`), id);
    parseXml(s);
  }
  const bare = buildPosterSvg({ layout: posterLayout(pts, { textBlock: false }), lines: [pts], options: { compass: false, scaleBar: false, startEnd: false } });
  assert.doesNotMatch(bare, /<text/, 'everything optional can be switched off');
});

test('poster svg: basemap from vector tiles lands at the right place', () => {
  const start = { lat: 47.26, lon: 11.39 };
  const pts = [start, destination(start, 80, 20000), destination(start, 60, 45000)];
  const L = posterLayout(pts, { size: POSTER_SIZES.A4 });
  const { z, tiles } = posterTiles(L, 3);
  const n = 2 ** z;
  // a city exactly at the route start, a lake around it, a motorway and a path through it, a border
  const tx = Math.floor(mercX(start.lon) * n), ty = Math.floor(mercY(start.lat) * n);
  const gx = Math.round((mercX(start.lon) * n - tx) * 4096), gy = Math.round((mercY(start.lat) * n - ty) * 4096);
  const layers = {
    water: { features: [{ type: 3, props: { class: 'lake' }, geometry: [[[gx - 200, gy - 200], [gx + 200, gy - 200], [gx + 200, gy + 200], [gx - 200, gy + 200], [gx - 200, gy - 200]]] }] },
    waterway: { features: [{ type: 2, props: { class: 'river' }, geometry: [[[0, gy], [4096, gy]]] }, { type: 2, props: { class: 'stream' }, geometry: [[[0, 5], [9, 9]]] }] },
    landcover: { features: [{ type: 3, props: { class: 'wood' }, geometry: [[[0, 0], [500, 0], [500, 500], [0, 0]]] }, { type: 3, props: { class: 'farmland' }, geometry: [[[0, 0], [9, 0], [9, 9], [0, 0]]] }] },
    boundary: { features: [{ type: 2, props: { admin_level: 2 }, geometry: [[[0, 100], [4096, 100]]] }, { type: 2, props: { admin_level: 8 }, geometry: [[[0, 1], [5, 1]]] }, { type: 2, props: { admin_level: 2, maritime: 1 }, geometry: [[[0, 2], [5, 2]]] }] },
    transportation: { features: [{ type: 2, props: { class: 'motorway' }, geometry: [[[0, gy + 50], [4096, gy + 60]]] }, { type: 2, props: { class: 'path' }, geometry: [[[0, 7], [7, 7]]] }] },
    place: { features: [{ type: 1, props: { class: 'city', name: 'Innsbruck', 'name:de': 'Innsbruck', 'name:en': 'Innsbruck-EN', rank: 5 }, geometry: [[gx, gy]] },
      { type: 1, props: { class: 'town', name: 'Hall', rank: 9 }, geometry: [[gx + 4, gy + 2]] },               // collides with the city label
      { type: 1, props: { class: 'city', name: 'Puffer', rank: 1 }, geometry: [[-30, gy]] },                    // tile buffer: belongs to the neighbour
      { type: 1, props: { class: 'hamlet', name: 'Weiler', rank: 20 }, geometry: [[gx + 900, gy + 900]] }] },
  };
  const decoded = decodeTile(encodeTile(layers), POSTER_LAYERS);
  const t = tiles.find((q) => q.x === tx && q.y === ty);
  assert.ok(t, 'route start tile is part of the tile set');
  const svg = buildPosterSvg({ layout: L, lines: [pts], tiles: [{ ...t, layers: decoded }], title: 'Test', theme: 'hell' });
  parseXml(svg);
  const T = POSTER_THEMES.hell;
  // the city dot sits exactly on the route start
  const dot = new RegExp(`<circle cx="([\\d.]+)" cy="([\\d.]+)" r="[\\d.]+" fill="${T.label}"/>\\s*<text[^>]*>Innsbruck</text>`).exec(svg);
  assert.ok(dot, 'city label present');
  const tol = 4096 ** -1 / n * L.k + 0.02; // half a tile unit on paper
  assert.ok(Math.abs(+dot[1] - L.x(start.lon)) < tol && Math.abs(+dot[2] - L.y(start.lat)) < tol, `label at ${dot[1]},${dot[2]} vs ${L.x(start.lon)},${L.y(start.lat)}`);
  assert.doesNotMatch(svg, />Hall</, 'colliding label dropped'); assert.doesNotMatch(svg, />Puffer</); assert.doesNotMatch(svg, />Weiler</);
  // lake polygon surrounds the start
  const lake = new RegExp(`<path d="(M[^"]+)" fill="${T.water}" fill-rule="evenodd"/>`).exec(svg)[1];
  const lx = [...lake.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  assert.equal(lx.length, 5);
  assert.ok(Math.min(...lx.map((p) => p[0])) < L.x(start.lon) && Math.max(...lx.map((p) => p[0])) > L.x(start.lon) && Math.min(...lx.map((p) => p[1])) < L.y(start.lat) && Math.max(...lx.map((p) => p[1])) > L.y(start.lat));
  assert.ok(svg.includes(`fill="${T.wood}"`), 'forest'); assert.equal((svg.match(new RegExp(`fill="${T.wood}"`, 'g')) || []).length, 1, 'only wood landcover');
  assert.equal((svg.match(/stroke-dasharray="[^"]+" stroke-linejoin="round"/g) || []).length, 1, 'only the national land border');
  const roads = [...svg.matchAll(new RegExp(`stroke="${T.road}" stroke-width="([\\d.]+)"`, 'g'))];
  assert.equal(roads.length, z >= 13 ? 2 : 1, 'paths only on detailed maps');
  assert.match(svg, /id="attribution"[^>]*>© OpenStreetMap-Mitwirkende · OpenMapTiles · OpenFreeMap</);
  // layer order: water below roads below route below labels
  const pos = (re) => svg.search(re);
  assert.ok(pos(/fill-rule="evenodd"/) < pos(new RegExp(`stroke="${T.road}"`)) && pos(new RegExp(`stroke="${T.road}"`)) < pos(/id="route"/) && pos(/id="route"/) < pos(/>Innsbruck</));
  const off = buildPosterSvg({ layout: L, lines: [pts], tiles: [{ ...t, layers: decoded }], options: { roads: false, places: false, boundaries: false, waterways: false, forest: false, lang: 'en' } });
  assert.ok(!off.includes(`stroke="${T.road}"`) && !off.includes('Innsbruck') && !off.includes(`fill="${T.wood}"`) && off.includes(`fill="${T.water}"`), 'layers can be switched off, water stays');
  assert.match(buildPosterSvg({ layout: L, lines: [pts], tiles: [{ ...t, layers: decoded }], options: { lang: 'en' } }), />Innsbruck-EN</, 'label language');
});

test('poster designs: every layout keeps the route visible and the text on the sheet', () => {
  const pts = trackPoints(parseGpx(fx('sample.gpx')).tracks[0]);
  const profile = pts.map((p, i) => ({ d: i * 10, ele: 500 + i }));
  for (const design of Object.keys(POSTER_DESIGNS)) for (const size of ['A4', 'Quadrat 50 cm']) for (const orientation of ['portrait', 'landscape']) {
    const L = posterLayout(pts, { size: POSTER_SIZES[size], orientation, design, profile: true });
    const tag = `${design}/${size}/${orientation}`;
    const xs = pts.map((p) => L.x(p.lon)), ys = pts.map((p) => L.y(p.lat));
    assert.ok(Math.min(...xs) >= L.fit.x && Math.max(...xs) <= L.fit.x + L.fit.w && Math.min(...ys) >= L.fit.y && Math.max(...ys) <= L.fit.y + L.fit.h, tag + ': route inside the fit area');
    assert.ok(L.fit.x >= 0 && L.fit.y >= 0 && L.fit.x + L.fit.w <= L.W + 1e-6 && L.fit.y + L.fit.h <= L.H + 1e-6, tag);
    if (L.circle) for (let i = 0; i < xs.length; i++) assert.ok(Math.hypot(xs[i] - L.circle.cx, ys[i] - L.circle.cy) < L.circle.r, tag + ': inside the circle');
    if (L.card) assert.ok(Math.max(...ys) < L.card.y, tag + ': route clear of the card');
    if (L.fade) assert.ok(Math.max(...ys) < L.fade.y + L.fade.h * 0.2, tag + ': route above the fade');
    for (const box of [L.text, L.profileBox]) assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= L.W + 1e-6 && box.y + box.h <= L.H + 1e-6, tag + ': boxes on the sheet');
    // the map frame is what tiles must cover; bounds are consistent with the projection
    assert.ok(Math.abs(L.x(L.bounds.minLon) - L.frame.x) < 1e-6 && Math.abs(L.y(L.bounds.minLat) - (L.frame.y + L.frame.h)) < 1e-6, tag + ': bounds');
    assert.ok(Math.abs(L.x(L.center.lon) - (L.frame.x + L.frame.w / 2)) < 1e-6 && Math.abs(L.y(L.center.lat) - (L.frame.y + L.frame.h / 2)) < 1e-6, tag + ': frame centre');
    for (const font of Object.keys(POSTER_FONTS)) {
      const svg = buildPosterSvg({ layout: L, lines: [pts], title: 'Eine ziemlich lange Überschrift für das Poster', subtitle: 'Unterzeile',
        stats: [{ label: 'Distanz', value: '15,6 km' }, { label: 'Höchster Punkt', value: '2.290 m' }, { label: '', value: 'frei' }], options: { profile, coords: true, font } });
      parseXml(svg);
      assert.doesNotMatch(svg, /NaN|undefined|null/, tag);
      for (const m of svg.matchAll(/<text[^>]* x="([-\d.]+)" y="([-\d.]+)"/g)) assert.ok(+m[1] >= 0 && +m[1] <= L.W && +m[2] > 0 && +m[2] < L.H, `${tag}/${font}: text at ${m[1]},${m[2]}`);
      // estimated title width stays inside its box
      const t = /<text id="title"[^>]*font-size="([\d.]+)"[^>]*letter-spacing="([\d.]+)"[^>]*>([^<]+)</.exec(svg);
      assert.ok(t[3].length * (+t[1] * POSTER_FONTS[font].width + +t[2]) <= L.text.w * 0.97, `${tag}/${font}: title fits`);
    }
  }
  assert.equal(posterLayout(pts, { design: 'gibtsnicht' }).design, 'galerie');
  const bare = posterLayout(pts, { design: 'karte', textBlock: false }); assert.equal(bare.card, null);
  assert.match(buildPosterSvg({ layout: posterLayout(pts, { design: 'kompass' }), lines: [pts] }), /<clipPath id="map"><circle /);
  assert.doesNotMatch(buildPosterSvg({ layout: posterLayout(pts, { design: 'kompass' }), lines: [pts] }), /id="compass"/, 'the ring replaces the north arrow');
});

test('poster topo: contour lines, peaks, trails, rock and ice', () => {
  const start = { lat: 47.26, lon: 11.39 };
  const pts = [start, destination(start, 80, 6000)];
  const L = posterLayout(pts, { size: POSTER_SIZES.A4 });
  const { z, tiles } = posterTiles(L, 8);
  assert.ok(z >= 12);
  const layers = decodeTile(encodeTile({
    landcover: { features: [{ type: 3, props: { class: 'rock' }, geometry: [[[0, 0], [900, 0], [900, 900], [0, 0]]] }, { type: 3, props: { class: 'ice' }, geometry: [[[1000, 0], [1900, 0], [1900, 900], [1000, 0]]] }] },
    waterway: { features: [{ type: 2, props: { class: 'stream' }, geometry: [[[0, 5], [4000, 900]]] }] },
    transportation: { features: [{ type: 2, props: { class: 'path' }, geometry: [[[0, 3000], [4096, 3100]]] }, { type: 2, props: { class: 'primary' }, geometry: [[[0, 2000], [4096, 2100]]] }] },
    mountain_peak: { features: [{ type: 1, props: { name: 'Hafelekarspitze', ele: 2334, rank: 1 }, geometry: [[2000, 2000]] }, { type: 1, props: { name: 'Namenlos' }, geometry: [[2000, 3000]] }, { type: 1, props: { ele: 2000 }, geometry: [[100, 100]] }] },
  }), POSTER_LAYERS);
  const B = L.bounds, cols = 60, rows = 80;
  const grid = { south: B.minLat, north: B.maxLat, west: B.minLon, east: B.maxLon, cols, rows, data: Array.from({ length: cols * rows }, (_, i) => 600 + 20 * Math.floor(i / cols) + 5 * (i % cols)) };
  const ct = geoContours(grid, { target: 16 });
  assert.ok(ct.contours.length > 5);
  const T = POSTER_THEMES.topo;
  const svg = buildPosterSvg({ layout: L, lines: [pts], tiles: tiles.map((t) => ({ ...t, layers })), contours: ct.contours, theme: 'topo', options: { topo: true } });
  parseXml(svg);
  const cd = new RegExp(`<path d="([^"]+)" class="contour" fill="none" stroke="${T.contour}"`).exec(svg)[1];
  const cpts = [...cd.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  assert.ok(cpts.length > 50 && cpts.every(([x, y]) => x >= L.frame.x - 0.01 && x <= L.frame.x + L.frame.w + 0.01 && y >= L.frame.y - 0.01 && y <= L.frame.y + L.frame.h + 0.01), 'contours cover the frame, not more');
  assert.match(svg, new RegExp(`class="contour index"[^>]*stroke-width="${(0.8 * L.unit).toFixed(2).replace(/0+$/, '')}`));
  assert.ok(svg.includes(`fill="${T.rock}"`) && svg.includes(`fill="${T.ice}"`));
  assert.match(svg, /<path class="peak"[^>]*\/>\s*<text[^>]*font-style="italic"[^>]*>Hafelekarspitze 2334</); assert.match(svg, />Namenlos</);
  assert.ok(svg.includes(`stroke="${T.path}"`), 'trails in their own colour'); assert.ok(svg.includes(`stroke="${T.road}"`));
  assert.match(svg, /id="attribution"[^>]*>© OpenStreetMap-Mitwirkende · OpenMapTiles · OpenFreeMap · Höhen: SRTM</);
  const plain = buildPosterSvg({ layout: L, lines: [pts], tiles: tiles.map((t) => ({ ...t, layers })), theme: 'topo' });
  assert.ok(!plain.includes('class="peak"') && !plain.includes(`fill="${T.rock}"`) && !plain.includes('class="contour'), 'street mode stays quiet');
  // order: contours under water, roads, route
  assert.ok(svg.indexOf('class="contour"') < svg.indexOf(`stroke="${T.road}"`) && svg.indexOf(`stroke="${T.road}"`) < svg.indexOf('id="route"'));
});

test('poster raster backdrop: resolution is limited by the tile source', () => {
  const pts = [{ lat: 47.2, lon: 11.2 }, { lat: 47.35, lon: 11.5 }]; // ~25 km
  const a4 = posterLayout(pts, { size: POSTER_SIZES.A4 }), a0 = posterLayout(pts, { size: POSTER_SIZES.A0 });
  const s4 = backdropSpec(a4, { maxZoom: 17 }), s0 = backdropSpec(a0, { maxZoom: 17 }), low = backdropSpec(a0, { maxZoom: 11 });
  assert.ok(s4.dpi >= 150 && s4.dpi <= 225, 'A4 reaches print resolution: ' + s4.dpi);
  assert.ok(Math.abs(s4.width / s4.height - a4.frame.w / a4.frame.h) < 0.01);
  assert.ok(Math.abs(s4.width - a4.frame.w / 25.4 * s4.dpi) <= 1);
  assert.ok(s0.width * s0.height <= 60e6 && s0.tiles <= 900, 'big sheets are capped');
  assert.ok(low.dpi < 60 && low.tileZoom === 11, 'coarse source on a big sheet: ' + low.dpi);
  // native resolution maths: at zoom z one tile pixel covers (earth / 256 / 2^z) m
  const native = (256 * 2 ** low.tileZoom * 25.4) / a0.k; assert.ok(Math.abs(low.dpi - native) < 1e-6);
  const svg = buildPosterSvg({ layout: a4, lines: [pts], backdrop: { href: 'data:image/jpeg;base64,AAAA', attribution: '© Test-Karte' }, tiles: [{ z: 1, x: 0, y: 0, layers: {} }], title: 'R' });
  parseXml(svg);
  const img = /<image id="backdrop" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  assert.deepEqual(img.slice(1).map(Number), [a4.frame.x, a4.frame.y, a4.frame.w, a4.frame.h].map((v) => Math.round(v * 100) / 100), 'image fills exactly the map frame');
  assert.match(svg, /id="attribution"[^>]*>© Test-Karte</); assert.ok(svg.indexOf('id="backdrop"') < svg.indexOf('id="route"'));
});
