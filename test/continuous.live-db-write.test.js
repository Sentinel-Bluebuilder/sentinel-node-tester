/**
 * Continuous Loop — Live DB-Write End-to-End Test
 *
 * Verifies the actual DB-write path that audit/continuous.js drives:
 *   insertBatch   → opens batch row at iteration start
 *   insertBatchResult → fires per-node from batchBroadcast('result',...)
 *   updateBatchOnFinish → closes batch row at iteration end
 *
 * The continuous-loop unit/integration tests use _injectRunnerFn, which
 * short-circuits these DB writes (the production guard `if (!_runnerFn)`
 * skips them). To verify the write path actually works, this test:
 *
 *   1. Opens a :memory: DB and points the singleton at it (useDb).
 *   2. Drives the SAME db helper functions continuous.js calls, in the
 *      SAME sequence and shape, simulating one full iteration.
 *   3. Reads back the rows and asserts schema + content match.
 *
 * Hermetic and deterministic — uses only an in-memory DB. The read-only
 * cross-check of the live production audit.db that used to follow these steps
 * has moved to scripts/verify-prod-db.mjs: it asserted facts about whatever
 * audit.db was on disk, so it could only pass on a populated production DB and
 * failed on dev/CI/fresh clones. That is an operational health check, not a
 * regression test.
 *
 * Run: NODE_ENV=test node test/continuous.live-db-write.test.js
 */

const out = { pass: 0, fail: 0, errors: [] };
function ok(cond, name) {
  if (cond) { out.pass++; console.log(`  PASS  ${name}`); }
  else      { out.fail++; out.errors.push(name); console.log(`  FAIL  ${name}`); }
}

async function main() {
  process.env.NODE_ENV = 'test';

  const { useDb, getDb, insertBatch, insertBatchResult, updateBatchOnFinish } =
    await import('../core/db.js');
  useDb(getDb(':memory:'));

  // ─── 1. Drive insertBatch with the exact shape continuous.js uses ────
  console.log('\n[1] insertBatch — opens a batch row');
  const startedAt = Date.now();
  const snapshotAddresses = [
    'sentnode1aaa', 'sentnode1bbb', 'sentnode1ccc',
  ];
  const batchId = insertBatch({
    started_at:         startedAt,
    snapshot_size:      snapshotAddresses.length,
    mode:               'p2p',
    snapshot_addresses: snapshotAddresses,
  }, 'real');
  ok(typeof batchId === 'number' && batchId > 0,
     `insertBatch returns numeric id (got ${batchId})`);

  // Read back the batch row
  const db = getDb('real');
  const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  ok(row !== undefined, 'batch row exists in DB');
  ok(row.started_at === startedAt, 'batches.started_at matches insert');
  ok(row.snapshot_size === 3, 'batches.snapshot_size=3');
  ok(row.mode === 'p2p', 'batches.mode=p2p');
  ok(row.finished_at === null, 'batches.finished_at=null at start');
  ok(row.passed === 0, 'batches.passed=0 at start');
  ok(row.failed === 0, 'batches.failed=0 at start');

  const snap = JSON.parse(row.snapshot_addresses);
  ok(Array.isArray(snap) && snap.length === 3, 'snapshot_addresses persisted as JSON array');
  ok(snap[0] === 'sentnode1aaa', 'snapshot_addresses[0] preserved');

  // ─── 2. Drive insertBatchResult — what batchBroadcast('result',...) calls ──
  console.log('[2] insertBatchResult — per-node row writes');
  const RESULTS = [
    { address: 'sentnode1aaa', type: 'wireguard', moniker: 'Alpha', country: 'United States',
      countryCode: 'US', city: 'Dallas', actualMbps: 25.5, peers: 3, maxPeers: 50,
      error: null, errorCode: null, testedAt: startedAt + 100 },
    { address: 'sentnode1bbb', type: 'v2ray', moniker: 'Bravo', country: 'Germany',
      countryCode: 'DE', city: 'Berlin', actualMbps: 12.0, peers: 1, maxPeers: 30,
      error: null, errorCode: null, testedAt: startedAt + 200 },
    { address: 'sentnode1ccc', type: 'wireguard', moniker: 'Charlie', country: 'Japan',
      countryCode: 'JP', city: 'Tokyo', actualMbps: null, peers: 0, maxPeers: 50,
      error: 'connection timed out', errorCode: 'TIMEOUT', testedAt: startedAt + 300 },
  ];
  for (const r of RESULTS) {
    insertBatchResult(batchId, r, 'real');
  }

  const brRows = db.prepare('SELECT * FROM batch_results WHERE batch_id = ? ORDER BY id').all(batchId);
  ok(brRows.length === 3, `3 batch_results rows written (got ${brRows.length})`);
  ok(brRows[0].node_address === 'sentnode1aaa', 'batch_results[0].node_address');
  ok(brRows[0].type === 'wireguard', 'batch_results[0].type');
  ok(brRows[0].actual_mbps === 25.5, 'batch_results[0].actual_mbps=25.5');
  ok(brRows[0].error_code === null, 'batch_results[0].error_code=null (passed)');
  ok(brRows[0].country === 'United States', 'batch_results[0].country');
  ok(brRows[0].country_code === 'US', 'batch_results[0].country_code');

  ok(brRows[2].error_code === 'TIMEOUT', 'batch_results[2].error_code=TIMEOUT');
  ok(brRows[2].actual_mbps === null, 'batch_results[2].actual_mbps=null (failed)');
  ok(brRows[2].error === 'connection timed out', 'batch_results[2].error message preserved');

  // FK relationship
  const fkCheck = db.prepare('SELECT batch_id FROM batch_results WHERE id = ?').get(brRows[0].id);
  ok(fkCheck.batch_id === batchId, 'batch_results.batch_id FK→batches.id intact');

  // ─── 3. Drive updateBatchOnFinish — closes the batch row ─────────────
  console.log('[3] updateBatchOnFinish — closes batch with counters');
  const finishedAt = Date.now() + 500;
  updateBatchOnFinish(batchId, {
    finished_at: finishedAt,
    passed: 2,
    failed: 1,
  }, 'real');

  const closedRow = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  ok(closedRow.finished_at === finishedAt, 'batches.finished_at populated');
  ok(closedRow.passed === 2, 'batches.passed=2');
  ok(closedRow.failed === 1, 'batches.failed=1');
  ok(closedRow.snapshot_size === 3, 'batches.snapshot_size unchanged');

  // The prod-DB cross-check that used to live here (Part 4) has moved to
  // scripts/verify-prod-db.mjs — it asserted facts about whatever audit.db was
  // on disk (distinct_nodes > 100, etc.), so it could only pass on a populated
  // production DB and failed on dev/CI/fresh clones. That is an operational
  // health check, not a regression test; this file stays hermetic.

  console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed`);
  if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
  console.log('='.repeat(60));
  process.exit(out.fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
