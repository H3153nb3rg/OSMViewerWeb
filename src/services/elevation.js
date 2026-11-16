// Elevation lookup. With the local server (serve.mjs) the HGT cells in the data
// folder are used first (offline-capable, shared with the Java app); points it
// cannot answer — or everything, when running without it — go to the online
// service (Open-Meteo compatible API).
import { fetchJson, sleep } from './http.js';
import { DEFAULT_SERVICES } from './config.js';

const BATCH = 100, LOCAL_BATCH = 500;

export function buildElevationUrl(points, base = DEFAULT_SERVICES.elevation) {
  return `${base}?latitude=${points.map((p) => p.lat.toFixed(5)).join(',')}&longitude=${points.map((p) => p.lon.toFixed(5)).join(',')}`;
}

async function batches(points, size, base, out, idx, { signal, onProgress, pause = 0, done = 0, total }) {
  for (let i = 0; i < idx.length; i += size) {
    const part = idx.slice(i, i + size);
    const j = await fetchJson(buildElevationUrl(part.map((k) => points[k]), base), { signal });
    if (!j || !Array.isArray(j.elevation) || j.elevation.length !== part.length) throw new Error('Unerwartete Antwort des Höhendienstes');
    j.elevation.forEach((e, n) => { if (typeof e === 'number' && Number.isFinite(e)) out[part[n]] = e; });
    if (onProgress) onProgress(Math.min(total, done + i + part.length), total);
    if (pause && i + size < idx.length) await sleep(pause); // be polite to the free service
  }
}

/**
 * Elevation in metres for every point (NaN where nobody knows).
 * @param {object} o  base (online service), local (true when serve.mjs is available), signal, onProgress(done, total)
 * @returns {Promise<{elevations: number[], local: number, online: number}>}
 */
export async function lookupElevations(points, { base = DEFAULT_SERVICES.elevation, local = false, signal, onProgress } = {}) {
  const out = new Array(points.length).fill(NaN);
  const all = points.map((_, i) => i);
  let localCount = 0;
  if (local) {
    try { await batches(points, LOCAL_BATCH, '/api/elevation', out, all, { signal, onProgress, total: points.length }); } catch { /* fall back to online */ }
    localCount = out.filter(Number.isFinite).length;
  }
  const rest = all.filter((i) => !Number.isFinite(out[i]));
  if (rest.length && base) {
    try { await batches(points, BATCH, base, out, rest, { signal, onProgress, pause: 120, done: points.length - rest.length, total: points.length }); }
    catch (e) { if (!localCount) throw e; } // partial local result is still useful
  }
  return { elevations: out, local: localCount, online: out.filter(Number.isFinite).length - localCount };
}
