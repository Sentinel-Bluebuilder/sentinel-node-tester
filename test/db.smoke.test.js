/**
 * Sentinel Node Tester — DB Smoke Tests
 * Tests the SQLite persistence layer against an in-memory database.
 *
 * Run: node test/db.smoke.test.js
 * Exit 0 = all pass, exit 1 = failures.
 */

import { getDb, useDb, insertRun, updateRunOnFinish, insertResult, insertResultsBatch,
  getRun, findRunByKey, listRuns, getLatestResultPerNode,
  getNodeHistory, getNetworkStats, insertErrorLog, getNodeErrors, closeDb } from '../core/db.js';

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
