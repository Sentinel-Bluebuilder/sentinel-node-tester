/**
 * Sentinel Node Tester — HTTP client for the agent CLI
 *
 * Thin wrapper over fetch() that:
 *   - Resolves base URL from --base-url, SENTINEL_AUDIT_URL, or http://localhost:PORT
 *   - Adds Bearer auth from --token / SENTINEL_AUDIT_TOKEN / ADMIN_TOKEN
 *   - Sets X-Admin-Request: 1 on every non-GET (CSRF gate in core/auth.js)
 *   - Returns parsed JSON, never swallows errors
 */

export function resolveBaseUrl(flags = {}) {
  const fromFlag = flags['--base-url'] || flags['--url'];
  if (fromFlag) return String(fromFlag).replace(/\/+$/, '');
  if (process.env.SENTINEL_AUDIT_URL) return process.env.SENTINEL_AUDIT_URL.replace(/\/+$/, '');
  const port = flags['--port'] || process.env.PORT || '3001';
  return `http://localhost:${port}`;
}

export function resolveToken(flags = {}) {
  return (
    flags['--token'] ||
    process.env.SENTINEL_AUDIT_TOKEN ||
    process.env.ADMIN_TOKEN ||
    null
  );
}

function buildHeaders(method, token, extra = {}) {
  const h = { 'Accept': 'application/json', ...extra };
  if (method && method !== 'GET' && method !== 'HEAD') {
    h['Content-Type'] = 'application/json';
    h['X-Admin-Request'] = '1';
  }
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/**
 * @param {string} method - GET/POST/DELETE etc
 * @param {string} pathOrUrl - "/api/state" or full URL
 * @param {object} opts
 *   - flags: parsed CLI flags (used for base url + token)
 *   - body: request body (will be JSON.stringify'd)
 *   - query: object of query string params
 *   - timeoutMs: abort after N ms (default 30s)
 *   - raw: if true, return Response untouched
 */
export async function apiRequest(method, pathOrUrl, opts = {}) {
  const { flags = {}, body, query, timeoutMs = 30_000, raw = false } = opts;
  const base = resolveBaseUrl(flags);
  const token = resolveToken(flags);

  let url = pathOrUrl.startsWith('http') ? pathOrUrl : `${base}${pathOrUrl}`;
  if (query && typeof query === 'object') {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      usp.append(k, String(v));
    }
    const qs = usp.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: buildHeaders(method, token),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`HTTP ${method} ${url} failed: ${err.message || err}`);
  }
  clearTimeout(timer);

  if (raw) return res;

  const ct = res.headers.get('content-type') || '';
  let payload;
  if (ct.includes('application/json')) {
    payload = await res.json().catch(() => null);
  } else {
    payload = await res.text().catch(() => '');
  }

  if (!res.ok) {
    const msg = (payload && typeof payload === 'object' && payload.error)
      ? payload.error
      : (typeof payload === 'string' ? payload.slice(0, 240) : `HTTP ${res.status}`);
    const e = new Error(`${method} ${url} → ${res.status} ${msg}`);
    e.status = res.status;
    e.payload = payload;
    throw e;
  }

  return payload;
}

export const api = {
  get: (p, o = {}) => apiRequest('GET', p, o),
  post: (p, body, o = {}) => apiRequest('POST', p, { ...o, body }),
  del: (p, o = {}) => apiRequest('DELETE', p, o),
};
