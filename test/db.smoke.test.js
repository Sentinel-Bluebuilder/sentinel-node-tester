/**
 * Sentinel Node Tester — DB Smoke Tests
 * Tests the SQLite persistence layer against an in-memory database.
 *
 * Run: node test/db.smoke.test.js
 * Exit 0 = all pass, exit 1 = failures.
 */

import path from 'path';
import { existsSync } from 'fs';
import { getDb, useDb, insertRun, updateRunOnFinish, insertResult, insertResultsBatch,
  getRun, findRunByKey, listRuns, getLatestResultPerNode,
  getNodeHistory, getNetworkStats, insertErrorLog, getNodeErrors, closeDb,
  insertBatch, insertBatchResult, updateBatchOnFinish, getBatchResults,
  getActiveBatch, getLastBatch, pruneBatchResults } from '../core/db.js';
import { RAW_DIR } from '../core/constants.js';

// ─── Use a fresh in-memory DB for this test run ───────────────────────────────
// `useDb` sets the module singleton so all exported helpers target this handle.
const db = getDb(':memory:');
useDb(db);

// ─── Test Harness ─────────────────────────────────────────────────────────────

const testResults = { pass: 0, fail: 0, errors: [] };

function assert(condition, name) {
  if (condition) {
    testResults.pass++;
  } else {
    testResults.fail++;
    testResults.errors.push(name);
    console.error(`  FAIL: ${name}`);
  }
}

function eq(a, b, name) {
  const ok = a === b;
  if (!ok) console.error(`  FAIL ${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  assert(ok, name);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();

const SAMPLE_PASS = {
  timestamp:            new Date(NOW - 60_000).toISOString(),
  address:              'sentnode1aaa111',
  type:                 'V2Ray',
  moniker:              'TestNode Alpha',
  country:              'Germany',
  city:                 'Frankfurt',
  reportedDownloadMbps: 100,
  actualMbps:           42.5,
  pass10mbps:           true,
  error:                null,
  diag:                 { latencyMs: 34, handshakeOk: true },
};

const SAMPLE_FAIL = {
  timestamp:            new Date(NOW - 30_000).toISOString(),
  address:              'sentnode1bbb222',
  type:                 'WireGuard',
  moniker:              'TestNode Beta',
  country:              'Japan',
  city:                 'Tokyo',
  reportedDownloadMbps: 50,
  actualMbps:           null,
  pass10mbps:           false,
  error:                'HANDSHAKE_TIMEOUT: timed out after 45s',
  diag:                 {},
};

const SAMPLE_PASS2 = {
  timestamp:            new Date(NOW - 10_000).toISOString(),
  address:              'sentnode1ccc333',
  type:                 'V2Ray',
  moniker:              'TestNode Gamma',
  country:              'United States',
  city:                 'New York',
  reportedDownloadMbps: 200,
  actualMbps:           88.1,
  pass10mbps:           true,
  error:                null,
  diag:                 { latencyMs: 12, handshakeOk: true },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('DB Smoke Tests\n');

// 1. Insert run
console.log('1. insertRun...');
const runId = insertRun({
  started_at:     NOW - 120_000,
  mode:           'p2p',
  wallet_address: 'sent1testwalletaddress',
  notes:          'smoke test run',
});
assert(typeof runId === 'number' || typeof runId === 'bigint', 'insertRun returns id');
assert(Number(runId) > 0, 'insertRun id > 0');
console.log(`  run_id = ${runId}`);

// 2. getRun
console.log('2. getRun...');
const run = getRun(Number(runId));
assert(run != null, 'getRun finds run');
eq(run.mode, 'p2p', 'run.mode');
eq(run.notes, 'smoke test run', 'run.notes');
assert(run.finished_at == null, 'run.finished_at null before finish');

// 3. Insert 3 results
console.log('3. insertResult (3 nodes)...');
const r1id = insertResult(Number(runId), SAMPLE_PASS);
const r2id = insertResult(Number(runId), SAMPLE_FAIL);
const r3id = insertResult(Number(runId), SAMPLE_PASS2);
assert(Number(r1id) > 0, 'result 1 inserted');
assert(Number(r2id) > 0, 'result 2 inserted');
assert(Number(r3id) > 0, 'result 3 inserted');

// 4. updateRunOnFinish
console.log('4. updateRunOnFinish...');
updateRunOnFinish(Number(runId), { finished_at: NOW, node_count: 3, pass_count: 2 });
const runAfter = getRun(Number(runId));
eq(runAfter.node_count, 3, 'run.node_count');
eq(runAfter.pass_count, 2, 'run.pass_count');
assert(runAfter.finished_at === NOW, 'run.finished_at set');

// 5. getLatestResultPerNode — all
console.log('5. getLatestResultPerNode...');
const latest = getLatestResultPerNode();
eq(latest.length, 3, 'latest-per-node: 3 distinct nodes');

// With country filter
const deNodes = getLatestResultPerNode({ country: 'Germany' });
eq(deNodes.length, 1, 'Germany filter: 1 node');
eq(deNodes[0].moniker, 'TestNode Alpha', 'Germany node moniker');

// With q filter
const alphaNodes = getLatestResultPerNode({ q: 'Alpha' });
eq(alphaNodes.length, 1, 'q=Alpha: 1 result');

// 6. getNodeHistory
console.log('6. getNodeHistory...');
const history = getNodeHistory('sentnode1aaa111');
eq(history.length, 1, 'node history: 1 entry');
eq(history[0].actual_mbps, SAMPLE_PASS.actualMbps, 'history actual_mbps');

// 7. getNetworkStats
console.log('7. getNetworkStats...');
const stats = getNetworkStats();
eq(stats.totalNodes, 3, 'stats.totalNodes = 3');
assert(stats.passingPct > 0, 'stats.passingPct > 0');
assert(stats.medianMbps != null, 'stats.medianMbps set');
assert(typeof stats.lastRunAt === 'number', 'stats.lastRunAt is number');
console.log(`  totalNodes=${stats.totalNodes} passingPct=${stats.passingPct}% medianMbps=${stats.medianMbps}`);

// 8. listRuns
console.log('8. listRuns...');
const runs = listRuns({ limit: 10 });
assert(runs.length >= 1, 'listRuns returns entries');
eq(runs[0].id, Number(runId), 'listRuns first entry is our run');

// 9. findRunByKey (idempotency check)
console.log('9. findRunByKey...');
const found = findRunByKey(NOW - 120_000, 'p2p');
assert(found != null, 'findRunByKey finds existing run');
eq(found.id, Number(runId), 'findRunByKey correct id');

const notFound = findRunByKey(NOW - 999_999, 'p2p');
assert(notFound == null, 'findRunByKey returns null for unknown key');

// 10. insertResultsBatch (in-transaction)
console.log('10. insertResultsBatch...');
const runId2 = insertRun({ started_at: NOW - 50_000, mode: 'subscription', plan_id: '42' });
insertResultsBatch(Number(runId2), [SAMPLE_PASS, SAMPLE_FAIL, SAMPLE_PASS2]);
const latestAfterBatch = getLatestResultPerNode({ limit: 100 });
// Still 3 unique node addresses — batch updated them with newer timestamps
eq(latestAfterBatch.length, 3, 'latest-per-node still 3 after batch insert (same addrs)');

// 11. raw_json round-trip
console.log('11. raw_json round-trip...');
const history2 = getNodeHistory('sentnode1aaa111', { limit: 10 });
assert(history2.length >= 1, 'node has history');
const parsed = JSON.parse(history2[0].raw_json);
eq(parsed.address, 'sentnode1aaa111', 'raw_json.address preserved');
eq(parsed.moniker, 'TestNode Alpha', 'raw_json.moniker preserved');

// 12. schema_version is up to date (latest forward migration applied)
console.log('12. schema_version...');
const schemaRow = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
eq(schemaRow.version, 11, 'freshly-opened DB reports schema_version 11');

// 13. error_logs.log_snippet is capped at 16 KB (16384 chars)
console.log('13. error_logs log_snippet cap...');
// Insert a fresh failed result so we have a result_id, then attach an
// oversized log snippet. insertErrorLog must clamp it to the 16 KB backstop.
const capRunId = insertRun({ started_at: NOW - 5_000, mode: 'p2p' });
const capResultId = Number(insertResult(Number(capRunId), { ...SAMPLE_FAIL, address: 'sentnode1cap999' }));
insertErrorLog({
  result_id: capResultId,
  stage: 'handshake',
  error_code: 'HANDSHAKE_TIMEOUT',
  error_message: 'oversized snippet stress',
  log_snippet: 'x'.repeat(50000),
});
const capErrors = getNodeErrors('sentnode1cap999', { limit: 1 });
assert(capErrors.length >= 1, 'getNodeErrors returns the inserted error log');
assert(
  capErrors[0].log_snippet != null && capErrors[0].log_snippet.length <= 16384,
  `log_snippet capped at <= 16384 chars (got ${capErrors[0].log_snippet?.length})`,
);

// 14. pruneBatchResults — keep active + last-finished + last K batches
console.log('14. pruneBatchResults retention...');
// Build 6 batches with staggered started_at so recency is unambiguous.
// b1..b5 are finished (oldest→newest); b6 is left ACTIVE (finished_at NULL)
// but with the OLDEST started_at so it would fall outside a recency window —
// proving the active-batch keep is independent of the last-K window.
const KEEP = 3;
const batchIds = [];
for (let i = 0; i < 6; i++) {
  const bid = Number(insertBatch({
    started_at:    NOW + i * 1000, // b1 oldest .. b6 newest
    snapshot_size: 1,
    mode:          'p2p',
  }));
  batchIds.push(bid);
  // One node result per batch, distinct address so we can verify survival.
  insertBatchResult(bid, {
    address:    `sentnode1batch${i}`,
    actualMbps: 10 + i,
    testedAt:   NOW + i * 1000,
  });
}
const [b1, b2, b3, b4, b5, b6] = batchIds;
// Finish b1..b5 (oldest→newest by finished_at). Leave b6 ACTIVE.
[b1, b2, b3, b4, b5].forEach((bid, idx) => {
  updateBatchOnFinish(bid, { finished_at: NOW + 10_000 + idx * 1000, passed: 1, failed: 0 });
});
// Make b6 ACTIVE but the OLDEST by started_at so it's outside the last-K window.
db.prepare('UPDATE batches SET started_at = @ts, finished_at = NULL WHERE id = @id')
  .run({ ts: NOW - 100_000, id: b6 });

// Sanity: active = b6, last-finished = b5 (latest finished_at).
eq(getActiveBatch().batch.id, b6, 'active batch is b6 (finished_at NULL)');
eq(getLastBatch().batch.id, b5, 'last-finished batch is b5');

const summary = pruneBatchResults({ keepBatches: KEEP });
// keep-set: last-K by started_at (b5,b4,b3) ∪ active(b6) ∪ last-finished(b5) = {b3,b4,b5,b6}
eq(summary.keptBatches, 4, 'keep-set size = last-K(3) ∪ active ∪ last-finished = 4');

// (a) active batch rows survive
eq(getBatchResults(b6).results.length, 1, 'active batch (b6) rows survive');
// (b) most-recent finished batch rows survive
eq(getBatchResults(b5).results.length, 1, 'last-finished batch (b5) rows survive');
// (c) batches inside the last-K window survive
eq(getBatchResults(b4).results.length, 1, 'recent batch (b4) rows survive');
eq(getBatchResults(b3).results.length, 1, 'recent batch (b3) rows survive');
// (d) old batches outside the keep-set are gone (rows AND parent batch row)
eq(getBatchResults(b2).results.length, 0, 'old batch (b2) rows pruned');
eq(getBatchResults(b1).results.length, 0, 'old batch (b1) rows pruned');
assert(getBatchResults(b1).batch == null, 'old batch (b1) parent row deleted');
assert(getBatchResults(b2).batch == null, 'old batch (b2) parent row deleted');
// Two batches deleted (b1, b2), each with one batch_results row.
eq(summary.deletedBatches, 2, 'deletedBatches = 2 (b1, b2)');
eq(summary.deletedBatchResults, 2, 'deletedBatchResults = 2');
// FK integrity intact after prune.
assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'foreign_key_check clean after prune');
// Active batch never deleted as a parent even if outside window — already
// asserted via b6 survival above.

// 15. in-memory DB keeps raw_json INLINE in the column and writes NO file.
//     Regression guard: the per-run file offload (results/raw/run-<id>/<id>.json)
//     uses a FIXED RAW_DIR independent of the active handle. An in-memory test
//     DB must NOT write there (cross-DB blob collision / prod pollution). The
//     fix binds raw_json inline for :memory: and skips the file entirely.
console.log('15. in-memory raw_json stays inline (no file)...');
{
  const memRunId = Number(insertRun({ started_at: NOW - 3_000, mode: 'p2p' }));
  const memResId = Number(insertResult(memRunId, { ...SAMPLE_PASS, address: 'sentnode1mem999' }));
  assert(memResId > 0, 'in-memory insertResult returns id');
  // Column populated (readers return it as-is; no rehydrate-from-file needed).
  const memHist = getNodeHistory('sentnode1mem999', { limit: 1 });
  assert(memHist.length === 1, 'in-memory node history has 1 row');
  assert(memHist[0].raw_json != null, 'in-memory raw_json column is populated (not NULL)');
  const memParsed = JSON.parse(memHist[0].raw_json);
  eq(memParsed.address, 'sentnode1mem999', 'in-memory raw_json round-trips via the column');
  // No file written for this (run_id, result_id) under RAW_DIR.
  const rawFile = path.join(RAW_DIR, `run-${memRunId}`, `${memResId}.json`);
  assert(!existsSync(rawFile), `in-memory insert wrote NO file (${rawFile})`);
  // And the RAW_DIR root itself was not created by any :memory: insert so far.
  assert(!existsSync(RAW_DIR), `RAW_DIR not created by :memory: tests (${RAW_DIR})`);
}

// 16. pruneBatchResults — keeps ALL unfinished batches, not just the newest.
//     Regression guard for FIX 3: if two+ batches have finished_at IS NULL, the
//     child DELETE must not strip the older unfinished batch's batch_results
//     (which would orphan its parent row, since the parent DELETE guards
//     finished_at IS NOT NULL). Build TWO unfinished batches + older finished
//     ones and assert BOTH unfinished survive while old finished are pruned.
console.log('16. pruneBatchResults keeps ALL unfinished batches...');
{
  // Fresh isolated in-memory DB so prior batches above don't perturb the keep-set.
  const pdb = getDb(':memory:');
  useDb(pdb);
  const T = Date.now();
  const mk = (startedAt, addr) => {
    const bid = Number(insertBatch({ started_at: startedAt, snapshot_size: 1, mode: 'p2p' }));
    insertBatchResult(bid, { address: addr, actualMbps: 12, testedAt: startedAt });
    return bid;
  };
  // Two UNFINISHED batches (finished_at NULL), both OLD by started_at so they
  // fall outside the last-K recency window — proving they survive purely on the
  // "all unfinished" rule, not recency.
  const u1 = mk(T - 100_000, 'sentnode1unfin1'); // older unfinished
  const u2 = mk(T - 90_000, 'sentnode1unfin2');  // newer unfinished
  // Older FINISHED batches that should be pruned out under a tight keepBatches.
  const f1 = mk(T - 80_000, 'sentnode1fin1');
  const f2 = mk(T - 70_000, 'sentnode1fin2');
  const f3 = mk(T - 60_000, 'sentnode1fin3');
  [f1, f2, f3].forEach((bid, idx) => updateBatchOnFinish(bid, { finished_at: T - 50_000 + idx * 1000, passed: 1, failed: 0 }));

  // keepBatches=1: last-K window holds only the newest-by-started_at (f3). The
  // "all unfinished" rule must still rescue BOTH u1 and u2.
  const psum = pruneBatchResults({ keepBatches: 1 });

  // BOTH unfinished batches' results + parent rows survive.
  eq(getBatchResults(u1).results.length, 1, 'older unfinished batch (u1) rows survive prune');
  assert(getBatchResults(u1).batch != null, 'older unfinished batch (u1) parent row survives');
  eq(getBatchResults(u2).results.length, 1, 'newer unfinished batch (u2) rows survive prune');
  assert(getBatchResults(u2).batch != null, 'newer unfinished batch (u2) parent row survives');
  // Old finished batches outside the keep-set are pruned (rows + parent).
  eq(getBatchResults(f1).results.length, 0, 'old finished batch (f1) rows pruned');
  assert(getBatchResults(f1).batch == null, 'old finished batch (f1) parent row deleted');
  eq(getBatchResults(f2).results.length, 0, 'old finished batch (f2) rows pruned');
  // No orphaned batch_results: every surviving child has a surviving parent.
  assert(pdb.prepare('PRAGMA foreign_key_check').all().length === 0, 'foreign_key_check clean after multi-unfinished prune');
  const orphans = pdb.prepare(
    'SELECT COUNT(*) AS c FROM batch_results br WHERE NOT EXISTS (SELECT 1 FROM batches b WHERE b.id = br.batch_id)',
  ).get().c;
  eq(orphans, 0, 'no orphaned batch_results rows after prune');
  assert(psum.keptBatches >= 3, `keep-set includes both unfinished + last-K (got ${psum.keptBatches})`);

  pdb.close();
  // Restore the original module singleton for any later code/cleanup.
  useDb(db);
}

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${testResults.pass} passed, ${testResults.fail} failed (${testResults.pass + testResults.fail} total)`);
if (testResults.errors.length > 0) {
  console.log('\nFAILURES:');
  for (const e of testResults.errors) console.log(`  FAIL: ${e}`);
}
console.log(`${'='.repeat(50)}`);

closeDb();
process.exit(testResults.fail > 0 ? 1 : 0);
