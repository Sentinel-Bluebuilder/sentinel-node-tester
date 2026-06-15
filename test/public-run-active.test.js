/**
 * publicRunActive() — idle /live must not load the last run's data
 *
 * Bug: the public live surfaces (SSE init, /api/public/logs, /api/public/live-state)
 * shipped the log backlog + per-node results whenever broadcastLive was on —
 * even with NO run in flight. Right after a server boot, logBuffer is hydrated
 * from results/audit-*.log, so an idle /live page LOADED that backlog (and the
 * last run's results) behind the opaque "Testing Has Been Paused" overlay.
 * Removing the overlay in devtools revealed a live log + TESTED count but no
 * rows — the page was loading data it should not.
 *
 * Fix: gate every public work payload on publicRunActive() — true only when a
 * run is genuinely in flight (continuous loop running, OR an active batch row,
 * OR state.status running/paused*). This test runs the REAL publicRunActive
 * extracted from server.js against stubbed continuous/getActiveBatch/state.
 *
 * Run: node test/public-run-active.test.js
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

const extracted = extractFn(src, 'publicRunActive');

function evalActive({ running = false, activeBatch = null, status = 'idle' } = {}) {
  const sandbox = {
    continuous: { status: () => ({ running }) },
    getActiveBatch: () => activeBatch,
    state: { status },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(extracted, sandbox);
  return vm.runInContext('publicRunActive()', sandbox);
}

console.log('\npublicRunActive() — idle /live must not load data\n');

// ─── Active signals ──────────────────────────────────────────────────────────
console.log('[1] any active signal → true');
ok(evalActive({ running: true, status: 'idle' }) === true,
   'continuous loop running → active');
ok(evalActive({ activeBatch: { batch: { id: 9 } }, status: 'idle' }) === true,
   'an in-flight batch row → active (covers direct p2p / sub-plan / test runs)');
ok(evalActive({ status: 'running' }) === true,
   'state.status running → active');
ok(evalActive({ status: 'paused_balance' }) === true,
   'state.status paused_balance (mid-run pause) → active');
ok(evalActive({ status: 'paused_internet' }) === true,
   'state.status paused_internet (mid-run pause) → active');

// ─── Idle / terminal → NOT active ────────────────────────────────────────────
console.log('[2] idle / terminal → false (paused page loads nothing)');
ok(evalActive({ status: 'idle' }) === false, 'fresh boot, idle → not active');
ok(evalActive({ status: 'done' }) === false, 'finished run (done) → not active');
ok(evalActive({ status: 'stopped' }) === false, 'stopped run → not active');
ok(evalActive({ status: 'error' }) === false, 'errored run → not active');
ok(evalActive({ running: false, activeBatch: null, status: undefined }) === false,
   'no signals at all → not active');

// ─── Robust to throwing dependencies ─────────────────────────────────────────
console.log('[3] throwing continuous/getActiveBatch does not crash the gate');
{
  const sandbox = {
    continuous: { status: () => { throw new Error('boom'); } },
    getActiveBatch: () => { throw new Error('boom'); },
    state: { status: 'idle' },
    console: { error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(extracted, sandbox);
  ok(vm.runInContext('publicRunActive()', sandbox) === false,
     'both deps throw + idle status → false, no throw');
}

console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
console.log('='.repeat(60));
process.exit(out.fail ? 1 : 0);
