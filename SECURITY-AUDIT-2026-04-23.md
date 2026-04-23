# Security Audit — Sentinel Node Tester
**Date:** 2026-04-23  
**Auditor:** Internal (Wave A backend review)  
**Scope:** `server.js`, `core/auth.js`, `core/rate-limit.js`, `core/db.js`, `core/chain.js`, `audit/continuous.js`, `audit/pipeline.js`

---

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 2     |
| MEDIUM   | 5     |
| LOW      | 6     |
| INFO     | 4     |

No critical (RCE, auth bypass, full data exfiltration) findings.

---

## HIGH

### H-01 — planId exposed in public SSE init event
**File:** `server.js:925`  
**Vector:** Public SSE (`GET /api/public/events`) sends `continuous.status()` in the `init` event; `status()` includes `planId`, `mode`, and `minDelayMs` — operator-internal fields not intended for the public surface.  
**Fix:** Strip `planId` and `minDelayMs` from the `init` payload on the public SSE endpoint; only pass `{ running, iteration, mode, startedAt, uptime }`.

```js
// Before (server.js:925)
send({ type: 'init', status: continuous.status() });

// After
const s = continuous.status();
send({ type: 'init', status: { running: s.running, iteration: s.iteration, mode: s.mode, startedAt: s.startedAt, uptime: s.uptime } });
```

---

### H-02 — ADMIN_TOKEN stored in signed cookie verbatim
**File:** `server.js:691-700`  
**Vector:** On successful login, `res.cookie('admin_token', token, ...)` stores the raw `ADMIN_TOKEN` value as the cookie payload. If an attacker reads the signed cookie (e.g. via XSS, HTTP interception, or stolen cookie jar) they recover the raw token and can use it as a `Bearer` header from any origin — bypassing `SameSite: strict`.  
**Fix:** Store a short-lived session ID (e.g. `crypto.randomUUID()`) in the cookie and validate it server-side against a `Map<sessionId, expiry>`. The ADMIN_TOKEN is then never transmitted to the browser.

---

## MEDIUM

### M-01 — No `X-Frame-Options` or `frame-ancestors` on admin responses
**File:** `server.js:344-348`  
**Vector:** The security-headers middleware sets `X-Content-Type-Options` and `Referrer-Policy` for all responses, but does not emit `X-Frame-Options: DENY` on admin routes. `frame-ancestors 'none'` is present in `PUBLIC_CSP` (applied via `setPublicCsp()`) but `setPublicCsp()` is NOT called for `/admin` routes — only for public HTML routes. An attacker who compromises a same-origin resource could embed the admin panel in an iframe for clickjacking.  
**Fix:** Add `res.setHeader('X-Frame-Options', 'DENY')` to the global security-headers middleware, or call `setPublicCsp(res)` on every `sendFile` including the admin route.

---

### M-02 — `script-src 'unsafe-inline'` in PUBLIC_CSP weakens XSS protection
**File:** `server.js:357`  
**Vector:** The CSP includes `"script-src 'self' 'unsafe-inline'"`. `unsafe-inline` allows any inline `<script>` block to execute, which fully defeats XSS protection from CSP. If user-controlled data is reflected in an HTML response (e.g. the inline login-failed page at `server.js:703-716` which uses `${ADMIN_PATH}` — a server-controlled constant, not user input, but similar patterns could be added later), a stored/reflected XSS payload would execute.  
**Fix:** Remove `'unsafe-inline'` from `script-src`; use a nonce-based CSP or move all inline scripts to external `.js` files served with `'self'`.  
**Note:** `style-src 'unsafe-inline'` is a separate, lower-risk instance (styles cannot execute JS).

---

### M-03 — Rate limit bypassed on `/api/public/test/start` via a secondary in-memory store
**File:** `server.js:959-1002`  
**Vector:** The route uses `publicStartRateOk(ip)` (a bespoke in-memory `Map`) instead of the standard `rlPublicRead` middleware. While functional, this in-memory map is a separate, untested code path. It uses `x-forwarded-for` via Express `req.ip` (which respects `trust proxy 1`), but the `toString().split(',')[0].trim()` extraction at line 985 duplicates the logic already handled by Express — inconsistency creates a surface for IP spoofing if the proxy hop count is ever changed.  
**Fix:** Replace the bespoke rate-limit map with a `rateLimit({ windowMs: 60_000, max: 1 })` instance from `core/rate-limit.js`; delete the `_publicStartLast` map and `publicStartRateOk()` function.

---

### M-04 — `sort` parameter not validated before whitelist fallback; invalid values silently downgrade
**File:** `core/db.js:688-695`  
**Vector:** The `sort` parameter from `req.query.sort` is passed to `searchNodes()` and resolved via `sortMap[sort] || sortMap.tested_desc`. Any unrecognized sort value silently falls back to `tested_desc`. This is safe (no SQL injection — the whitelist prevents injection), but an API caller who typos a sort value gets no error and receives unexpected ordering. The risk is low for injection but confusing for API consumers.  
**Fix:** In the route handler, validate `sort` against the known set before passing to `searchNodes()`; return 400 for unrecognized values. This makes the API contract explicit and surfaces client-side bugs early.

---

### M-05 — `COOKIE_SECRET` falls back to a hardcoded string when `ADMIN_TOKEN` is not set
**File:** `server.js:50`  
**Vector:** `const COOKIE_SECRET = ADMIN_TOKEN || 'sentinel-local-dev-secret'`. In deployments where `ADMIN_TOKEN` is not set (single-user/dev mode — intentionally allowed), signed cookies use the public literal `'sentinel-local-dev-secret'` as the HMAC key. Any attacker who reads the source can forge signed cookies for that deployment.  
**Fix:** Generate a random secret at startup if `ADMIN_TOKEN` is absent: `const COOKIE_SECRET = ADMIN_TOKEN || crypto.randomBytes(32).toString('hex');`. This provides per-process ephemeral signing without requiring production configuration.

---

## LOW

### L-01 — No `Strict-Transport-Security` (HSTS) header
**File:** `server.js:344-348`  
**Vector:** HSTS is absent from the global security-headers middleware. In deployments behind TLS (production), browsers will not enforce HTTPS-only connections to this origin.  
**Fix:** Add `res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')` when `process.env.INSECURE_COOKIE !== 'true'` (i.e., in TLS mode).

---

### L-02 — `historyLimit` and `limit` query params accept `NaN` without sanitization
**File:** `server.js:476, 495, 574`  
**Vector:** `parseInt(req.query.historyLimit || '100', 10)` returns `100` if the query param is absent, but returns `NaN` if the param is present but non-numeric (e.g. `?historyLimit=foo`). `NaN` is passed to `getBandwidthHistory(addr, { limit: NaN })` which uses it in a SQLite `LIMIT` clause. SQLite coerces `NaN` to `0`, returning an empty result set — not a security issue but a silent API contract violation.  
**Fix:** Use `Math.min(Math.max(parseInt(q, 10) || 100, 1), 500)` — the `|| 100` default handles `NaN`.

---

### L-03 — Login page reflects `ADMIN_PATH` in action attribute without encoding
**File:** `server.js:679`  
**Vector:** The login form's action attribute is `action="${ADMIN_PATH}/login"`. `ADMIN_PATH` is operator-controlled (from `process.env.ADMIN_PATH`) and could contain characters that break the HTML attribute if set to a value containing `"` or `>`. This is not an XSS vector from end users, but a misconfiguration trap.  
**Fix:** Encode `ADMIN_PATH` with `encodeURIComponent()` when embedding it in HTML: `action="${encodeURIComponent(ADMIN_PATH)}/login"`.

---

### L-04 — `node_modules` files accessible via Express static middleware
**File:** `server.js:341`  
**Vector:** `app.use(express.static(__dirname, { index: false }))` serves the entire project root. `node_modules/` is under `__dirname`, so `GET /node_modules/sentinel-dvpn-sdk/package.json` returns the SDK's package.json including version and repository URL, which could assist fingerprinting.  
**Fix:** Add a middleware that blocks requests matching `/node_modules/` or restrict static middleware to a dedicated `public/` assets directory.

---

### L-05 — `results/` directory files accessible via static middleware
**File:** `server.js:341`  
**Vector:** Same as L-04 — `results/*.json`, `results/runs/*/results.json`, and `results/.state-snapshot.json` are all served statically. These files contain node addresses, error strings, and wallet address in the snapshot.  
**Fix:** Move static assets (CSS, HTML, fonts) to a dedicated `public/assets/` directory, or add a blanket block for `results/` and `data/` prefixes.

---

### L-06 — Error stack traces logged to console in production context
**File:** `server.js:87-90`  
**Vector:** `uncaughtException` and `unhandledRejection` handlers log full `err.stack` to `console.error`. In containerized deployments where stdout/stderr is forwarded to a log aggregator accessible to multiple people, this leaks internal stack traces including file paths and potentially sensitive variable names.  
**Fix:** In production (`PUBLIC_MODE === true`), suppress the stack and log only `err.message` with a correlation ID.

---

## INFO (no action required, documented for completeness)

### I-01 — SQL injection: LIKE wildcards not escaped
**File:** `core/db.js:491, 677, 943`  
**Finding:** `params.q = \`%${q}%\`` — the `q` parameter passes user input into a SQL LIKE pattern without escaping `%` or `_`. An attacker can supply `%` to widen the match or `_` to match single characters. This is not SQL injection (the value is parameterized), but it is a LIKE wildcard injection that can cause full-table scans. Severity: informational — the `rlPublicRead` rate limit (120 req/60s) prevents trivial DoS.  
**Fix if desired:** Escape `q` before wrapping: `params.q = \`%${q.replace(/[%_\\]/g, '\\$&')}%\`; ESCAPE '\\'`.

### I-02 — CSRF protection applies to mutating admin routes but not to logout
**File:** `server.js:719-726`  
**Finding:** `POST /admin/logout` checks `req.headers['x-admin-request'] !== '1'` at the handler level rather than relying on `adminOnly` (which enforces the CSRF header check only after authentication). This is intentional and correct — logout should accept the CSRF check independently since the cookie might be invalid. No action needed.

### I-03 — Timing safe comparison used correctly for ADMIN_TOKEN
**File:** `core/auth.js:11-17`  
**Finding:** `safeEq()` uses `timingSafeEqual()` from `node:crypto`. However, when `ab.length !== bb.length`, it returns `false` immediately (line 14), which leaks token length via timing. For an admin token of ~64 hex chars, this gives the attacker 1 bit of information (token is exactly N chars). Not practically exploitable in this context; documented for completeness.  
**Fix if desired:** Pad both buffers to a fixed length before comparing.

### I-04 — `trust proxy 1` set without verifying reverse proxy deployment
**File:** `server.js:335`  
**Finding:** `app.set('trust proxy', 1)` means Express trusts the first `X-Forwarded-For` hop. If the server is ever deployed without a reverse proxy (direct internet exposure), `X-Forwarded-For` becomes attacker-controlled and `req.ip` is spoofable — which invalidates rate limiting. The code comment acknowledges this. The `publicStartRateOk()` at line 985 explicitly reads `x-forwarded-for` separately and re-parses it — see M-03 above.

---

## Rate-Limit Coverage Map

| Endpoint | Rate-Limit Applied | Tier |
|----------|--------------------|------|
| `GET /api/public/nodes` | rlPublicRead (120/60s) | public-read |
| `GET /api/public/node/:addr` | rlPublicRead | public-read |
| `GET /api/public/node/:addr/errors` | rlPublicRead | public-read |
| `GET /api/public/errors` | rlPublicRead | public-read |
| `GET /api/public/countries` | rlPublicRead | public-read |
| `GET /api/public/runs/current` | rlPublicRead | public-read |
| `GET /api/public/runs/last` | rlPublicRead | public-read |
| `GET /api/public/node/:addr/bandwidth` | rlPublicRead | public-read |
| `GET /api/public/runs` | rlPublicRead | public-read |
| `GET /api/public/stats` | rlPublicRead | public-read |
| `GET /api/public/batches` | rlPublicRead | public-read |
| `GET /api/public/batch/:id` | rlPublicRead | public-read |
| `GET /api/public/test/status` | rlPublicRead | public-read |
| `GET /api/public/events` (SSE) | rlPublicSse (5 concurrent/IP) | public-sse |
| `POST /admin/login` | rateLimit (10/60s) | login |
| `POST /api/public/test/start` | bespoke 1/60s per IP | see M-03 |
| `GET /api/events` (admin SSE) | rlAdminSse (10 concurrent/IP) | admin-sse |
| All other admin routes | adminOnly (no rate limit) | n/a — internal use |

**Gap:** Admin API routes (e.g. `/api/start`, `/api/plans`, `/api/sdk-verify`) have no rate limit beyond auth. An attacker with a stolen `ADMIN_TOKEN` can send unlimited requests. This is acceptable for a private tool — documented for completeness.

---

## Path Traversal Assessment

All `res.sendFile()` calls use hardcoded filenames concatenated with `__dirname` (e.g. `path.join(__dirname, 'admin.html')`). No user-supplied path component is ever passed to `sendFile`. Path traversal risk: **none**.

## SSRF Assessment

All `fetch()` calls in `core/chain.js` and `audit/pipeline.js` target:
- LCD endpoints from `LCD_LIST` (hardcoded array from SDK)
- RPC endpoints from `createRpcQueryClientWithFallback()` (hardcoded SDK list)
- Wallet addresses from `state.walletAddress` (bech32, interpolated into LCD URL paths)

Wallet address interpolation (`/sentinel/subscription/v3/accounts/${walletAddress}/subscriptions`) is SSRF-safe: the wallet address is derived from the operator's MNEMONIC at startup and is a valid bech32 string (`sent1...`). No user-supplied URL components. SSRF risk: **none**.

The `verifySdk(key)` endpoint (`GET /api/sdk-verify/:key`) maps the key through `TRACKED_SDKS.find(s => s.key === key)` — throws if not found, so the GitHub tarball URL is always constructed from the whitelist. SSRF risk: **none**.

## SSE Injection Assessment

SSE is written as `res.write(\`data: ${JSON.stringify(data)}\n\n\`)`. `JSON.stringify()` escapes all control characters including `\n` and `\r`, so SSE protocol injection (splitting the event stream to inject attacker-controlled event types) is not possible via JSON-serialized payloads. SSE injection risk: **none**.

## SQL Injection Assessment

`core/db.js` uses exclusively `better-sqlite3` prepared statements with named parameters (`@param`). Dynamic SQL construction occurs only for:
1. `ORDER BY ${orderBy}` — sourced from a whitelist map (`sortMap`), not user input (after fallback).
2. `WHERE ... LIKE @q` — `q` is a parameterized value.

SQL injection risk: **none**. LIKE wildcard injection is documented in I-01.

## Secrets Exposure Assessment

- `MNEMONIC` is read from `.env`, used only in `core/wallet.js`, and never included in any HTTP response, SSE event, or log output.
- `ADMIN_TOKEN` is compared but never echoed in responses.
- `state.walletAddress` is included in admin SSE `init` event (line 1025) — acceptable since that endpoint is `adminOnly`.
- `state.walletAddress` is included in `insertRun()` DB record — stored locally, not exposed to public API.
- `wallet_address` is present in the `runs` table, queryable via `/api/runs/:num` — that endpoint is `adminOnly`.

Public endpoints (`/api/public/*`) do not expose wallet address, MNEMONIC, planId, subscriptionId, or subscriptionGranter. The `sanitizeForPublic()` function explicitly whitelists fields.
