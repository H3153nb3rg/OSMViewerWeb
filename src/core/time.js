// Lenient timestamp parsing. GPX requires ISO 8601, but files in the wild
// (including this project's own legacy samples) contain variants such as
// "2007-10-16T15:37.04Z" (dot before the seconds) or a missing zone suffix.

/** Milliseconds since the epoch, or NaN. Accepts a string or a point with .time. */
export function timeMs(t) {
  const s = typeof t === 'string' ? t : t && t.time;
  if (!s) return NaN;
  let ms = Date.parse(s);
  if (Number.isFinite(ms)) return ms;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})[.:](\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return NaN;
  ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] || ''}${m[6] || 'Z'}`);
  return ms;
}

/** ISO 8601 UTC string without milliseconds when they are zero. */
export const isoTime = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
