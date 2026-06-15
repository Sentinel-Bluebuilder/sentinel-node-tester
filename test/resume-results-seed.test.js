/**
 * Resume — In-Memory Results Restoration (root-cause regression test)
 *
 * Bug: on resume, the continuous loop called pipeline.runAudit(resume=false),
 * which wipes the in-memory `results` array (pipeline.js: `results.length = 0`)
 * and sets totalNodes to the *remainder* only. Since /live's snapshot mirrors
 * getResults(), an already-tested batch vanished from /live on resume — logs
 * kept streaming but the node table went empty. Admin (DB-backed) stayed
 * complete, so the two desynced.
 *
 * Fix: continuous resume now (a) threads resume=true so the pipeline preserves
 * the results array + computes totalNodes = already-tested + remaining, and
 * (b) for the cross-process case (server restart → empty array) re-seeds the
 * in-memory results from the persisted batch_results via pipeline.seedResults().
 *
 * This test covers the seed primitive + dedup semantics directly (no chain/
 * wallet needed) and proves a DB-backed restore round-trips into getResults().
 *
 * Run: node test/resume-results-seed.test.js
 */

import Database from 'better-sqlite3';

const out = { pass: 0, fail: 0, errors: [] };
function ok(cond, name) {
  if (cond) { out.pass++; console.log(`  PASS  ${name}`); }
  else      { out.fail++; out.errors.push(name); console.log(`  FAIL  ${name}`); }
}

async function main() {
  process.env.NODE_ENV = 'test';

  console.log('\nResume — In-Memory Results Restoration\n');

  // ─── 1. pipeline.seedResults — append + dedup by address ──────────────
  console.log('[1] pipeline.seedResults appends and dedups by address');
  const pipeline = await import('../audit/pipeline.js');
  // Start from a clean in-memory results array.
  pipeline.getResults().length = 0;

  const added1 = pipeline.seedResults([
    { address: 'sentnode1aaa', actualMbps: 12.5, errorCode: null },
    { address: 'sentnode1bbb', actualMbps: null, errorCode: 'HANDSHAKE_FAIL' },
  ]);
  ok(added1 === 2, `first seed appends 2 (got ${added1})`);
  ok(pipeline.getResults().length === 2, `getResults() has 2 rows (got ${pipeline.getResults().length})`);

  // Re-seeding the same address must NOT duplicate — it replaces in place.
  const added2 = pipeline.seedResults([
    { address: 'sentnode1aaa', actualMbps: 99.9, errorCode: null },
    { address: 'sentnode1ccc', actualMbps: 5.0, errorCode: null },
  ]);
  ok(added2 === 1, `second seed appends only the new address (got ${added2})`);
  ok(pipeline.getResults().length === 3, `getResults() has 3 distinct rows (got ${pipeline.getResults().length})`);
  const aaa = pipeline.getResults().find(r => r.address === 'sentnode1aaa');
  ok(aaa && aaa.actualMbps === 99.9, `re-seeded address is replaced, not duplicated (mbps=${aaa?.actualMbps})`);

  // Guards: non-array → 0, rows without address skipped.
  ok(pipeline.seedResults(null) === 0, 'seedResults(null) → 0');
  ok(pipeline.seedResults([{ moniker: 'no-addr' }]) === 0, 'rows without address are skipped');
  ok(pipeline.getResults().length === 3, 'guarded calls do not grow the array');

  // ─── 2. DB round-trip: batch_results → getBatchResults → seedResults ──
  console.log('[2] persisted batch_results restore into getResults()');
  const { useDb, getDb, insertBatch, insertBatchResult, getBatchResults } =
    await import('../core/db.js');
  useDb(getDb(':memory:'));

  const batchId = insertBatch({
    started_at: Date.now(),
    snapshot_size: 3,
    mode: 'p2p',
    snapshot_addresses: ['sentnode1xxx', 'sentnode1yyy', 'sentnode1zzz'],
  }, 'real');
  ok(batchId > 0, `insertBatch returned id (got ${batchId})`);

  // Two nodes already tested before the (simulated) restart.
  insertBatchResult(batchId, {
    address: 'sentnode1xxx', type: 'wireguard', moniker: 'Alpha',
    country: 'US', countryCode: 'US', city: 'NYC',
    actualMbps: 22.4, peers: 3, maxPeers: 10,
    error: null, errorCode: null, baselineMbps: 18.0, testedAt: Date.now(),
  }, 'real');
  insertBatchResult(batchId, {
    address: 'sentnode1yyy', type: 'v2ray', moniker: 'Bravo',
    country: 'DE', countryCode: 'DE', city: 'Berlin',
    actualMbps: null, peers: null, maxPeers: null,
    error: 'tunnel timeout', errorCode: 'TUNNEL_TIMEOUT', baselineMbps: 18.0, testedAt: Date.now(),
  }, 'real');

  const { results: rows } = getBatchResults(batchId, { limit: 1000 }, 'real');
  ok(rows.length === 2, `getBatchResults returns the 2 persisted rows (got ${rows.length})`);

  // Map snake_case DB rows → result shape (mirrors continuous._batchRowToResult)
  const mapped = rows.map(row => ({
    address:        row.node_address,
    moniker:        row.moniker || '',
    country:        row.country || '',
    countryCode:    row.country_code || '',
    city:           row.city || '',
    type:           row.type || null,
    actualMbps:     row.actual_mbps,
    baselineAtTest: row.baseline_mbps,
    peers:          row.peers,
    maxPeers:       row.max_peers,
    error:          row.error || null,
    errorCode:      row.error_code || null,
    skipped:        row.error_code === 'TEST_RUN_SKIP',
    testedAt:       row.tested_at,
  }));

  // Fresh in-memory array (simulates the empty array after a server restart).
  pipeline.getResults().length = 0;
  const restored = pipeline.seedResults(mapped);
  ok(restored === 2, `restored 2 already-tested nodes into getResults() (got ${restored})`);

  const res = pipeline.getResults();
  const xxx = res.find(r => r.address === 'sentnode1xxx');
  const yyy = res.find(r => r.address === 'sentnode1yyy');
  ok(xxx && xxx.actualMbps === 22.4 && xxx.type === 'wireguard',
     'restored passing node carries mbps + transport');
  ok(yyy && yyy.errorCode === 'TUNNEL_TIMEOUT' && yyy.actualMbps == null,
     'restored failed node carries error code + null mbps');

  // Cleanup so we don't leak rows into any later in-process consumer.
  pipeline.getResults().length = 0;

  console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
  if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
  console.log('='.repeat(60));
  process.exit(out.fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
