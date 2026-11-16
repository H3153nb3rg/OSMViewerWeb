// Routing via the OSRM HTTP API (v5). Any OSRM-compatible server works.
import { fetchJson } from './http.js';
import { DEFAULT_SERVICES } from './config.js';

export const PROFILES = { car: 'Auto', bike: 'Fahrrad', foot: 'Zu Fuß' };
const MAX_COORDS = 25; // conservative limit of public servers

export function buildOsrmUrl(points, profile = 'car', base = DEFAULT_SERVICES.osrm) {
  const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  return base.replace('{profile}', profile) + coords + '?overview=full&geometries=geojson&steps=false&alternatives=false';
}

export function parseOsrmResponse(json) {
  if (!json || json.code !== 'Ok' || !json.routes || !json.routes.length) {
    throw new Error('Routing fehlgeschlagen: ' + ((json && (json.message || json.code)) || 'keine Antwort'));
  }
  const r = json.routes[0];
  return {
    points: r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    distance: r.distance, duration: r.duration,
    snapped: (json.waypoints || []).map((w) => ({ lat: w.location[1], lon: w.location[0], name: w.name || '' })),
  };
}

/** Route through all via points (chunked for long routes). */
export async function route(points, { profile = 'car', base, signal } = {}) {
  if (points.length < 2) throw new Error('Mindestens zwei Punkte nötig');
  const result = { points: [], distance: 0, duration: 0 };
  for (let i = 0; i < points.length - 1; i += MAX_COORDS - 1) {
    const chunk = points.slice(i, i + MAX_COORDS);
    const part = parseOsrmResponse(await fetchJson(buildOsrmUrl(chunk, profile, base), { signal }));
    result.points.push(...(result.points.length ? part.points.slice(1) : part.points));
    result.distance += part.distance; result.duration += part.duration;
  }
  return result;
}
