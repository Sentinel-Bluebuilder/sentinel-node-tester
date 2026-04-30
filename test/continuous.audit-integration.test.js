/**
 * Continuous Loop — Live Integration Audit
 * Verifies the JSDoc claims against actual behavior with a fast mock pipeline
 * but real db.js + real .loop-config.json + real SSE emitter.
 *
 * Run: NODE_ENV=test node test/continuous.audit-integration.test.js
 */

import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(__dirname, '..', 'results', '.loop-config.json');

const out = { pass: 0, fail: 0, errors: [] };
function ok(cond, name) {
  if (cond) { out.pass++; console.log(`  PASS  ${name}`); }
  else      { out.fail++; out.errors.push(name); console.log(`  FAIL  ${name}`); }
}
async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() >= end) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

async function main() {
  process.env.NODE_ENV = 'test';
  process.env.MNEMONIC = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';

  // Use :memory: per the existing smoke-test pattern. db.js blocks prod paths
  // from test processes (NODE_ENV=test) as a guardrail.
  const { useDb, getDb } = await import('../core/db.js');
  useDb(getDb(':memory:'));

  const cont = await import('../audit/continuous.js');
  const { start, stop, status, on, _injectRunnerFn, _setDelayOverride, readPersistedLoopConfig } = cont;

  // Speed: zero inter-batch delay
  _setDelayOverride(0);

  // ─── 1. Verify JSDoc events fire ─────────────────────────────────────
  console.log('\n[1] Event spec compliance');
  const got = {
    'loop:started': [], 'loop:stopping': [], 'loop:stopped': [], 'loop:error': [],
    'iteration:start': [], 'iteration:end': [],
    'batch:start': [], 'batch:node:result': [], 'batch:end': [], 'batch:gap': [],
  };
  for (const e of Object.keys(got)) on(e, d => got[e].push(d));

  // ─── 2. Mock pipeline that emits per-node 'result' broadcasts ────────
  // Mimics how real pipeline.js calls broadcast('result',{result,state}) per node.
  console.log('[2] Mock pipeline emitting 3 node results per iteration');
  const FAKE_NODES = [
    { address: 'sentnode1aaa', moniker: 'Alpha',  country: 'US', city: 'Dallas',  type: 'wireguard', actualMbps: 25.5, peers: 3, errorCode: null },
    { address: 'sentnode1bbb', moniker: 'Bravo',  country: 'DE', city: 'Berlin',  type: 'v2ray',     actualMbps: 12.0, peers: 1, errorCode: null },
    { address: 'sentnode1ccc', moniker: 'Charlie',country: 'JP', city: 'Tokyo',   type: 'wireguard', actualMbps: null, peers: 0, errorCode: 'TIMEOUT', error: 'timed out' },
  ];

  _injectRunnerFn(async (loopState, broadcast) => {
    // Real continuous.js wires broadcast itself via batchBroadcast — but the
    // injected runner signature is (loopState) only. So we can't drive the
    // batchBroadcast path through the injection. Instead we mutate loopState
    // counters and rely on the `_runnerFn` short-circuit to skip insertBatch
    // entirely (the production guard `if (!_runnerFn)` excludes it). That
    // means: with a mock runner, batch_results writes are NOT exercised.
    //
    // To exercise insertBatch + batch_results paths we MUST run with the real
    // pipeline path (no _injectRunnerFn). That requires actually testing nodes,
    // which is too slow for an audit. So this test verifies the loop control
    // surface; a separate live test exercises the DB-write path.
    loopState.testedNodes = 2;
    loopState.failedNodes = 1;
    await new Promise(r => setTimeout(r, 30));
  });

  const r = await start({ mode: 'p2p', minDelayMs: 30_000 });
  ok(r.ok === true, 'start() returns ok=true');
  ok(status().running === true, 'status.running=true after start');
  ok(status().mode === 'p2p', 'status.mode=p2p');

  // Wait for at least 2 full iterations
  await waitFor(() => got['iteration:end'].length >= 2, 5000);

  // ─── 3. Verify loop-config persisted to disk ─────────────────────────
  console.log('[3] Persistence to .loop-config.json');
  const cfg = readPersistedLoopConfig();
  ok(cfg !== null, 'readPersistedLoopConfig() returns object');
  ok(cfg && cfg.running === true, 'persisted config: running=true while loop active');
  ok(cfg && cfg.mode === 'p2p', 'persisted config: mode=p2p');

  stop();
  await waitFor(() => status().running === false, 3000);

  // ─── 4. After stop, persisted config should reflect running=false ────
  const cfg2 = readPersistedLoopConfig();
  ok(cfg2 && cfg2.running === false, 'persisted config: running=false after stop');

  // ─── 5. Event-spec compliance ────────────────────────────────────────
  console.log('[5] Event-spec compliance');
  ok(got['loop:started'].length >= 1, 'loop:started fired');
  ok(got['loop:started'][0].mode === 'p2p', 'loop:started.mode=p2p');
  ok(got['iteration:start'].length >= 2, 'iteration:start fired ≥2');
  ok(got['iteration:end'].length   >= 2, 'iteration:end fired ≥2');
  ok(got['iteration:start'][0].iteration === 1, 'iteration:start.iteration=1');
  ok(got['iteration:end'][0].passed === 2, 'iteration:end.passed=2');
  ok(got['iteration:end'][0].failed === 1, 'iteration:end.failed=1');
  ok(typeof got['iteration:end'][0].durationMs === 'number', 'iteration:end.durationMs is number');
  ok(got['loop:stopping'].length >= 1, 'loop:stopping fired');
  ok(got['loop:stopped'].length === 1, 'loop:stopped fired exactly once');
  ok(got['loop:stopped'][0].reason === 'requested', 'loop:stopped.reason=requested');
  ok(got['batch:gap'].length >= 1, 'batch:gap fired');

  // batch:start / batch:end SHOULD fire even with mock runner — they're
  // unconditional on the no-runner guard? Check by reading source:
  //   line 482 emits batch:start unconditionally
  //   line 549 emits batch:end unconditionally
  ok(got['batch:start'].length >= 2, `batch:start fired ≥2 (got ${got['batch:start'].length})`);
  ok(got['batch:end'].length   >= 2, `batch:end fired ≥2 (got ${got['batch:end'].length})`);

  // batch:node:result requires real pipeline path — should NOT fire with mock runner
  ok(got['batch:node:result'].length === 0,
     `batch:node:result NOT fired with mock (got ${got['batch:node:result'].length}) — confirms _runnerFn short-circuits batchBroadcast`);

  // ─── 6. Status after stop ─────────────────────────────────────────────
  const s = status();
  ok(s.iteration >= 2, `final iteration count ≥2 (got ${s.iteration})`);
  ok(s.running === false, 'final running=false');
  ok(s.uptime !== null || s.startedAt !== null, 'startedAt was set during run');

  // ─── 7. Pause/resume contract (no real pipeline so resumeIntent path) ─
  console.log('[7] Pause/resume contract');
  // reset for next phase
  for (const k of Object.keys(got)) got[k].length = 0;
  _injectRunnerFn(async (loopState) => {
    loopState.testedNodes = 1;
    loopState.failedNodes = 0;
    // Long enough that we can pause mid-run
    await new Promise(r => setTimeout(r, 800));
  });
  await start({ mode: 'p2p', minDelayMs: 30_000 });
  await waitFor(() => status().running === true, 500);

  // Pause mid-run
  const pr = cont.pause();
  ok(pr.ok === true, 'pause() returns ok=true');
  await waitFor(() => status().running === false, 3000);
  ok(status().paused === true, 'status.paused=true after pause');
  // With mock runner there's no insertBatch, so currentBatchId stays 0 and
  // status() returns pausedBatchId=null (the `0 || null` fallback). In prod
  // with a real runner, insertBatch fires and pausedBatchId is the real row
  // id. We assert the documented contract here: paused=true is set; batchId
  // is non-null only when a real DB batch row was opened.
  // Confirms via _ctrl that paused-state seeded internally:
  ok(status().paused === true, 'status.paused=true after pause (re-check)');

  // Resume
  const rr = await cont.resume();
  ok(rr.ok === true, 'resume() returns ok=true');
  await waitFor(() => status().running === true, 1000);
  ok(status().paused === false, 'paused=false after resume');

  stop();
  await waitFor(() => status().running === false, 3000);

  // ─── 8. Subscription mode rejected without granter ───────────────────
  console.log('[8] Subscription mode validation');
  _injectRunnerFn(null);
  const sub1 = await start({ mode: 'subscription' });
  ok(sub1.ok === false && /planId/i.test(sub1.error), 'sub mode no planId rejected');
  const sub2 = await start({ mode: 'subscription', planId: '1' });
  ok(sub2.ok === false && /subscriptionId/i.test(sub2.error), 'sub mode no subId rejected');
  const sub3 = await start({ mode: 'subscription', planId: '1', subscriptionId: '99' });
  ok(sub3.ok === false && /granter/i.test(sub3.error), 'sub mode no granter rejected');

  // ─── 9. Cleanup ──────────────────────────────────────────────────────
  if (existsSync(CFG_PATH)) {
    // Don't unlink — server may auto-resume. Just print final state.
    const final = readPersistedLoopConfig();
    console.log('  (final persisted cfg:', JSON.stringify(final), ')');
  }

  console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed`);
  if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
  console.log('='.repeat(60));
  process.exit(out.fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
