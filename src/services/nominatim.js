// Place search / reverse geocoding via Nominatim (usage policy: max 1 request/s).
import { fetchJson } from './http.js';
import { DEFAULT_SERVICES } from './config.js';

export function parseSearchResponse(json) {
  return (json || []).map((r) => ({
    lat: +r.lat, lon: +r.lon, name: r.name || (r.display_name || '').split(',')[0], label: r.display_name, type: r.type,
    bbox: r.boundingbox ? { minLat: +r.boundingbox[0], maxLat: +r.boundingbox[1], minLon: +r.boundingbox[2], maxLon: +r.boundingbox[3] } : null,
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

export async function search(query, { base = DEFAULT_SERVICES.nominatim, limit = 8, lang = 'de', signal } = {}) {
  const url = `${base}search?format=jsonv2&limit=${limit}&accept-language=${lang}&q=${encodeURIComponent(query)}`;
  return parseSearchResponse(await fetchJson(url, { signal }));
}

export async function reverse(lat, lon, { base = DEFAULT_SERVICES.nominatim, lang = 'de', signal } = {}) {
  const url = `${base}reverse?format=jsonv2&zoom=18&accept-language=${lang}&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
  const j = await fetchJson(url, { signal });
  return j && j.display_name ? { label: j.display_name, name: j.name || j.display_name.split(',')[0] } : null;
}
