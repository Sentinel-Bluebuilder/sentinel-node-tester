#!/usr/bin/env node
/**
 * verify-prod-db.mjs — Operational health check for the live audit.db
 *
 * This is NOT a regression test. It is an on-demand operational audit the
 * operator runs against their real instrument to confirm the live
 * continuous-loop write path has populated production data sanely:
 *
 *   - finished batches exist with finished_at > started_at
 *   - the most recent batch has passed+failed > 0 and batch_results rows
 *   - the corpus covers a meaningful number of distinct nodes (>100)
 *   - failure rows carry error codes (proves the failure-log path works)
 *   - batch mode distribution looks reasonable
 *
 * It was extracted from test/continuous.live-db-write.test.js (Part 4). That
 * cross-check asserts facts about whatever audit.db is on disk, so it can only
 * pass on a genuinely-populated production DB — it FAILED on dev boxes / CI /
 * fresh clones with a sparse fixture DB, masking real regressions. Automated
 * suites must be deterministic and environment-independent; an "is my live DB
 * healthy" question is an ops check, so it lives here instead.
 *
 * The hermetic write-path test (Parts 1-3) stays in test/continuous.live-db-write.test.js
 * and runs in `npm run test:integration`.
 *
 * Run:  node scripts/verify-prod-db.mjs
 * Exit: 0 = all health checks passed (or prod DB absent → SKIP)
 *       1 = prod DB present but one or more health checks failed
 *
 * DB-lock note (per CLAUDE.md): opens audit.db read-only and closes it in a
 * finally block. Don't run this in parallel with a starting server.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROD_DB = path.join(__dirname, '..', 'data', 'audit.db');

const out = { pass: 0, fail: 0, errors: [] };
function ok(cond, name) {
  if (cond) { out.pass++; console.log(`  PASS  ${name}`); }
  else      { out.fail++; out.errors.push(name); console.log(`  FAIL  ${name}`); }
}

function main() {
  console.log(`Production DB health check — ${PROD_DB}`);

  if (!existsSync(PROD_DB)) {
    console.log('  SKIP  prod audit.db not present — nothing to verify.');
    console.log(`\n${'='.repeat(60)}\nRESULTS: SKIPPED (no prod DB)\n${'='.repeat(60)}`);
    process.exit(0);
  }

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

  console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed`);
  if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
  console.log('='.repeat(60));
  process.exit(out.fail ? 1 : 0);
}

main();
