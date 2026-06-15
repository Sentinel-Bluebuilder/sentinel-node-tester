/**
 * public SSE payload trimming — only ship fields the frontend consumes
 *
 * The public Server-Sent-Events stream (GET /api/public/events) is shaped by
 * three helpers in server.js. An audit of the ONLY two consumers — live.html
 * (full) and public.html (narrow) — found several fields that are sent but
 * never read by either page. Per the user's instruction ("only send the
 * necessary fields and data to the frontend"), those fields were removed.
 *
 * This test extracts the REAL sanitizePublicResult, PUBLIC_STATE_KEYS, and
 * sanitizeForPublic from server.js and asserts:
 *   - sanitizePublicResult keeps every consumed field and drops the 6 removed
 *     ones (advertisedMbps, dynamicThreshold, pass10mbps, latencyMs,
 *     handshakeMs, sessionMs).
 *   - PUBLIC_STATE_KEYS is exactly the 10 kept keys, none of the 14 removed.
 *   - sanitizeForPublic drops top-level mode + durationMs, keeps the rest.
 * Each removed field is asserted absent as a regression guard so a future
 * re-add fails the suite.
 *
 * Run: node test/public-sse-fields.test.js
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

// Balanced-brace function extractor (mirrors public-run-active / live-load-gating).
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

// Pull the const PUBLIC_STATE_KEYS = [ ... ]; array literal out of the source.
function extractArrayLiteral(s, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[`).exec(s);
  if (!m) throw new Error(`const ${name} not found in server.js`);
  const start = s.indexOf('[', m.index);
  let depth = 0, j = start;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { j++; break; } }
  }
  return s.slice(start, j); // "[ ... ]"
}

// sanitizePublicResult closes over _redactPublicError; provide a stub so the
// extracted fn runs in isolation.
const sandbox = {
  _redactPublicError: (v, max = 200) => (v == null ? null : String(v).slice(0, max)),
  console,
};
vm.createContext(sandbox);
vm.runInContext(extractFn(src, 'sanitizePublicResult'), sandbox);
vm.runInContext('var PUBLIC_STATE_KEYS = ' + extractArrayLiteral(src, 'PUBLIC_STATE_KEYS') + ';', sandbox);
// sanitizeForPublic depends on sanitizePublicResult / sanitizePublicState /
// _redactPublicError. We only exercise its top-level field forwarding here, so
// provide a passthrough sanitizePublicState; sanitizePublicResult is real.
vm.runInContext('var sanitizePublicState = (s) => s;', sandbox);
vm.runInContext(extractFn(src, 'sanitizeForPublic'), sandbox);

const KEPT_RESULT_FIELDS = [
  'address', 'moniker', 'serviceType', 'countryCode', 'city', 'actualMbps',
  'peers', 'maxPeers', 'errorCode', 'error', 'skipped', 'inPlan',
  'testedAt', 'baselineAtTest',
];
const REMOVED_RESULT_FIELDS = [
  'advertisedMbps', 'dynamicThreshold', 'pass10mbps',
  'latencyMs', 'handshakeMs', 'sessionMs',
];
const KEPT_STATE_KEYS = [
  'status', 'totalNodes', 'baselineMbps', 'baselineHistory', 'testRun',
  'runMode', 'runPlanId', 'pricingMode', 'activeSDK', 'activeRunNumber',
];
const REMOVED_STATE_KEYS = [
  'testedNodes', 'failedNodes', 'skippedNodes', 'passed10', 'passed15',
  'passedBaseline', 'nodeSpeedHistory', 'currentNode', 'currentType',
  'currentLocation', 'startedAt', 'completedAt', 'continuousLoop',
  'estimatedTotalCost',
];

console.log('\npublic SSE payload trimming — only consumed fields ship\n');

// ─── 1. sanitizePublicResult ──────────────────────────────────────────────────
console.log('[1] sanitizePublicResult keeps consumed fields, drops 6 unused');
{
  // Fully-populated source row carrying every kept + every removed field.
  sandbox._row = {
    address: 'sent1abc', moniker: 'Node A', type: 1,
    countryCode: 'US', city: 'NYC', actualMbps: 42.5,
    peers: 3, maxPeers: 10, errorCode: null, error: 'boom',
    skipped: true, inPlan: true, testedAt: 1700000000, baselineAtTest: 50,
    // removed fields, all populated so an accidental keep would surface them:
    advertisedMbps: 100, dynamicThreshold: 12, pass10mbps: true,
    latencyMs: 30, handshakeMs: 40, sessionMs: 5000,
  };
  const safe = vm.runInContext('sanitizePublicResult(_row)', sandbox);

  for (const f of KEPT_RESULT_FIELDS) {
    ok(Object.prototype.hasOwnProperty.call(safe, f), `result keeps "${f}"`);
  }
  // serviceType is mapped from r.type ?? r.serviceType
  ok(safe.serviceType === 1, 'result maps type → serviceType');
  // error redaction path still runs (stub passthrough → non-null)
  ok(safe.error === 'boom', 'result still routes error through redactor');

  for (const f of REMOVED_RESULT_FIELDS) {
    ok(!Object.prototype.hasOwnProperty.call(safe, f),
       `result DROPS "${f}" (regression guard)`);
  }
}

// ─── 2. PUBLIC_STATE_KEYS ─────────────────────────────────────────────────────
console.log('[2] PUBLIC_STATE_KEYS is exactly the 10 consumed keys');
{
  const keys = vm.runInContext('PUBLIC_STATE_KEYS', sandbox);
  ok(Array.isArray(keys), 'PUBLIC_STATE_KEYS is an array');
  ok(keys.length === KEPT_STATE_KEYS.length,
     `has exactly ${KEPT_STATE_KEYS.length} keys (got ${keys.length})`);
  for (const k of KEPT_STATE_KEYS) {
    ok(keys.includes(k), `state keeps "${k}"`);
  }
  for (const k of REMOVED_STATE_KEYS) {
    ok(!keys.includes(k), `state DROPS "${k}" (regression guard)`);
  }
}

// ─── 3. sanitizeForPublic ─────────────────────────────────────────────────────
console.log('[3] sanitizeForPublic drops top-level mode + durationMs');
{
  const evt = {
    type: 'iteration:done',
    iteration: 4, passed: 10, failed: 2, batchId: 7,
    mode: 'p2p', durationMs: 12345,
  };
  sandbox._evt = evt;
  const safe = vm.runInContext('sanitizeForPublic(_evt)', sandbox);

  ok(safe.type === 'iteration:done', 'forwards dispatch type');
  ok(safe.iteration === 4, 'keeps iteration');
  ok(safe.passed === 10, 'keeps passed');
  ok(safe.failed === 2, 'keeps failed');
  ok(safe.batchId === 7, 'keeps batchId');

  ok(!Object.prototype.hasOwnProperty.call(safe, 'mode'),
     'DROPS mode (regression guard)');
  ok(!Object.prototype.hasOwnProperty.call(safe, 'durationMs'),
     'DROPS durationMs (regression guard)');
}

console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
console.log('='.repeat(60));
process.exit(out.fail ? 1 : 0);
