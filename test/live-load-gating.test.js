/**
 * /live load-sequence gating — "stopped flashes data then paused" regression
 *
 * Bug: on load, /live painted the dataset (rehydrateFromCache → table rows, and
 * seedLiveStateFromRest → rows) BEFORE/regardless of resolving the run state.
 * The paused overlay is opaque + full-screen but only went up AFTER the async
 * broadcast check, so a STOPPED page showed the last dataset for a beat and then
 * covered it: "first loading the data and showing paused." A second leak: with
 * broadcast left on after a run finished, live-state still returns the last
 * run's results, so seed/rehydrate flashed a stale snapshot behind the overlay.
 *
 * Fix: gate every paint path on there being an ACTIVE run to show —
 *   - rehydrateFromCache repaints cached rows ONLY when the cached snapshot was
 *     an active run (status running/paused or a live batchId).
 *   - seedLiveStateFromRest paints rows ONLY when the seeded status is active.
 *   - (DOMContentLoaded resolves broadcast before any paint — covered by the
 *     pause-overlay suite; this suite locks the two paint-gate functions.)
 *
 * This runs the REAL rehydrateFromCache + seedLiveStateFromRest extracted from
 * live.html against a fake localStorage / fetch / DOM and counts paints.
 *
 * Run: node test/live-load-gating.test.js
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
const html = readFileSync(join(__dirname, '..', 'live.html'), 'utf8');

function extractFn(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found in live.html`);
  let depth = 0, started = false, j = m.index;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(m.index, j);
}

const extracted = ['_cachedRunActive', 'rehydrateFromCache', 'seedLiveStateFromRest']
  .map(n => extractFn(html, n)).join('\n\n');

// ─── Fake environment ────────────────────────────────────────────────────────
let addSingleRowCount = 0; // rehydrate row paints
let upsertCount = 0;       // seed row paints

function makeSandbox() {
  addSingleRowCount = 0;
  upsertCount = 0;
  const sandbox = {
    // tunables / state the functions close over
    LIVE_CACHE_KEY: 'live:snapshot:v1',
    LIVE_CACHE_TTL_MS: 60 * 60 * 1000,
    _prevActiveRunNumber: null,
    _liveState: {},
    resultsArr: [],
    _cb: { batchId: null, snapshotSize: 0, tested: 0 },
    Date, Object, Number, Array, console,
    // localStorage + fetch injected per-case below
    localStorage: null,
    fetch: null,
    // painted-row spies
    addSingleRow: () => { addSingleRowCount++; },
    upsert: () => { upsertCount++; },
    // harmless stubs
    cbRender: () => {},
    applyHeaderStatsFromState: () => {},
    renderLiveStats: () => {},
    mergeLiveState: (s) => { sandbox._liveState = { ...sandbox._liveState, ...(s || {}) }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extracted, sandbox);
  return sandbox;
}

function fakeLocalStorage(snapObj) {
  const store = snapObj == null ? {} : { 'live:snapshot:v1': JSON.stringify(snapObj) };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
}

function fakeFetch(jsonBody, okFlag = true) {
  return () => Promise.resolve({ ok: okFlag, json: () => Promise.resolve(jsonBody) });
}

const NOW = Date.now();
const activeSnap = (status) => ({
  ts: NOW, broadcastLive: true,
  state: { status }, cb: { batchId: status ? 7 : null },
  results: [{ address: 'sent1a' }, { address: 'sent1b' }],
});
const idleSnap = {
  ts: NOW, broadcastLive: true,
  state: { status: 'done' }, cb: { batchId: null },
  results: [{ address: 'sent1a' }, { address: 'sent1b' }, { address: 'sent1c' }],
};

console.log('\n/live load-sequence gating — stopped-flash regression\n');

// ─── 0. _cachedRunActive: synchronous overlay decision (no network) ──────────
console.log('[0] _cachedRunActive drives the synchronous overlay decision');
function cachedActive(snap) {
  const sb = makeSandbox();
  sb.localStorage = fakeLocalStorage(snap);
  return vm.runInContext('_cachedRunActive()', sb);
}
ok(cachedActive(activeSnap('running')) === true,
   'broadcasting + running cache → active (reveal work synchronously)');
ok(cachedActive({ ts: NOW, broadcastLive: true, state: {}, cb: { batchId: 9 }, results: [] }) === true,
   'broadcasting + live batchId → active');
ok(cachedActive(idleSnap) === false,
   'broadcasting + done status → NOT active (overlay stays up)');
ok(cachedActive({ ...activeSnap('running'), broadcastLive: false }) === false,
   'last session not broadcasting → NOT active even if status running');
ok(cachedActive(null) === false, 'no cache → not active (default to overlay)');
{
  const stale = activeSnap('running'); stale.ts = NOW - (2 * 60 * 60 * 1000);
  ok(cachedActive(stale) === false, 'expired cache → not active');
}

// ─── 1. rehydrateFromCache: active cache repaints, idle cache does NOT ────────
console.log('[1] rehydrateFromCache gates row paint on a cached ACTIVE run');
{
  const sb = makeSandbox();
  sb.localStorage = fakeLocalStorage(activeSnap('running'));
  vm.runInContext('rehydrateFromCache()', sb);
  ok(addSingleRowCount === 2, `running cache repaints its 2 rows (got ${addSingleRowCount})`);
}
{
  const sb = makeSandbox();
  sb.localStorage = fakeLocalStorage(idleSnap);
  vm.runInContext('rehydrateFromCache()', sb);
  ok(addSingleRowCount === 0, `idle/done cache paints NOTHING (got ${addSingleRowCount})`);
}
{
  // A cache with no status but a live batchId is still "active" (mid-run).
  const sb = makeSandbox();
  sb.localStorage = fakeLocalStorage({
    ts: NOW, broadcastLive: true, state: {}, cb: { batchId: 42 },
    results: [{ address: 'sent1x' }],
  });
  vm.runInContext('rehydrateFromCache()', sb);
  ok(addSingleRowCount === 1, `cache with a live batchId repaints (got ${addSingleRowCount})`);
}
{
  // No cache at all → no paint, no throw.
  const sb = makeSandbox();
  sb.localStorage = fakeLocalStorage(null);
  vm.runInContext('rehydrateFromCache()', sb);
  ok(addSingleRowCount === 0, 'absent cache paints nothing');
}
{
  // Expired cache (older than TTL) → discarded, no paint.
  const sb = makeSandbox();
  const stale = activeSnap('running'); stale.ts = NOW - (2 * 60 * 60 * 1000);
  sb.localStorage = fakeLocalStorage(stale);
  vm.runInContext('rehydrateFromCache()', sb);
  ok(addSingleRowCount === 0, 'expired cache (past TTL) paints nothing');
}

// ─── 2. seedLiveStateFromRest: active state paints, idle/done does NOT ────────
console.log('[2] seedLiveStateFromRest gates row paint on an ACTIVE run status');
async function seedCase(body) {
  const sb = makeSandbox();
  sb.fetch = fakeFetch(body);
  await vm.runInContext('seedLiveStateFromRest()', sb);
  return sb;
}
{
  const sb = await seedCase({
    broadcastLive: true, state: { status: 'running' }, activeBatchId: 9, snapshotSize: 100,
    results: [{ address: 'sent1a' }, { address: 'sent1b' }],
  });
  ok(upsertCount === 2, `running state paints its 2 rows (got ${upsertCount})`);
  ok(sb._cb.batchId === 9, 'running state pins the active batch id');
}
{
  await seedCase({
    broadcastLive: true, state: { status: 'done' }, activeBatchId: null,
    results: [{ address: 'sent1a' }, { address: 'sent1b' }, { address: 'sent1c' }],
  });
  ok(upsertCount === 0, `done state (broadcast still on) paints NOTHING (got ${upsertCount})`);
}
{
  await seedCase({
    broadcastLive: true, state: { status: 'idle' }, activeBatchId: null,
    results: [{ address: 'sent1a' }],
  });
  ok(upsertCount === 0, 'idle state paints nothing');
}
{
  // paused_balance / paused_internet mid-run: a live batchId keeps it active.
  const sb = await seedCase({
    broadcastLive: true, state: { status: 'paused_balance' }, activeBatchId: 5,
    results: [{ address: 'sent1a' }],
  });
  ok(upsertCount === 1, `paused_balance + live batchId still paints (got ${upsertCount})`);
  ok(sb._cb.batchId === 5, 'paused_balance mid-run pins the batch id');
}
{
  // broadcast off → seed bails before any paint (overlay path owns this).
  await seedCase({ broadcastLive: false, state: {}, results: [] });
  ok(upsertCount === 0, 'broadcast off → seed paints nothing');
}

console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
console.log('='.repeat(60));
process.exit(out.fail ? 1 : 0);
