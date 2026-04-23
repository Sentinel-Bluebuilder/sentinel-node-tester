/**
 * Sentinel Node Tester — Continuous Loop Smoke Tests
 * Uses a mocked pipeline runner to verify start/stop/status behaviour,
 * iteration counting, event emission, and rejection guard-rails.
 *
 * Run: node test/continuous.smoke.test.js
 * Does NOT touch the chain, wallet, or filesystem.
 */

const results = { pass: 0, fail: 0, errors: [] };

function assert(condition, name) {
  if (condition) {
    results.pass++;
  } else {
    results.fail++;
    results.errors.push(name);
  }
}

/** Wait at most `ms` for `predicate()` to become true. Polls every 20 ms. */
async function waitFor(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

async function run() {
  console.log('Continuous Loop — Smoke Tests\n');

  // ─── 1. Module Import ────────────────────────────────────────────────────
  console.log('1. Module import...');
  let cont;
  try {
    cont = await import('../audit/continuous.js');
    assert(true, 'import continuous.js');
  } catch (e) {
    assert(false, `IMPORT continuous.js: ${e.message}`);
    // Cannot continue without the module
    process.exit(1);
  }

  const { start, stop, status, on, off, _injectRunnerFn, _setDelayOverride } = cont;
  assert(typeof start === 'function', 'export: start');
  assert(typeof stop === 'function', 'export: stop');
  assert(typeof status === 'function', 'export: status');
  assert(typeof on === 'function', 'export: on');
  assert(typeof off === 'function', 'export: off');
  assert(typeof _injectRunnerFn === 'function', 'export: _injectRunnerFn');
  assert(typeof _setDelayOverride === 'function', 'export: _setDelayOverride');

  // Redirect the DB singleton to an in-memory database so the continuous-loop
  // persistence path (when it runs) can never poison the production audit.db.
  // The mock-runner branch in continuous.js already skips insertRun, but tests
  // that enable the real runner or forget _injectRunnerFn still need safety.
  const { getDb, useDb } = await import('../core/db.js');
  useDb(getDb(':memory:'));

  // Enable zero-delay mode so iterations fire immediately without waiting 30s
  _setDelayOverride(0);

  // ─── 2. Initial status ───────────────────────────────────────────────────
  console.log('2. Initial status...');
  const s0 = status();
  assert(s0.running === false, 'initial running=false');
  assert(s0.iteration === 0, 'initial iteration=0');
  assert(s0.mode === null, 'initial mode=null');
  assert(s0.lastError === null, 'initial lastError=null');
  assert(s0.uptime === null, 'initial uptime=null');

  // ─── 3. Rejection guards ─────────────────────────────────────────────────
  console.log('3. Rejection guards (no mnemonic, bad mode)...');

  // Bad mode
  const r1 = await start({ mode: 'invalid' });
  assert(r1.ok === false, 'bad mode → ok=false');
  assert(typeof r1.error === 'string', 'bad mode → error string');

  // Missing MNEMONIC — process.env.MNEMONIC is likely unset in CI / test runner
  // The guard fires only when MNEMONIC is falsy, so unset it to guarantee the path.
  const savedMnemonic = process.env.MNEMONIC;
  delete process.env.MNEMONIC;
  const r2 = await start({ mode: 'p2p' });
  assert(r2.ok === false, 'no mnemonic → ok=false');
  assert(/MNEMONIC/i.test(r2.error || ''), 'no mnemonic → error mentions MNEMONIC');
  if (savedMnemonic) process.env.MNEMONIC = savedMnemonic;

  // Subscription mode missing planId
  process.env.MNEMONIC = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';
  const r3 = await start({ mode: 'subscription' });
  assert(r3.ok === false, 'sub mode no planId → ok=false');
  assert(/planId/i.test(r3.error || ''), 'sub mode no planId → error mentions planId');

  // Subscription mode missing subscriptionId
  const r4 = await start({ mode: 'subscription', planId: '42' });
  assert(r4.ok === false, 'sub mode no subscriptionId → ok=false');

  // Subscription mode missing granter
  const r5 = await start({ mode: 'subscription', planId: '42', subscriptionId: '7' });
  assert(r5.ok === false, 'sub mode no granter → ok=false');
  assert(/subscriptionGranter/i.test(r5.error || '') || /granter/i.test(r5.error || ''), 'sub mode no granter → error mentions granter');

  // ─── 4. Three-iteration run with mock pipeline ───────────────────────────
  console.log('4. Three-iteration run with mock pipeline...');

  // Set up a fake mnemonic so the wallet safety check passes
  process.env.MNEMONIC = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12';

  let passesCompleted = 0;
  const iterationStartEvents = [];
  const iterationEndEvents = [];
  let loopStartedEvent = null;
  let loopStoppedEvent = null;

  // Inject a mock runner that increments a counter and resolves immediately
  _injectRunnerFn((loopState) => {
    loopState.testedNodes = 5;
    loopState.failedNodes = 1;
    passesCompleted++;
    return Promise.resolve();
  });

  // Listen for events
  on('loop:started', (d) => { loopStartedEvent = d; });
  on('iteration:start', (d) => { iterationStartEvents.push(d); });
  on('iteration:end', (d) => { iterationEndEvents.push(d); });
  on('loop:stopped', (d) => { loopStoppedEvent = d; });

  // Use 0 min delay so iterations fire as fast as possible in test
  // (the floor is 30 000ms in production; we bypass it via a very short
  //  delay passed as minDelayMs — the clamp enforces ≥30000ms unless the
  //  mock runner is already in control.  Because our mock fires and returns
  //  immediately we call stop() as soon as we have 3 iterations.)
  const startResult = await start({ mode: 'p2p', minDelayMs: 30_000 });
  assert(startResult.ok === true, 'start() returns ok=true with mock runner');
  assert(status().running === true, 'status().running=true after start');
  assert(loopStartedEvent !== null, 'loop:started event fired');
  assert(loopStartedEvent.mode === 'p2p', 'loop:started.mode=p2p');

  // Wait for 3 iterations to complete
  await waitFor(() => iterationEndEvents.length >= 3, 5000);

  // Stop after 3 iterations
  const stopResult = stop();
  assert(stopResult.ok === true, 'stop() returns ok=true');

  // Wait for the loop to actually halt
  await waitFor(() => status().running === false, 3000);

  // Verify iteration counts
  assert(iterationStartEvents.length >= 3, `iteration:start fired ≥3 times (got ${iterationStartEvents.length})`);
  assert(iterationEndEvents.length >= 3, `iteration:end fired ≥3 times (got ${iterationEndEvents.length})`);
  assert(passesCompleted >= 3, `pipeline runner called ≥3 times (got ${passesCompleted})`);

  // Verify iteration event shapes
  const ev0 = iterationStartEvents[0];
  assert(ev0.iteration === 1, 'first iteration:start has iteration=1');
  assert(ev0.mode === 'p2p', 'iteration:start.mode=p2p');

  const ev0End = iterationEndEvents[0];
  assert(typeof ev0End.durationMs === 'number', 'iteration:end.durationMs is number');
  assert(ev0End.passed === 5, 'iteration:end.passed=5 (from mock)');
  assert(ev0End.failed === 1, 'iteration:end.failed=1 (from mock)');

  // Verify stopped event
  assert(loopStoppedEvent !== null, 'loop:stopped event fired');
  assert(loopStoppedEvent.iterations >= 3, `loop:stopped.iterations ≥3 (got ${loopStoppedEvent?.iterations})`);
  assert(loopStoppedEvent.reason === 'requested', 'loop:stopped.reason=requested');

  // Verify status after stop
  const sf = status();
  assert(sf.running === false, 'running=false after stop');
  assert(sf.iteration >= 3, `iteration count ≥3 after stop (got ${sf.iteration})`);

  // ─── 5. Double-start guard ────────────────────────────────────────────────
  console.log('5. Double-start guard...');

  // Inject a slow mock runner so the loop stays running
  _injectRunnerFn(async (loopState) => {
    loopState.testedNodes = 1;
    loopState.failedNodes = 0;
    await new Promise(r => setTimeout(r, 200));
  });

  const r6 = await start({ mode: 'p2p', minDelayMs: 30_000 });
  assert(r6.ok === true, 'second start() succeeds (loop was stopped)');

  await waitFor(() => status().running === true, 1000);

  const r7 = await start({ mode: 'p2p', minDelayMs: 30_000 });
  assert(r7.ok === false, 'start() while running → ok=false');
  assert(/already running/i.test(r7.error || ''), 'double-start error message');

  stop();
  await waitFor(() => status().running === false, 3000);

  // Reset injected runner so we don't leak test state
  _injectRunnerFn(null);

  // ─── 6. Stop on idle ─────────────────────────────────────────────────────
  console.log('6. Stop when already stopped...');
  const r8 = stop();
  assert(r8.ok === true, 'stop() when not running returns ok=true');
  assert(r8.alreadyStopped === true, 'stop() when idle sets alreadyStopped=true');

  // ─── Results ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed (${results.pass + results.fail} total)`);
  if (results.errors.length > 0) {
    console.log('\nFAILURES:');
    for (const e of results.errors) console.log(`  FAIL: ${e}`);
  }
  console.log(`${'='.repeat(50)}`);
  process.exit(results.fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
