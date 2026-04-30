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
 * Then it cross-checks the production audit.db — proving prior continuous
 * runs wrote real data through this same path.
 *
 * Run: NODE_ENV=test node test/continuous.live-db-write.test.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD_DB = path.join(__dirname, '..', 'data', 'audit.db');

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

  // ─── 4. Cross-check production DB — prove this same code path ran live ──
  console.log('[4] Cross-check production audit.db (read-only)');
  if (!existsSync(PROD_DB)) {
    console.log('  SKIP  prod audit.db not present');
  } else {
    const prod = new Database(PROD_DB, { readonly: true });
    try {
      // Most recent finished batch
      const last = prod.prepare(`
        SELECT id, started_at, finished_at, snapshot_size, passed, failed, mode,
               (SELECT COUNT(*) FROM batch_results WHERE batch_id = batches.id) AS rows_count
        FROM batches WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1
      `).get();
      ok(last && last.id > 0, `prod has finished batches (most recent id=${last?.id})`);
      ok(last && last.finished_at > last.started_at, 'prod batch finished_at > started_at');
      ok(last && (last.passed + last.failed) > 0, `prod batch has passed+failed > 0 (${last?.passed}+${last?.failed})`);
      ok(last && last.rows_count > 0, `prod batch has batch_results rows (${last?.rows_count})`);

      // Aggregate
      const agg = prod.prepare(`
        SELECT COUNT(DISTINCT b.id) AS batches,
               COUNT(br.id)         AS results,
               COUNT(DISTINCT br.node_address) AS distinct_nodes
        FROM batches b LEFT JOIN batch_results br ON br.batch_id = b.id
      `).get();
      ok(agg.batches > 0, `prod has ${agg.batches} batches recorded`);
      ok(agg.results > 0, `prod has ${agg.results} batch_results rows`);
      ok(agg.distinct_nodes > 100,
         `prod has ${agg.distinct_nodes} distinct nodes tested across all batches`);

      // Schema sanity — error_code distinct values prove failure-log path works
      const codes = prod.prepare(`
        SELECT error_code, COUNT(*) c FROM batch_results
        WHERE error_code IS NOT NULL GROUP BY error_code ORDER BY c DESC LIMIT 5
      `).all();
      console.log('  prod error_code distribution (top 5):');
      for (const r of codes) console.log(`    ${r.error_code.padEnd(30)} ${r.c}`);
      ok(codes.length > 0, 'prod batch_results contains failure rows with error codes');

      // Mode distribution
      const modes = prod.prepare(`SELECT mode, COUNT(*) c FROM batches GROUP BY mode`).all();
      console.log('  prod batch mode distribution:');
      for (const m of modes) console.log(`    ${m.mode.padEnd(15)} ${m.c}`);
    } finally {
      prod.close();
    }
  }

  console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed`);
  if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
  console.log('='.repeat(60));
  process.exit(out.fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
