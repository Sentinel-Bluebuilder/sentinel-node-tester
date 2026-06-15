/**
 * /live pause overlay — cold-load flash regression
 *
 * Bug: on load, checkBroadcastState() called applyPauseFromState() BEFORE the
 * authoritative live-state was fetched. With an empty/cached state (status
 * undefined, _cb.batchId null) the function computed "not running, no batch" and
 * flashed the "Testing Has Been Paused" overlay ON for an ACTIVE run — then the
 * real running state landed and turned it back off. Users saw paused, twice,
 * then the live page.
 *
 * Fix: gate the run-status pause decision on _liveStateResolved (set once the
 * REST live-state seed or an SSE state/init lands). broadcastLive=false stays
 * immediate (authoritative: nothing being broadcast).
 *
 * This test runs the REAL applyPauseFromState + showPaused extracted from
 * live.html against a fake overlay element.
 *
 * Run: node test/live-pause-overlay.test.js
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
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found in live.html`);
  let depth = 0, started = false, j = m.index;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(m.index, j);
}

const extracted = ['showPaused', 'applyPauseFromState'].map(n => extractFn(html, n)).join('\n\n');

// ─── Fake overlay element ────────────────────────────────────────────────────
const overlay = {
  _shown: false,
  classList: { toggle(cls, on) { if (cls === 'show') overlay._shown = !!on; } },
  setAttribute() {},
};
const fakeDocument = { getElementById: (id) => (id === 'pausedOverlay' ? overlay : null) };

const sandbox = {
  document: fakeDocument,
  _broadcastLive: false,
  _liveStateResolved: false,
  _liveState: {},
  _cb: { batchId: null },
  console,
};
vm.createContext(sandbox);
vm.runInContext(extracted, sandbox);

// Helper: set globals, run applyPauseFromState, return overlay shown state.
function evalPause({ broadcastLive, resolved, status, batchId, overlayStart = false }) {
  overlay._shown = overlayStart;
  Object.assign(sandbox, {
    _broadcastLive: broadcastLive,
    _liveStateResolved: resolved,
    _liveState: status === undefined ? {} : { status },
    _cb: { batchId: batchId ?? null },
  });
  vm.runInContext('applyPauseFromState()', sandbox);
  return overlay._shown;
}

console.log('\n/live pause overlay — cold-load flash regression\n');

// ─── 1. THE BUG: cold load, broadcast on, active run not yet confirmed ───────
console.log('[1] cold load (broadcast on, unresolved) does NOT flash paused');
ok(evalPause({ broadcastLive: true, resolved: false, status: undefined, batchId: null }) === false,
   'unresolved + empty state → overlay stays HIDDEN (no flash)');
ok(evalPause({ broadcastLive: true, resolved: false, status: undefined, batchId: null, overlayStart: false }) === false,
   'unresolved never turns the overlay on');

// ─── 2. After authoritative state lands ──────────────────────────────────────
console.log('[2] resolved state drives the overlay correctly');
ok(evalPause({ broadcastLive: true, resolved: true, status: 'running', batchId: 7 }) === false,
   'resolved + running → not paused');
ok(evalPause({ broadcastLive: true, resolved: true, status: 'paused', batchId: 7 }) === false,
   'resolved + paused (balance/internet) → keep live view, not the overlay');
ok(evalPause({ broadcastLive: true, resolved: true, status: 'idle', batchId: null }) === true,
   'resolved + idle + no batch → overlay shown');
ok(evalPause({ broadcastLive: true, resolved: true, status: 'done', batchId: null }) === true,
   'resolved + done + no batch → overlay shown');

// ─── 3. Mid-batch keeps the live view even if status lags ────────────────────
console.log('[3] an in-flight batch keeps the live view');
ok(evalPause({ broadcastLive: true, resolved: true, status: 'idle', batchId: 42 }) === false,
   'resolved + idle status but active batchId → not paused');
// Real-world: the pipeline emits paused_balance / paused_internet (never bare
// 'paused'), which do NOT match the running check — the live view is preserved
// for those via the in-flight batchId, not the status. Lock that contract.
ok(evalPause({ broadcastLive: true, resolved: true, status: 'paused_balance', batchId: 42 }) === false,
   'resolved + paused_balance + active batchId → live view kept (via batchId)');

// ─── 4. Broadcast off is authoritative and immediate ─────────────────────────
console.log('[4] broadcast off shows the overlay immediately (even unresolved)');
ok(evalPause({ broadcastLive: false, resolved: false, status: undefined, batchId: null }) === true,
   'broadcast off + unresolved → overlay shown right away');
ok(evalPause({ broadcastLive: false, resolved: true, status: 'running', batchId: 7 }) === true,
   'broadcast off overrides even a running status');

console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
console.log('='.repeat(60));
process.exit(out.fail ? 1 : 0);
