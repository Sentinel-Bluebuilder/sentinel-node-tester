/**
 * Verification script for db.js extensions (searchNodes, error_logs, etc.)
 * Run: node scripts/verify-db-extensions.mjs
 */
import { performance } from 'perf_hooks';
import {
  getDb,
  searchNodes,
  getNodeDetail,
  getNodeErrors,
  getCountryList,
  insertErrorLog,
} from '../core/db.js';

const db = getDb();

// ─── Row Counts ─────────────────────────────────────────────────────────────
const runsCount    = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
const resultsCount = db.prepare('SELECT COUNT(*) AS n FROM results').get().n;
let errorLogsCount = 0;
try {
  errorLogsCount = db.prepare('SELECT COUNT(*) AS n FROM error_logs').get().n;
} catch {
  console.log('error_logs table not yet created (will be created on next getDb() call)');
}

console.log('\n=== Row Counts ===');
console.log(`runs:       ${runsCount}`);
console.log(`results:    ${resultsCount}`);
console.log(`error_logs: ${errorLogsCount}`);

// ─── Schema check ────────────────────────────────────────────────────────────
const resultCols = db.prepare('PRAGMA table_info(results)').all().map(c => c.name);
console.log('\n=== results columns ===');
console.log(resultCols.join(', '));
const hasPass  = resultCols.includes('pass');
const hasStage = resultCols.includes('stage');
console.log(`pass column:  ${hasPass  ? 'YES' : 'MISSING'}`);
console.log(`stage column: ${hasStage ? 'YES' : 'MISSING'}`);

// ─── searchNodes test ────────────────────────────────────────────────────────
console.log('\n=== searchNodes({ window: 25, limit: 5 }) ===');
const t0 = performance.now();
const nodes = searchNodes({ window: 25, limit: 5 });
const t1 = performance.now();
console.log(`Query time: ${(t1 - t0).toFixed(1)}ms | Returned: ${nodes.length} nodes`);

if (nodes.length > 0) {
  const n = nodes[0];
  console.log('\nFirst node:');
  console.log(`  node_addr:        ${n.node_addr}`);
  console.log(`  moniker:          ${n.moniker}`);
  console.log(`  country:          ${n.country}`);
  console.log(`  service_type:     ${n.service_type}`);
  console.log(`  latest_mbps:      ${n.latest_mbps}`);
  console.log(`  latest_tested_at: ${n.latest_tested_at}`);
  console.log(`  pass_count:       ${n.pass_count}`);
  console.log(`  total_tests:      ${n.total_tests}`);
  console.log(`  pass_rate:        ${n.pass_rate}`);
  console.log(`  pass_bar length:  ${n.pass_bar?.length} (expected 25)`);
  console.log(`  pass_bar:         [${n.pass_bar?.join(',')}]`);

  const barOk = n.pass_bar && n.pass_bar.length === 25;
  console.log(`\npass_bar length check: ${barOk ? 'PASS' : 'FAIL (expected 25)'}`);
}

// ─── getCountryList test ─────────────────────────────────────────────────────
console.log('\n=== getCountryList() (top 5) ===');
const countries = getCountryList();
console.log(`Total countries: ${countries.length}`);
countries.slice(0, 5).forEach(c => {
  console.log(`  ${c.country}: ${c.node_count} nodes`);
});

// ─── getNodeDetail test ──────────────────────────────────────────────────────
if (nodes.length > 0) {
  console.log('\n=== getNodeDetail() ===');
  const detail = getNodeDetail(nodes[0].node_addr, { historyLimit: 10 });
  console.log(`node:    ${detail.node ? 'present' : 'null'}`);
  console.log(`history: ${detail.history.length} rows`);
  console.log(`errors:  ${detail.errors.length} rows`);
}

// ─── error_logs insert test ─────────────────────────────────────────────────
console.log('\n=== error_logs insert test ===');
try {
  // Get any existing result to use as FK
  const anyResult = db.prepare('SELECT id FROM results LIMIT 1').get();
  if (anyResult) {
    const newId = insertErrorLog({
      result_id:     anyResult.id,
      stage:         'handshake',
      error_code:    'TEST_CODE',
      error_message: 'verify-db-extensions: test row',
      log_snippet:   null,
    });
    console.log(`Inserted test error_log row id=${newId}`);
    // Clean up
    db.prepare('DELETE FROM error_logs WHERE id = ?').run(newId);
    console.log('Cleaned up test row. error_logs insert/delete: PASS');
  } else {
    console.log('No results rows — skipping error_logs insert test');
  }
} catch (err) {
  console.log(`error_logs insert FAILED: ${err.message}`);
}

console.log('\n=== Verification complete ===\n');
