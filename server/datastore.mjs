// Persistent local store for downloaded artefacts, used by serve.mjs.
//
// Directory layout — the data root of the legacy Java application
// (%APPDATA%\JF\OSMViewer on Windows), so existing downloads are reused:
//
//   <root>/MapCache/tiles/<store>/<z>/<x>/<y>.png|jpg   tiles as plain files
//        <store> = the Java app's store name where the server is the same
//        ("Mapnik", "OpenTopoMap", "ArcGISSatellite" …), so tiles migrated with
//        tools/MapCacheExport.java are found; folders without a matching
//        source are offered as offline archive layers.
//   <root>/MapCache/tiles/OpenFreeMap/<z>/<x>/<y>.pbf   vector tiles for the poster export
//   <root>/MapCache/db-<store>/*.jdb      Java tile databases — read only by the export tool
//   <root>/MapCache/hgtCacheDirectory/N47E011.hgt   elevation cells, shared with the Java app
//   <root>/SRTM/**/N47E011.hgt[.zip]      older SRTM downloads, read if present

import { mkdir, readFile, writeFile, stat, readdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import { TILE_SOURCES, OVERLAY_SOURCES, tileUrl, storeName } from '../src/core/tilesources.js';
import { hgtName, hgtOrigin, hgtTile, hgtElevation } from '../src/core/hgt.js';

/** Terrain tiles on AWS Open Data ("skadi" layout, SRTM-based, keyless). {lat} = N47, {name} = N47E011. */
export const HGT_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi/{lat}/{name}.hgt.gz';
/** Vector tiles (OpenMapTiles schema) for the poster export. */
export const VECTOR_URL = 'https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf';
const VECTOR_STORE = 'OpenFreeMap';
const USER_AGENT = 'OSMViewerWeb/1.0 (local personal map viewer)';
const MISSING_RETRY_MS = 30 * 864e5;

/** Data root of the legacy Java app (Swing Application Framework: vendorId "JF", id "OSMViewer"). */
export function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.OSMV_DATA) return env.OSMV_DATA;
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'JF', 'OSMViewer');
  return join(homedir(), '.osmviewer');
}

const exists = (p) => stat(p).then((s) => s, () => null);

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return { ext: 'png', type: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length > 3 && buf.toString('latin1', 0, 3) === 'GIF') return { ext: 'gif', type: 'image/gif' };
  if (buf.length > 11 && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}
const TILE_EXTS = ['png', 'jpg', 'webp', 'gif'];

/** First file of a ZIP archive (stored or deflated), located via the central directory. */
export function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('kein ZIP-Archiv');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
  const method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + csize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error('ZIP-Kompression nicht unterstützt: ' + method);
}

const validTile = (z, x, y) => [z, x, y].every(Number.isInteger) && z >= 0 && z <= 22 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;

export class DataStore {
  /**
   * @param {object} o  root, fetch (injectable for tests), offline (never download),
   *                    maxAgeDays (tiles older than this are refreshed when online; 0 = never), hgtUrl, log
   */
  constructor({ root = defaultDataDir(), fetch = globalThis.fetch, offline = false, maxAgeDays = 30, hgtUrl = HGT_URL, vectorUrl = VECTOR_URL, log = () => {} } = {}) {
    Object.assign(this, { root, fetch, offline, hgtUrl, vectorUrl, log });
    this.maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 864e5 : Infinity;
    this.sources = new Map([...TILE_SOURCES, ...OVERLAY_SOURCES].map((s) => [s.id, s]));
    this.inflight = new Map();   // de-duplicates concurrent downloads of the same artefact
    this.cells = new Map();      // decoded HGT tiles (small LRU)
    this.missing = new Map();    // HGT cell -> time it was found missing (sea / no data)
    this.stats = { tileHits: 0, tileDownloads: 0, tileStale: 0, hgtDownloads: 0, vectorDownloads: 0 };
  }
  get tileDir() { return join(this.root, 'MapCache', 'tiles'); }
  get hgtDir() { return join(this.root, 'MapCache', 'hgtCacheDirectory'); }
  get srtmDir() { return join(this.root, 'SRTM'); }

  async _download(url) {
    if (this.offline) throw new Error('offline');
    const res = await this.fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return Buffer.from(await res.arrayBuffer());
  }
  async _store(file, buf) { // atomic: never leave half-written files behind
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, buf); await rename(tmp, file);
  }
  _once(key, fn) {
    if (!this.inflight.has(key)) this.inflight.set(key, fn().finally(() => this.inflight.delete(key)));
    return this.inflight.get(key);
  }
  async _readTile(base) {
    for (const ext of TILE_EXTS) {
      const st = await exists(`${base}.${ext}`);
      if (st) return { file: `${base}.${ext}`, age: Date.now() - st.mtimeMs };
    }
    return null;
  }
  async _serve(file, from) {
    const data = await readFile(file);
    return { data, type: sniff(data)?.type || 'application/octet-stream', from };
  }

  /** Catalogue tile: from disk, else from the network (and then to disk). Stale tiles bridge outages. */
  async tile(sourceId, z, x, y) {
    const source = this.sources.get(sourceId);
    if (!source || !validTile(z, x, y)) return null;
    const base = join(this.tileDir, storeName(source), String(z), String(x), String(y));
    return this._once('t:' + base, async () => {
      const cached = await this._readTile(base);
      if (cached && (cached.age < this.maxAgeMs || this.offline)) { this.stats.tileHits++; return this._serve(cached.file, 'cache'); }
      try {
        const data = await this._download(tileUrl(source, z, x, y));
        const kind = sniff(data);
        if (!kind) throw new Error('Antwort ist kein Bild');
        await this._store(`${base}.${kind.ext}`, data);
        this.stats.tileDownloads++;
        return { data, type: kind.type, from: 'network' };
      } catch (e) {
        if (!cached) { this.log(`Kachel ${sourceId}/${z}/${x}/${y}: ${e.message}`); return null; }
        this.stats.tileStale++;
        return this._serve(cached.file, 'stale');
      }
    });
  }

  /**
   * Vector tile (uncompressed protobuf) for the poster export: disk first, else network.
   * An empty tile (open sea) is a valid answer and is cached as an empty file.
   */
  async vectorTile(z, x, y) {
    if (!validTile(z, x, y) || z > 14) return null;
    const file = join(this.tileDir, VECTOR_STORE, String(z), String(x), `${y}.pbf`);
    return this._once('v:' + file, async () => {
      const st = await exists(file);
      const fresh = st && (Date.now() - st.mtimeMs < this.maxAgeMs || this.offline);
      if (fresh) { this.stats.tileHits++; return { data: await readFile(file), type: 'application/x-protobuf', from: 'cache' }; }
      try {
        let data = await this._download(this.vectorUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data); // stored gzipped by some servers
        if (data.length && (data[0] === 0x3c || data[0] === 0x7b)) throw new Error('Antwort ist keine Vektorkachel'); // HTML/JSON error page
        await this._store(file, data);
        this.stats.vectorDownloads++;
        return { data, type: 'application/x-protobuf', from: 'network' };
      } catch (e) {
        if (e.status === 204 || e.status === 404) { await this._store(file, Buffer.alloc(0)); return { data: Buffer.alloc(0), type: 'application/x-protobuf', from: 'network' }; }
        if (!st) { this.log(`Vektorkachel ${z}/${x}/${y}: ${e.message}`); return null; }
        this.stats.tileStale++;
        return { data: await readFile(file), type: 'application/x-protobuf', from: 'stale' };
      }
    });
  }

  /** Cache folders that belong to no catalogue source (e.g. migrated from the Java app). */
  async archives() {
    const known = new Set([...this.sources.values()].map(storeName)).add(VECTOR_STORE);
    const out = [];
    for (const e of await readdir(this.tileDir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || known.has(e.name)) continue;
      const zooms = (await readdir(join(this.tileDir, e.name)).catch(() => [])).filter((z) => /^\d+$/.test(z)).map(Number).sort((a, b) => a - b);
      if (zooms.length) out.push({ store: e.name, minZoom: zooms[0], maxZoom: zooms[zooms.length - 1] });
    }
    return out;
  }
  /** Archive tile: disk only. The store must be an existing folder (no path tricks). */
  async archiveTile(store, z, x, y) {
    if (!validTile(z, x, y) || !(await this.archives()).some((a) => a.store === store)) return null;
    const cached = await this._readTile(join(this.tileDir, store, String(z), String(x), String(y)));
    if (!cached) return null;
    this.stats.tileHits++;
    return this._serve(cached.file, 'archive');
  }

  // --- elevation ---------------------------------------------------------------
  async _findLocalHgt(name) {
    for (const f of [join(this.hgtDir, `${name}.hgt`), join(this.hgtDir, `${name}.hgt.zip`)]) if (await exists(f)) return f;
    const walk = async (dir, depth) => { // older SRTM downloads: SRTM/<Region>/N47E011.hgt[.zip]
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory() && depth < 2) { const r = await walk(join(dir, e.name), depth + 1); if (r) return r; }
        else if (e.isFile() && new RegExp(`^${name}\\.?hgt(\\.zip)?$`, 'i').test(e.name)) return join(dir, e.name);
      }
      return null;
    };
    return walk(this.srtmDir, 0);
  }

  /** HGT tile for the 1° cell containing lat/lon, or null if there is none. */
  async cell(lat, lon) {
    const name = hgtName(lat, lon);
    if (this.cells.has(name)) return this.cells.get(name);
    const missingSince = this.missing.get(name);
    if (missingSince && Date.now() - missingSince < MISSING_RETRY_MS) return null;
    return this._once('h:' + name, async () => {
      let file = await this._findLocalHgt(name);
      if (!file && !(await exists(join(this.hgtDir, `${name}.none`)))) {
        try {
          const gz = await this._download(this.hgtUrl.replace('{lat}', name.slice(0, 3)).replace('{name}', name));
          const raw = gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : gz;
          hgtTile(raw, name); // validate size before storing
          file = join(this.hgtDir, `${name}.hgt`);
          await this._store(file, raw);
          this.stats.hgtDownloads++;
        } catch (e) {
          // 403/404: there is no cell (sea) — remember on disk so we do not ask again
          if (e.status === 403 || e.status === 404) await this._store(join(this.hgtDir, `${name}.none`), Buffer.alloc(0)).catch(() => {});
          else this.log(`Höhendaten ${name}: ${e.message}`);
          this.missing.set(name, Date.now());
          return null;
        }
      }
      if (!file) { this.missing.set(name, Date.now()); return null; }
      try {
        const buf = await readFile(file);
        const tile = hgtTile(file.endsWith('.zip') ? unzipFirst(buf) : buf, name);
        this.cells.set(name, tile);
        if (this.cells.size > 16) this.cells.delete(this.cells.keys().next().value);
        return tile;
      } catch (e) { this.log(`Höhendaten ${file}: ${e.message}`); this.missing.set(name, Date.now()); return null; }
    });
  }

  /** Elevations (metres, null where unknown) for parallel lat/lon arrays. */
  async elevations(lats, lons) {
    const out = [];
    for (let i = 0; i < lats.length; i++) {
      const ok = Number.isFinite(lats[i]) && Number.isFinite(lons[i]) && Math.abs(lats[i]) < 90 && Math.abs(lons[i]) <= 180;
      const t = ok ? await this.cell(lats[i], lons[i]) : null;
      const e = t ? hgtElevation(t, lats[i], lons[i]) : NaN;
      out.push(Number.isFinite(e) ? Math.round(e * 10) / 10 : null);
    }
    return out;
  }

  /**
   * Regular elevation grid over a bounding box (row 0 = north), for contour lines.
   * Cells are loaded once, then sampled synchronously. null where there is no data.
   */
  async elevationGrid(south, west, north, east, cols, rows) {
    const need = new Map();
    for (let la = Math.floor(south); la <= Math.floor(north); la++) for (let lo = Math.floor(west); lo <= Math.floor(east); lo++) need.set(hgtName(la + 0.5, lo + 0.5), null);
    if (need.size > 16) throw new Error('Gebiet zu groß für Höhenlinien');
    for (const name of need.keys()) { const o = hgtOrigin(name); need.set(name, await this.cell(o.lat + 0.5, o.lon + 0.5)); }
    const data = new Array(cols * rows);
    let known = 0;
    for (let r = 0; r < rows; r++) {
      const lat = Math.min(north - ((north - south) * r) / (rows - 1), 89.999999);
      for (let c = 0; c < cols; c++) {
        const lon = west + ((east - west) * c) / (cols - 1);
        const t = need.get(hgtName(lat, lon));
        const e = t ? hgtElevation(t, lat, lon) : NaN;
        if (Number.isFinite(e)) { data[r * cols + c] = Math.round(e * 10) / 10; known++; } else data[r * cols + c] = null;
      }
    }
    return { south, west, north, east, cols, rows, data, known };
  }

  /** Cheap capability summary (no directory walks: the cache may hold millions of files). */
  async info() {
    return { root: this.root, offline: this.offline, archives: await this.archives(), stats: this.stats };
  }

  /** Size of the cache per store — walks the disk, may take a while for big caches. */
  async usage() {
    const walk = async (dir) => {
      let files = 0, bytes = 0;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) { const r = await walk(join(dir, e.name)); files += r.files; bytes += r.bytes; }
        else { files++; bytes += (await stat(join(dir, e.name))).size; }
      }
      return { files, bytes };
    };
    const tiles = {};
    for (const e of await readdir(this.tileDir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) tiles[e.name] = await walk(join(this.tileDir, e.name));
    return { root: this.root, tiles, hgt: await walk(this.hgtDir), stats: this.stats };
  }
}
