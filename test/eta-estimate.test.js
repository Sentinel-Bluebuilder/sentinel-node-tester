/**
 * server-authoritative ETA — computeEtaFinishAt() windowed-throughput math
 *
 * admin.html and live.html used to compute ETA independently from different
 * inputs, so they disagreed. The server now owns ONE ETA: it keeps a rolling
 * window of the last ETA_WINDOW node-completion timestamps, derives the current
 * completion RATE (nodes/ms), and broadcasts an absolute finish epoch
 * (`etaFinishAtMs`). Both pages render max(0, etaFinishAtMs - Date.now()).
 *
 * This test vm-extracts the REAL computeEtaFinishAt from server.js (balanced-
 * brace extractor with a loud mis-extraction guard) and exercises the edge
 * cases + the window math. Because the fn reads module-level _etaCompletions,
 * we define _etaCompletions / _etaLastDone in the sandbox and reassign them
 * between cases. It also asserts PUBLIC_STATE_KEYS carries etaFinishAtMs.
 *
 * Run: node test/eta-estimate.test.js
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

// Balanced-brace function extractor (mirrors public-sse-fields.test.js).
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

// Loud mis-extraction guard: a brace inside a string/regex would truncate the
// slice and turn into a confusing assertion downstream. Assert the extracted
// block ends with `}` AND still contains the rate math / etaFinishAtMs sentinel.
function mustExtract(extracted, what, endToken, sentinel) {
  const trimmed = extracted.trimEnd();
  if (!trimmed.endsWith(endToken)) {
    throw new Error(`mis-extracted ${what}: expected it to end with "${endToken}" ` +
      `but got "...${trimmed.slice(-40)}"`);
  }
  if (!extracted.includes(sentinel)) {
    throw new Error(`mis-extracted ${what}: expected it to contain "${sentinel}"`);
  }
  return extracted;
}

const sandbox = { console };
vm.createContext(sandbox);
// Module-level state the fn reads. Reassigned between cases below.
vm.runInContext('var _etaCompletions = []; var _etaLastDone = -1;', sandbox);
vm.runInContext(
  mustExtract(extractFn(src, 'computeEtaFinishAt'), 'computeEtaFinishAt', '}', 'etaMs'),
  sandbox);

const setWindow = (arr) => { sandbox._etaCompletions = arr.slice(); };
const call = (st) => { sandbox._st = st; return vm.runInContext('computeEtaFinishAt(_st)', sandbox); };

console.log('\nserver-authoritative ETA — computeEtaFinishAt()\n');

// ─── 1. null guards ──────────────────────────────────────────────────────────
console.log('[1] null guards');
{
  setWindow([1000, 2000, 3000]);
  ok(call(null) === null, 'returns null for null state');
  ok(call('nope') === null, 'returns null for non-object state');
  ok(call({ status: 'done', testedNodes: 5, totalNodes: 30 }) === null,
     'returns null when status !== running (done)');
  ok(call({ status: 'idle', totalNodes: 30 }) === null,
     'returns null when status idle');
  ok(call({ status: 'paused_internet', totalNodes: 30 }) === null,
     'returns null when paused');
  ok(call({ status: 'running', totalNodes: 0 }) === null,
     'returns null when total <= 0');
}

// ─── 2. not enough data ──────────────────────────────────────────────────────
console.log('[2] fewer than 2 completions → null');
{
  setWindow([]);
  ok(call({ status: 'running', testedNodes: 5, totalNodes: 30 }) === null,
     'null with 0 completions');
  setWindow([1000]);
  ok(call({ status: 'running', testedNodes: 5, totalNodes: 30 }) === null,
     'null with 1 completion');
}

// ─── 3. remaining <= 0 → finish now ──────────────────────────────────────────
console.log('[3] remaining <= 0 → finish now (≈ Date.now)');
{
  setWindow([1000, 2000, 3000]);
  const now = Date.now();
  const r = call({ status: 'running', testedNodes: 30, totalNodes: 30 });
  ok(Number.isFinite(r) && Math.abs(r - now) < 1000,
     'returns ≈now when remaining <= 0 (got delta ' + (r - now) + 'ms)');
}

// ─── 4. windowed throughput math (first/last span, not pairwise) ─────────────
console.log('[4] windowed throughput → finishAt - now ≈ remaining / rate');
{
  // 11 completions spaced 1000ms apart → span = 10000ms across 10 intervals →
  // rate = 10/10000 = 1 node/sec. done=10, total=30 → remaining=20 → 20000ms.
  const base = 1_000_000;
  const win = [];
  for (let i = 0; i < 11; i++) win.push(base + i * 1000);
  setWindow(win);
  const now = Date.now();
  const r = call({ status: 'running', testedNodes: 6, failedNodes: 3, skippedNodes: 1, totalNodes: 30 });
  const eta = r - now;
  ok(eta >= 19000 && eta <= 21000,
     'rate 1 node/sec, remaining 20 → ETA ≈ 20000ms (got ' + eta + 'ms)');
}
{
  // First/last span only: a clustered window must NOT be averaged pairwise.
  // 3 entries: 0, 100, 10000 → span 10000 over 2 intervals → rate 2/10000 =
  // 0.0002/ms. remaining=10 → 10/0.0002 = 50000ms. (Pairwise-avg would give a
  // very different number.)
  setWindow([1_000_000, 1_000_100, 1_010_000]);
  const now = Date.now();
  const r = call({ status: 'running', testedNodes: 10, totalNodes: 20 });
  const eta = r - now;
  ok(eta >= 49000 && eta <= 51000,
     'first/last span used (not pairwise): ETA ≈ 50000ms (got ' + eta + 'ms)');
}

// ─── 5. PUBLIC_STATE_KEYS carries etaFinishAtMs ──────────────────────────────
console.log('[5] PUBLIC_STATE_KEYS includes etaFinishAtMs');
{
  ok(/PUBLIC_STATE_KEYS\s*=\s*\[[\s\S]*?'etaFinishAtMs'[\s\S]*?\]/.test(src),
     'server.js PUBLIC_STATE_KEYS array contains etaFinishAtMs');
}

console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
console.log('='.repeat(60));
process.exit(out.fail ? 1 : 0);
