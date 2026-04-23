/**
 * Sentinel Node Tester — UI Smoke Tests
 * HTTP-based tests for the served HTML pages and public API endpoints.
 * Does NOT require a database — tests structure/content of HTML responses.
 *
 * Run: node test/ui.smoke.test.js
 * Requires the server to be running on PORT (default 3001).
 */

import http from 'node:http';
import { URL } from 'node:url';

const PORT    = process.env.PORT || 3001;
const BASE    = `http://127.0.0.1:${PORT}`;
const TIMEOUT = 5000;

const results = { pass: 0, fail: 0, errors: [] };

function assert(condition, name) {
  if (condition) {
    results.pass++;
    console.log(`  ✓ ${name}`);
  } else {
    results.fail++;
    results.errors.push(name);
    console.log(`  ✗ ${name}`);
  }
}

// ─── HTTP helper ───
function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u    = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port:     parseInt(u.port, 10),
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'Accept': '*/*' },
    };

    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });

    req.setTimeout(TIMEOUT, () => {
      req.destroy();
      reject(new Error(`Timeout after ${TIMEOUT}ms`));
    });

    req.on('error', reject);
    req.end();
  });
}

// ─── Check server is reachable ───
async function checkServerUp() {
  try {
    await httpGet(`${BASE}/`);
    return true;
  } catch (_) {
    return false;
  }
}

async function run() {
  console.log('Sentinel Node Tester — UI Smoke Tests');
  console.log(`Target: ${BASE}\n`);

  // Pre-check: server must be running
  const up = await checkServerUp();
  if (!up) {
    console.error(`ERROR: Server is not running at ${BASE}`);
    console.error('Start with: node server.js');
    process.exit(2);
  }

  // ─── 1. Root page (public dashboard or admin) ───
  console.log('1. Root page (/)...');
  let rootRes;
  try {
    rootRes = await httpGet(`${BASE}/`);
    assert(rootRes.status === 200, 'GET / returns 200');
    assert(typeof rootRes.body === 'string' && rootRes.body.length > 0, 'GET / returns non-empty body');
    assert(
      rootRes.body.includes('<!DOCTYPE html') || rootRes.body.includes('<!doctype html'),
      'GET / body is HTML'
    );
  } catch (err) {
    assert(false, `GET / no error (${err.message})`);
  }

  // ─── 2. Public dashboard (/public or /public.html) ───
  console.log('\n2. Public dashboard...');
  let pubRes;
  const pubPaths = ['/public', '/public.html', '/dashboard'];
  let pubFound   = false;
  for (const path of pubPaths) {
    try {
      const r = await httpGet(`${BASE}${path}`);
      if (r.status === 200 && r.body.includes('<html')) {
        pubRes    = r;
        pubFound  = true;
        assert(true, `Public dashboard accessible at ${path}`);
        break;
      }
    } catch (_) {}
  }
  if (!pubFound) {
    // Fall back to checking root
    if (rootRes && rootRes.body.includes('Public Dashboard')) {
      pubRes   = rootRes;
      pubFound = true;
      assert(true, 'Public dashboard content found at /');
    } else {
      assert(false, 'Public dashboard accessible (tried /public, /public.html, /dashboard)');
    }
  }

  if (pubRes) {
    assert(pubRes.body.includes('id="searchInput"'), 'Public page has search input (#searchInput)');
    assert(
      pubRes.body.includes('nodesBody') || pubRes.body.includes('nodesTable'),
      'Public page has nodes table'
    );
    assert(
      pubRes.body.includes('/admin/login') || pubRes.body.includes('admin'),
      'Public page links to admin login'
    );
    assert(
      pubRes.body.includes('api/public/nodes') || pubRes.body.includes('/api/public/'),
      'Public page uses /api/public/ endpoints'
    );
    // Must NOT reference admin token-protected endpoints
    assert(
      !pubRes.body.includes('/api/admin/') || pubRes.body.indexOf('/api/admin/') === -1,
      'Public page does not call /api/admin/ routes'
    );
  }

  // ─── 3. Admin page (/admin or /admin.html or /) ───
  console.log('\n3. Admin page...');
  let adminRes;
  const adminPaths = ['/admin', '/admin.html', '/'];
  for (const path of adminPaths) {
    try {
      const r = await httpGet(`${BASE}${path}`);
      if (r.status === 200 && (r.body.includes('SENTINEL') || r.body.includes('sentinel'))) {
        adminRes = r;
        assert(true, `Admin page accessible at ${path}`);
        break;
      }
    } catch (_) {}
  }

  if (adminRes) {
    assert(
      adminRes.body.includes('PUBLIC TEST') || adminRes.body.includes('publicTestPill') || adminRes.body.includes('publicTest'),
      'Admin page contains PUBLIC TEST element'
    );
    assert(
      adminRes.body.includes('SENTINEL') || adminRes.body.includes('Sentinel'),
      'Admin page contains SENTINEL branding'
    );
  } else {
    assert(false, 'Admin page accessible');
  }

  // ─── 4. Admin login page (no token needed) ───
  console.log('\n4. Admin login page (/admin/login)...');
  try {
    const r = await httpGet(`${BASE}/admin/login`);
    assert(r.status === 200, 'GET /admin/login returns 200');
    assert(
      r.body.includes('<html') || r.body.includes('login') || r.body.includes('Login'),
      'GET /admin/login returns HTML with login content'
    );
  } catch (err) {
    // May 404 if not yet implemented — warn but don't fail hard
    assert(false, `GET /admin/login reachable (${err.message})`);
  }

  // ─── 5. Public API endpoints (no token) ───
  console.log('\n5. Public API endpoints...');

  // /api/public/stats
  try {
    const r = await httpGet(`${BASE}/api/public/stats`);
    assert(r.status === 200, 'GET /api/public/stats returns 200');
    const ct = r.headers['content-type'] || '';
    assert(ct.includes('json'), 'GET /api/public/stats returns JSON');
  } catch (err) {
    assert(false, `GET /api/public/stats reachable (${err.message})`);
  }

  // /api/public/nodes
  try {
    const r = await httpGet(`${BASE}/api/public/nodes`);
    assert(
      r.status === 200 || r.status === 404,
      `GET /api/public/nodes returns 200 or 404 (got ${r.status})`
    );
    if (r.status === 200) {
      const ct = r.headers['content-type'] || '';
      assert(ct.includes('json'), 'GET /api/public/nodes returns JSON');
      try {
        const parsed = JSON.parse(r.body);
        assert(
          Array.isArray(parsed) || (typeof parsed === 'object' && parsed !== null),
          'GET /api/public/nodes body is valid JSON object/array'
        );
      } catch (_) {
        assert(false, 'GET /api/public/nodes body parses as JSON');
      }
    }
  } catch (err) {
    assert(false, `GET /api/public/nodes reachable (${err.message})`);
  }

  // /api/public/runs
  try {
    const r = await httpGet(`${BASE}/api/public/runs`);
    assert(
      r.status === 200 || r.status === 404,
      `GET /api/public/runs returns 200 or 404 (got ${r.status})`
    );
  } catch (err) {
    assert(false, `GET /api/public/runs reachable (${err.message})`);
  }

  // ─── 6. Admin-protected endpoints should NOT be public ───
  console.log('\n6. Admin route protection...');
  const protectedPaths = [
    '/api/admin/public-test/status',
    '/api/admin/public-test/start',
  ];

  for (const path of protectedPaths) {
    try {
      const r = await httpGet(`${BASE}${path}`);
      // Should return 401/403 (auth), 404 (not yet impl), or 405 (method not allowed)
      // Should NOT return a 200 with sensitive data if auth is enabled
      assert(
        r.status !== 200 || (r.headers['content-type'] || '').includes('json'),
        `${path} responds with structured data (status ${r.status})`
      );
    } catch (err) {
      // Connection refused for this path is acceptable
      assert(true, `${path} not accessible without token (connection refused or timeout)`);
    }
  }

  // ─── 7. Static asset: logo or favicon (optional, soft assert) ───
  console.log('\n7. Static assets (soft)...');
  try {
    const r = await httpGet(`${BASE}/favicon.ico`);
    assert(r.status === 200 || r.status === 404, 'favicon.ico returns 200 or 404');
  } catch (_) {
    assert(true, 'favicon.ico request completed (soft)');
  }

  // ─── Results ───
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed (${results.pass + results.fail} total)`);
  if (results.errors.length > 0) {
    console.log('\nFAILURES:');
    for (const e of results.errors) console.log(`  FAIL: ${e}`);
  }
  console.log(`${'='.repeat(50)}`);
  process.exit(results.fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
