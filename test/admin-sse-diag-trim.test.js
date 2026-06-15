/**
 * admin SSE diag trimming — only ship the 4 fields the dashboard reads
 *
 * The admin Server-Sent-Events stream (GET /api/events) forwards full per-node
 * result rows to the admin browser. Each row's `diag` blob carries internal /
 * sensitive diagnostics — the V2Ray credential `v2rayUUID`, raw `v2rayConfig` /
 * `hsConfig`, process `v2rayStdout` / `v2rayStderr`, `wgServerEndpoint`, and
 * ~20 other fields. The admin dashboard (admin.html) reads `diag` off a LIVE
 * SSE row in exactly ONE place — the results-table transport-detail renderer —
 * and reads ONLY: v2rayProto / v2rayTransport / v2raySecurity / v2rayPort. The
 * rich node-detail drawer + failure-report builder source diag from the
 * persisted error-log over REST (`er.raw_json`), not the SSE row.
 *
 * So server.js trims each SSE-bound result row's diag to those 4 fields via
 * trimRowDiag(). The trim MUST be NON-MUTATING: result rows are shared
 * references with DB persistence (insertBatchResult → raw_json) and in-memory
 * state (getResults()); mutating would strip the diag the drawer/persistence
 * depend on.
 *
 * This test extracts the REAL trimRowDiag from server.js and asserts:
 *   - the returned clone's diag has ONLY the 4 kept keys, none of the sensitive
 *     ones, and carries the kept values through;
 *   - the original row + its diag are UNTOUCHED, and the clone is a new object
 *     with a new diag object;
 *   - a row with no diag passes through unchanged (no fabricated diag key);
 *   - a row with a falsy diag passes through unchanged.
 *
 * Run: node test/admin-sse-diag-trim.test.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const out = { pass: 0, fail: 0, errors: [] };
function ok(cond, name) {
  if (cond) { out.pass++; console.log(`  PASS  ${name}`); }
  else      { out.fail++; out.errors.push(name); console.log(`  FAIL  ${name}`); }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

// Balanced-brace function extractor (mirrors public-sse-fields / live-load-gating).
function extractFn(s, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(s);
  if (!m) throw new Error(`function ${name} not found in server.js`);
  let depth = 0, started = false, j = m.index;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return s.slice(m.index, j);
}

// The extractor is a naive char counter: a brace inside a string/regex literal
// would silently truncate the slice and turn into a confusing "field missing"
// assertion. Guard loudly — the extracted helper must end with `}` and still
// contain the last kept subfield (v2rayPort).
function mustExtract(extracted, what, endToken, sentinel) {
  const trimmed = extracted.trimEnd();
  if (!trimmed.endsWith(endToken)) {
    throw new Error(`mis-extracted ${what}: expected it to end with "${endToken}" ` +
      `but got "...${trimmed.slice(-40)}" (a brace inside a string or regex ` +
      `likely truncated the balanced-brace scan)`);
  }
  if (!extracted.includes(sentinel)) {
    throw new Error(`mis-extracted ${what}: expected it to contain "${sentinel}" ` +
      `(extraction stopped early before the last kept field)`);
  }
  return extracted;
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  mustExtract(extractFn(src, 'trimRowDiag'), 'trimRowDiag', '}', 'v2rayPort'),
  sandbox);
vm.runInContext(
  mustExtract(extractFn(src, 'sanitizeAdminState'), 'sanitizeAdminState', '}', 'runGranter'),
  sandbox);

const KEPT = ['v2rayProto', 'v2rayTransport', 'v2raySecurity', 'v2rayPort'];
const SENSITIVE = [
  'v2rayUUID', 'v2rayConfig', 'v2rayStdout', 'v2rayStderr',
  'hsConfig', 'wgServerEndpoint', 'googleError', 'sessionId',
];

console.log('\nadmin SSE diag trimming — only the 4 consumed fields ship\n');

// ─── 1. trims diag to the 4 kept fields, drops every sensitive one ───────────
console.log('[1] trimRowDiag keeps the 4 fields, drops the credential blob');
{
  const original = {
    address: 'sent1abc', moniker: 'Node A', actualMbps: 42.5,
    diag: {
      v2rayProto: 'vless', v2rayTransport: 'grpc',
      v2raySecurity: 'tls', v2rayPort: 443,
      // sensitive / internal — must NOT survive the trim:
      v2rayUUID: 'deadbeef-cred-uuid', v2rayConfig: '{ big json }',
      v2rayStdout: 'process stdout...', v2rayStderr: 'process stderr...',
      hsConfig: 'handshake config', wgServerEndpoint: '1.2.3.4:51820',
      googleError: 'some probe error', sessionId: 99887766,
    },
  };
  sandbox._row = original;
  const trimmed = vm.runInContext('trimRowDiag(_row)', sandbox);

  // exactly the 4 kept keys, nothing else
  const keys = Object.keys(trimmed.diag);
  ok(keys.length === 4, `trimmed diag has exactly 4 keys (got ${keys.length}: ${keys.join(',')})`);
  for (const k of KEPT) {
    ok(Object.prototype.hasOwnProperty.call(trimmed.diag, k), `keeps "${k}"`);
  }
  for (const k of SENSITIVE) {
    ok(!Object.prototype.hasOwnProperty.call(trimmed.diag, k),
       `DROPS sensitive "${k}" (regression guard)`);
  }

  // kept values carried through correctly
  ok(trimmed.diag.v2rayProto === 'vless', 'carries v2rayProto value');
  ok(trimmed.diag.v2rayTransport === 'grpc', 'carries v2rayTransport value');
  ok(trimmed.diag.v2raySecurity === 'tls', 'carries v2raySecurity value');
  ok(trimmed.diag.v2rayPort === 443, 'carries v2rayPort value');

  // top-level non-diag fields preserved
  ok(trimmed.address === 'sent1abc', 'preserves top-level address');
  ok(trimmed.actualMbps === 42.5, 'preserves top-level actualMbps');

  // ─── NON-MUTATION ─────────────────────────────────────────────────────────
  ok(trimmed !== original, 'returns a NEW row object (not the same reference)');
  ok(trimmed.diag !== original.diag, 'returns a NEW diag object');
  ok(original.diag.v2rayUUID === 'deadbeef-cred-uuid',
     'original diag credential UNTOUCHED');
  ok(Object.keys(original.diag).length === 12,
     `original diag still has all 12 keys (got ${Object.keys(original.diag).length})`);
}

// ─── 2. undefined kept subfields are preserved as-is (not fabricated) ────────
console.log('[2] undefined kept subfields pass through as undefined');
{
  sandbox._row = { address: 'sent1p', diag: { v2rayProto: 'vmess' } };
  const trimmed = vm.runInContext('trimRowDiag(_row)', sandbox);
  ok(trimmed.diag.v2rayProto === 'vmess', 'present field kept');
  ok(trimmed.diag.v2rayPort === undefined, 'absent field stays undefined');
  // simplest-correct form always carries the 4 keys (matches admin.html's
  // `r.diag.v2rayProto || ''` read)
  ok(Object.prototype.hasOwnProperty.call(trimmed.diag, 'v2rayPort'),
     'always carries all 4 keys');
}

// ─── 3. rows with no diag pass through untouched ─────────────────────────────
console.log('[3] rows without a diag pass through unchanged (no fabricated key)');
{
  const skip = { address: 'sent1skip', skipped: true };
  sandbox._row = skip;
  const r = vm.runInContext('trimRowDiag(_row)', sandbox);
  ok(r === skip, 'no-diag row returns the SAME reference (no clone)');
  ok(!Object.prototype.hasOwnProperty.call(r, 'diag'),
     'no-diag row gains NO diag key');
}

// ─── 4. falsy diag passes through unchanged ──────────────────────────────────
console.log('[4] rows with a falsy diag pass through unchanged');
{
  const nullDiag = { address: 'sent1n', diag: null };
  sandbox._row = nullDiag;
  const r = vm.runInContext('trimRowDiag(_row)', sandbox);
  ok(r === nullDiag, 'diag:null row returns the SAME reference');
  ok(r.diag === null, 'diag:null stays null (not replaced with {})');
}
{
  // non-object inputs are returned untouched (defensive)
  ok(vm.runInContext('trimRowDiag(null)', sandbox) === null, 'null row → null');
  ok(vm.runInContext('trimRowDiag(undefined)', sandbox) === undefined, 'undefined row → undefined');
}

// ─── 5. sanitizeAdminState: strip wallet internals, KEEP walletAddress/balance ─
console.log('[5] sanitizeAdminState strips balanceUdvpn/spentUdvpn/runGranter, keeps the rest');
{
  const original = {
    status: 'running', totalNodes: 120,
    walletAddress: 'sent1wallet', balance: '12.5',
    // unconsumed / server-internal — must be stripped:
    balanceUdvpn: 12500000, spentUdvpn: 4200000, runGranter: 'sent1granter',
  };
  sandbox._state = original;
  const safe = vm.runInContext('sanitizeAdminState(_state)', sandbox);

  ok(!Object.prototype.hasOwnProperty.call(safe, 'balanceUdvpn'),
     'DROPS balanceUdvpn (regression guard)');
  ok(!Object.prototype.hasOwnProperty.call(safe, 'spentUdvpn'),
     'DROPS spentUdvpn (regression guard)');
  ok(!Object.prototype.hasOwnProperty.call(safe, 'runGranter'),
     'DROPS runGranter (regression guard)');

  // admin.html DOES read these — they MUST survive
  ok(safe.walletAddress === 'sent1wallet', 'KEEPS walletAddress (wallet header)');
  ok(safe.balance === '12.5', 'KEEPS balance (wallet header)');
  ok(safe.status === 'running', 'KEEPS status');
  ok(safe.totalNodes === 120, 'KEEPS totalNodes');

  // ─── NON-MUTATION ─────────────────────────────────────────────────────────
  ok(safe !== original, 'returns a NEW state object (not the same reference)');
  ok(original.balanceUdvpn === 12500000, 'original balanceUdvpn UNTOUCHED');
  ok(original.spentUdvpn === 4200000, 'original spentUdvpn UNTOUCHED');
  ok(original.runGranter === 'sent1granter', 'original runGranter UNTOUCHED');
}
{
  // non-object inputs pass through untouched (defensive)
  ok(vm.runInContext('sanitizeAdminState(null)', sandbox) === null, 'null state → null');
  ok(vm.runInContext('sanitizeAdminState(undefined)', sandbox) === undefined, 'undefined state → undefined');
  ok(vm.runInContext('sanitizeAdminState("x")', sandbox) === 'x', 'non-object state passes through');
}

// ─── 6. wiring: the /api/events handler routes every payload through the sanitizers ─
console.log('[6] /api/events handler wires sanitizeAdminState + trimRowDiag on the live path');
{
  // Isolate the ADMIN handler body so the init-send (its own 5-field
  // destructure, not the helper) — and the unrelated /live handler, which also
  // matches `const handler = (data) =>` — can't satisfy these substring checks.
  // Anchor at the admin route then find the handler that follows it.
  const route = src.indexOf("app.get('/api/events'");
  ok(route !== -1, 'found the /api/events admin route in server.js');
  const hm = /const handler = \(data\) => \{/.exec(src.slice(route));
  ok(!!hm, 'found the live-event handler in /api/events');
  const startAbs = route + hm.index;
  let depth = 0, started = false, j = startAbs, body = '';
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  body = src.slice(startAbs, j);

  ok(body.includes('sanitizeAdminState('),
     'handler routes the state path through sanitizeAdminState (regression guard)');
  // trimRowDiag must apply to BOTH the single result row and the results[] array
  ok(/result:\s*trimRowDiag\(/.test(body),
     'handler trims data.result via trimRowDiag (result events)');
  ok(/\.map\(trimRowDiag\)/.test(body),
     'handler trims results[] via trimRowDiag (state events)');
}

console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
console.log('='.repeat(60));
process.exit(out.fail ? 1 : 0);
