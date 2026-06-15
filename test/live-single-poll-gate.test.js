/**
 * /live single-poll gate — paused page makes ONE network call
 *
 * Request: "When showing paused it should only make one network call to check
 * whether there is an active run or no. If [active] then make the necessary
 * calls and show the live page."
 *
 * Before: while paused, /live fired /stats, /runs/last, /events (SSE), /status,
 * /live-state and /logs on every load — six requests for a page showing nothing
 * but the paused overlay. Root cause: DOMContentLoaded fanned out to every work
 * endpoint whenever broadcast was on, regardless of whether a run was in flight.
 *
 * Fix: /api/broadcast now returns { broadcastLive, activeRun }. checkBroadcastState
 * polls ONLY that endpoint; it calls connectLiveWork() (SSE + logs + live-state +
 * batch + stats) exactly once on a paused→active transition, and nothing else
 * while paused. This runs the REAL checkBroadcastState + connectLiveWork extracted
 * from live.html against a fake fetch/DOM and counts the calls.
 *
 * Run: node test/live-single-poll-gate.test.js
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

const extracted = ['connectLiveWork', 'checkBroadcastState']
  .map(n => extractFn(html, n)).join('\n\n');

function makeSandbox(broadcastResponses) {
  // broadcastResponses: array of { broadcastLive, activeRun } returned in order.
  const calls = { fetchUrls: [], work: 0, sseConnect: 0, sseClose: 0, paused: [] };
  let idx = 0;
  const sandbox = {
    console,
    _broadcastLive: false,
    _activeRun: false,
    _liveWorkConnected: false,
    _sse: null,
    // The single allowed poll endpoint:
    fetch: (url) => {
      calls.fetchUrls.push(url);
      const body = broadcastResponses[Math.min(idx, broadcastResponses.length - 1)];
      idx++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    },
    document: { getElementById: () => null },
    // Work-endpoint spies — every one of these is a network call we must NOT
    // make while paused.
    rehydrateFromCache: () => {},
    renderTable: () => {},
    renderLiveStats: () => {},
    connectSSE: () => { calls.sseConnect++; sandbox._sse = { close: () => { calls.sseClose++; } }; },
    seedLogsFromRest: () => { calls.work++; },
    seedLiveStateFromRest: () => { calls.work++; return Promise.resolve(); },
    loadCurrentBatch: () => { calls.work++; },
    loadHeaderStats: () => { calls.work++; },
    applyPauseFromState: () => {},
    showPaused: (on) => { calls.paused.push(on); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extracted, sandbox);
  return { sandbox, calls };
}

console.log('\n/live single-poll gate — paused page makes ONE network call\n');

// ─── 1. Paused: exactly one call to /api/broadcast, no work endpoints ────────
console.log('[1] paused (activeRun=false) → only /api/broadcast');
{
  const { sandbox, calls } = makeSandbox([{ broadcastLive: true, activeRun: false }]);
  await vm.runInContext('checkBroadcastState()', sandbox);
  ok(calls.fetchUrls.length === 1 && /\/api\/broadcast/.test(calls.fetchUrls[0]),
     `one fetch, to /api/broadcast (got ${calls.fetchUrls.length}: ${calls.fetchUrls.join(',')})`);
  ok(calls.work === 0, `no work-endpoint calls while paused (got ${calls.work})`);
  ok(calls.sseConnect === 0, 'no SSE connection while paused');
  ok(calls.paused.length && calls.paused[calls.paused.length - 1] === true,
     'overlay shown while paused');
  ok(sandbox._liveWorkConnected === false, 'work stays disconnected while paused');
}

// ─── 2. Broadcast off entirely → still only the one poll, overlay up ─────────
console.log('[2] broadcast off → one poll, overlay up, no work');
{
  const { sandbox, calls } = makeSandbox([{ broadcastLive: false, activeRun: false }]);
  await vm.runInContext('checkBroadcastState()', sandbox);
  ok(calls.fetchUrls.length === 1, 'exactly one fetch when broadcast off');
  ok(calls.work === 0 && calls.sseConnect === 0, 'no work / SSE when broadcast off');
  ok(sandbox._broadcastLive === false, '_broadcastLive reflects off');
}

// ─── 3. paused→active transition fans out EXACTLY once ───────────────────────
console.log('[3] paused→active → connectLiveWork fires the full fan-out once');
{
  const { sandbox, calls } = makeSandbox([{ broadcastLive: true, activeRun: true }]);
  await vm.runInContext('checkBroadcastState()', sandbox);
  ok(calls.fetchUrls.length === 1, 'broadcast poll itself is still one call');
  ok(calls.sseConnect === 1, 'SSE connected once on activation');
  ok(calls.work === 4, `all four work endpoints hit once (logs+live-state+batch+stats) (got ${calls.work})`);
  ok(sandbox._liveWorkConnected === true, 'work marked connected');
}

// ─── 4. staying active across polls does NOT re-fan-out ──────────────────────
console.log('[4] active→active second poll does not reconnect');
{
  const { sandbox, calls } = makeSandbox([
    { broadcastLive: true, activeRun: true },
    { broadcastLive: true, activeRun: true },
  ]);
  await vm.runInContext('checkBroadcastState()', sandbox);
  await vm.runInContext('checkBroadcastState()', sandbox);
  ok(calls.fetchUrls.length === 2, 'two broadcast polls');
  ok(calls.sseConnect === 1, 'SSE connected only once across both polls');
  ok(calls.work === 4, `work endpoints hit only once total (got ${calls.work})`);
}

// ─── 5. active→paused tears down the stream and re-arms ──────────────────────
console.log('[5] active→paused closes SSE and re-arms for the next run');
{
  const { sandbox, calls } = makeSandbox([
    { broadcastLive: true, activeRun: true },
    { broadcastLive: true, activeRun: false },
    { broadcastLive: true, activeRun: true },
  ]);
  await vm.runInContext('checkBroadcastState()', sandbox); // active: connect
  await vm.runInContext('checkBroadcastState()', sandbox); // paused: teardown
  ok(calls.sseClose === 1, 'SSE closed on active→paused');
  ok(sandbox._liveWorkConnected === false, 're-armed (disconnected) while paused');
  await vm.runInContext('checkBroadcastState()', sandbox); // active again: reconnect
  ok(calls.sseConnect === 2, 'SSE reconnects on the next activation');
  ok(calls.work === 8, `full fan-out runs again on re-activation (got ${calls.work})`);
}

console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
console.log('='.repeat(60));
process.exit(out.fail ? 1 : 0);
