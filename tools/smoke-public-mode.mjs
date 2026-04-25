/**
 * Sentinel Node Tester — Public-Mode Smoke Test
 * Spawns the server in PUBLIC_MODE=true and runs a suite of security/behaviour probes.
 * Usage: node tools/smoke-public-mode.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'test-token-do-not-use-in-prod-0123456789abcdef0123456789abcdef';

// ─── Results collector ────────────────────────────────────────────────────────
const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const icon = pass ? '✓' : '✗';
  const label = pass ? 'PASS' : 'FAIL';
  console.log(`  [${label}] ${icon} ${name}${detail ? ' — ' + detail : ''}`);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function get(url, headers = {}) {
  return fetch(url, { headers, redirect: 'manual' });
}

async function post(url, headers = {}, body = null) {
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    redirect: 'manual',
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

// ─── Wait for server to be ready ──────────────────────────────────────────────
async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`, { redirect: 'manual' });
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

// ─── Kill helper ──────────────────────────────────────────────────────────────
async function killProc(proc) {
  proc.kill('SIGTERM');
  const killTimer = setTimeout(() => proc.kill('SIGKILL'), 3000);
  await new Promise(resolve => proc.once('exit', resolve));
  clearTimeout(killTimer);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Sentinel Node Tester — Public Mode Smoke Test');
console.log(`  Port: ${PORT}   Token: ${TOKEN.slice(0, 16)}...`);
console.log('══════════════════════════════════════════════════════════════\n');

// Spawn server
const serverEnv = {
  ...process.env,
  PUBLIC_MODE: 'true',
  ADMIN_TOKEN: TOKEN,
  PORT: String(PORT),
  NODE_ENV: 'test',
};

const proc = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: serverEnv,
  stdio: 'inherit',
});

proc.once('error', err => {
  console.error('[spawn error]', err.message);
  process.exit(1);
});

// Wait for ready
console.log('[*] Waiting for server on port', PORT, '...');
const ready = await waitReady(15000);
if (!ready) {
  console.error('[!] Server did not become ready within 15s');
  await killProc(proc);
  process.exit(1);
}
console.log('[*] Server ready. Running probes...\n');

// ─── Probe suite ──────────────────────────────────────────────────────────────

// 1. GET / → 200, body contains "Sentinel Network", no admin-only buttons
{
  const r = await get(`${BASE}/`);
  const body = await r.text();
  const statusOk = r.status === 200;
  const hasTitle = body.includes('Sentinel Network');
  const noStartBtn = !body.includes('id="btnStart"');
  const noResumeBtn = !body.includes('id="btnResume"');
  record('GET / → 200', statusOk, `status=${r.status}`);
  record('GET / body contains "Sentinel Network"', hasTitle);
  record('GET / no id="btnStart" (public.html, not admin.html)', noStartBtn);
  record('GET / no id="btnResume" (public.html, not admin.html)', noResumeBtn);
}

// 2. GET /live → 200, has CSP header
{
  const r = await get(`${BASE}/live`);
  const hasCSP = r.headers.has('content-security-policy');
  record('GET /live → 200', r.status === 200, `status=${r.status}`);
  record('GET /live has Content-Security-Policy header', hasCSP);
}

// 3. GET /api/public/test/status → 200, JSON with running:false
{
  const r = await get(`${BASE}/api/public/test/status`);
  let body = {};
  try { body = await r.json(); } catch { /* ignore */ }
  const statusOk = r.status === 200;
  const runningFalse = body.running === false;
  record('GET /api/public/test/status → 200', statusOk, `status=${r.status}`);
  record('GET /api/public/test/status body.running === false', runningFalse, `running=${body.running}`);
}

// 4. GET /api/public/nodes → 200
{
  const r = await get(`${BASE}/api/public/nodes`);
  record('GET /api/public/nodes → 200', r.status === 200, `status=${r.status}`);
}

// 5. POST /api/start (no auth) → 401 or 403
{
  const r = await post(`${BASE}/api/start`);
  const blocked = r.status === 401 || r.status === 403;
  record('POST /api/start (no auth) → 401 or 403', blocked, `status=${r.status}`);
}

// 6. POST /api/admin/public-test/start (no auth) → 401 or 403
{
  const r = await post(`${BASE}/api/admin/public-test/start`);
  const blocked = r.status === 401 || r.status === 403;
  record('POST /api/admin/public-test/start (no auth) → 401 or 403', blocked, `status=${r.status}`);
}

// 7. POST /api/rescan (no auth) → 401 or 403
{
  const r = await post(`${BASE}/api/rescan`);
  const blocked = r.status === 401 || r.status === 403;
  record('POST /api/rescan (no auth) → 401 or 403', blocked, `status=${r.status}`);
}

// 8. POST /admin/logout (no X-Admin-Request header) → 403
{
  const r = await post(`${BASE}/admin/logout`);
  record('POST /admin/logout (no X-Admin-Request) → 403', r.status === 403, `status=${r.status}`);
}

// 9. POST /admin/logout (with X-Admin-Request: 1) → 302 or 200
{
  const r = await post(`${BASE}/admin/logout`, { 'X-Admin-Request': '1' });
  const ok = r.status === 302 || r.status === 200;
  record('POST /admin/logout (with X-Admin-Request: 1) → 302 or 200', ok, `status=${r.status}`);
}

// 10. POST /api/start WITH Bearer token but WITHOUT X-Admin-Request → 403
{
  const r = await post(`${BASE}/api/start`, { 'Authorization': `Bearer ${TOKEN}` });
  record('POST /api/start (Bearer, no X-Admin-Request) → 403', r.status === 403, `status=${r.status}`);
}

// 11. POST /api/start WITH Bearer token AND X-Admin-Request → 200 or 409
{
  const r = await post(
    `${BASE}/api/start`,
    { 'Authorization': `Bearer ${TOKEN}`, 'X-Admin-Request': '1' },
    {}
  );
  const authPasses = r.status === 200 || r.status === 409;
  record('POST /api/start (Bearer + X-Admin-Request) → 200 or 409 (auth passes)', authPasses, `status=${r.status}`);
}

// ─── Teardown ─────────────────────────────────────────────────────────────────
console.log('\n[*] Stopping server...');
await killProc(proc);

// ─── Results table ────────────────────────────────────────────────────────────
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log('  #   Status  Check');
console.log('  ─── ─────── ────────────────────────────────────────────────');
results.forEach((r, i) => {
  const n = String(i + 1).padStart(3);
  const s = r.pass ? ' PASS ' : ' FAIL ';
  const d = r.detail ? ` (${r.detail})` : '';
  console.log(`  ${n}  [${s}] ${r.name}${d}`);
});
console.log('');

if (failed > 0) {
  console.log(`[!] ${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('[+] All checks PASSED');
  process.exit(0);
}
