// Vector tiles (OpenMapTiles schema) for the poster export.
// With the local server they come through its disk cache (/vector/z/x/y),
// otherwise straight from the tile service.
import { DEFAULT_SERVICES } from './config.js';
import { decodeTile } from '../core/mvt.js';
import { POSTER_LAYERS } from '../core/poster.js';

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function vectorTileUrl(z, x, y, { local = false, base = DEFAULT_SERVICES.vectorTiles } = {}) {
  return local ? `/vector/${z}/${x}/${y}` : base.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/** One decoded tile ({layerName: {extent, features}}); an empty object for empty tiles. */
export async function fetchVectorTile(z, x, y, opts = {}) {
  const res = await fetch(vectorTileUrl(z, x, y, opts), { signal: opts.signal });
  if (res.status === 204 || res.status === 404) return {};
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  return bytes.length ? decodeTile(bytes, POSTER_LAYERS) : {};
}

const memory = new Map(); // decoded tiles of this session, so changing poster options does not reload
/** Drop the in-memory tiles (the disk cache of the local server is not affected). */
export const forgetBasemap = () => memory.clear();

/**
 * Load all tiles of a poster ({z, tiles} from posterTiles()). Failures do not
 * abort: the poster is drawn with what arrived.
 * @returns {Promise<{tiles: object[], failed: number}>}
 */
export async function loadBasemap(spec, { local = false, base, signal, onProgress, concurrency = 6 } = {}) {
  const out = [], queue = spec.tiles.slice();
  let failed = 0, done = 0;
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const key = `${base || ''}/${t.z}/${t.x}/${t.y}`;
      try {
        if (!memory.has(key)) { memory.set(key, await fetchVectorTile(t.z, t.x, t.y, { local, base, signal })); if (memory.size > 300) memory.delete(memory.keys().next().value); }
        out.push({ ...t, layers: memory.get(key) });
      } catch { failed++; }
      if (onProgress) onProgress(++done, spec.tiles.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, spec.tiles.length) }, worker));
  return { tiles: out, failed };
}
