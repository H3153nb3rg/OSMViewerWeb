// Thin fetch wrapper: timeout, JSON, readable errors. Works in browsers and Node >= 18.
export async function fetchJson(url, { timeoutMs = 20000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Zeitüberschreitung')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.message || j.reason || j.error || ''; } catch { /* not JSON */ }
      throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Zeitüberschreitung oder Abbruch');
    if (e instanceof TypeError) throw new Error('Dienst nicht erreichbar (Netzwerk/CORS)');
    throw e;
  } finally { clearTimeout(timer); }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
