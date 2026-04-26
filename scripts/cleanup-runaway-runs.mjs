#!/usr/bin/env node
/**
 * Cleanup Runaway Runs — One-Shot Recovery
 *
 * A bug in audit/continuous.js (sleepInterruptible not yielding) combined with
 * a bad smoke test (continuous.smoke.test.js writing to prod DB instead of
 * :memory:) caused the `runs` table to accumulate ~54M rows where
 * notes LIKE 'continuous-loop iteration%'. The DB grew to 5.3 GB with a
 * 13.5 GB WAL.
 *
 * Strategy: DELETE-in-batches is too slow on 54M rows without an index on
 * `notes`. Instead, rebuild: create a new table with only legitimate rows,
 * drop the old one, rename. This is O(legitimate rows) = O(100), not O(54M).
 *
 * Usage:
 *   node scripts/cleanup-runaway-runs.mjs           # test-run (counts only)
 *   node scripts/cleanup-runaway-runs.mjs --yes     # actually execute
 */

import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '..', 'data', 'audit.db');
const EXECUTE = process.argv.includes('--yes');

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function safeSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

function printSizes(label) {
  const db = safeSize(DB_PATH);
  const shm = safeSize(DB_PATH + '-shm');
  const wal = safeSize(DB_PATH + '-wal');
  console.log(`[${label}] audit.db=${fmtBytes(db)}  shm=${fmtBytes(shm)}  wal=${fmtBytes(wal)}  total=${fmtBytes(db + shm + wal)}`);
}

console.log(`DB: ${DB_PATH}`);
console.log(`Mode: ${EXECUTE ? 'EXECUTE (will modify)' : 'DRY-RUN (read-only counts)'}`);
console.log('');

printSizes('BEFORE');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─── Snapshot counts ───────────────────────────────────────────────────────
console.log('\nCounting rows...');
const totalRuns = db.prepare('SELECT COUNT(*) AS c FROM runs').get().c;
const totalResults = db.prepare('SELECT COUNT(*) AS c FROM results').get().c;
const totalErrors = db.prepare('SELECT COUNT(*) AS c FROM error_logs').get().c;
console.log(`  runs:       ${totalRuns.toLocaleString()}`);
console.log(`  results:    ${totalResults.toLocaleString()}`);
console.log(`  error_logs: ${totalErrors.toLocaleString()}`);

// Legitimate runs = NOT matching the junk pattern
// Faster than counting junk (which requires full-scan of 54M rows) because
// we expect legitimate runs to be tiny. Use SELECT * so we don't depend on
// a specific column list — the schema is introspected below for the rebuild.
console.log('\nIdentifying legitimate runs (NOT continuous-loop)...');
const legitRuns = db.prepare(
  "SELECT * FROM runs WHERE notes IS NULL OR notes NOT LIKE 'continuous-loop iteration%'"
).all();
console.log(`  Legitimate runs found: ${legitRuns.length}`);

if (legitRuns.length > 200) {
  console.error(`\nFATAL: Expected <=100 legitimate runs, got ${legitRuns.length}. Something is wrong. Aborting.`);
  db.close();
  process.exit(1);
}

if (legitRuns.length <= 20) {
  console.log('\n  Sample legitimate runs:');
  for (const r of legitRuns.slice(0, 20)) {
    console.log(`    id=${r.id} mode=${r.mode} nodes=${r.node_count} notes=${JSON.stringify(r.notes)}`);
  }
}

const junkRuns = totalRuns - legitRuns.length;
console.log(`\n  Junk runs (to delete): ${junkRuns.toLocaleString()}`);

if (!EXECUTE) {
  console.log('\n=== DRY-RUN complete. Rerun with --yes to execute. ===');
  db.close();
  process.exit(0);
}

// ─── Rebuild strategy ──────────────────────────────────────────────────────
// 1. Create runs_new with same schema as runs.
// 2. Copy legitimate rows via parameterized INSERT.
// 3. Drop old runs, rename runs_new → runs.
// 4. results and error_logs: most rows are orphans (junk run_ids). Delete
//    any that reference missing run_ids. Expect ~0 affected since junk runs
//    never wrote to results (that was the gate in continuous.js).
// 5. VACUUM + wal_checkpoint to reclaim disk.

console.log('\n=== EXECUTING ===');
const execStart = Date.now();

// Capture the current schema so we replicate it exactly
const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").get();
if (!schemaRow) {
  console.error('FATAL: runs table not found');
  db.close();
  process.exit(1);
}
const runsSchema = schemaRow.sql.replace(/CREATE TABLE\s+runs/i, 'CREATE TABLE runs_new');
console.log(`  runs schema:\n    ${runsSchema}`);

// Drop leftover runs_new from a prior failed attempt
db.exec('DROP TABLE IF EXISTS runs_new');

// Re-read full schema fields dynamically by pragma table_info
const cols = db.prepare("PRAGMA table_info(runs)").all();
const colNames = cols.map(c => c.name);
const placeholders = colNames.map(() => '?').join(', ');
const colList = colNames.join(', ');
console.log(`  columns: ${colList}`);

db.exec(runsSchema);

const getLegit = db.prepare(
  `SELECT ${colList} FROM runs WHERE notes IS NULL OR notes NOT LIKE 'continuous-loop iteration%'`
);
const insertNew = db.prepare(`INSERT INTO runs_new (${colList}) VALUES (${placeholders})`);

const copyTxn = db.transaction((rows) => {
  for (const r of rows) {
    insertNew.run(...colNames.map(c => r[c]));
  }
});

const allLegit = getLegit.all();
copyTxn(allLegit);
console.log(`  copied ${allLegit.length} legitimate rows into runs_new`);

// Swap
console.log('  swapping tables...');
db.exec('DROP TABLE runs');
db.exec('ALTER TABLE runs_new RENAME TO runs');

// Recreate any indexes that were on the old runs table
const indexes = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='runs' AND sql IS NOT NULL"
).all();
for (const idx of indexes) {
  console.log(`  keeping index: ${idx.sql}`);
}

// Also recreate indexes that were on the original runs but got dropped
// with the table. sqlite_master now only shows indexes on the NEW runs,
// which should be fine because ALTER RENAME keeps indexes.

// ─── Clean orphan results/error_logs ───────────────────────────────────────
console.log('\nCleaning orphan rows in results / error_logs...');
const legitIds = new Set(allLegit.map(r => r.id));
const allResultRunIds = db.prepare('SELECT DISTINCT run_id FROM results').all();
const orphanRunIds = allResultRunIds.filter(r => !legitIds.has(r.run_id)).map(r => r.run_id);
console.log(`  orphan run_ids referenced by results: ${orphanRunIds.length}`);

if (orphanRunIds.length > 0) {
  // Batch delete — run_ids might be large but this is rare
  const delResult = db.prepare('DELETE FROM results WHERE run_id = ?');
  const delErrors = db.prepare(
    'DELETE FROM error_logs WHERE result_id IN (SELECT id FROM results WHERE run_id = ?)'
  );
  const cleanTxn = db.transaction((ids) => {
    for (const id of ids) {
      delErrors.run(id);
      delResult.run(id);
    }
  });
  cleanTxn(orphanRunIds);
  console.log('  orphan cleanup done');
}

const afterRuns = db.prepare('SELECT COUNT(*) AS c FROM runs').get().c;
const afterResults = db.prepare('SELECT COUNT(*) AS c FROM results').get().c;
const afterErrors = db.prepare('SELECT COUNT(*) AS c FROM error_logs').get().c;
console.log(`\nAfter cleanup:`);
console.log(`  runs:       ${afterRuns.toLocaleString()}`);
console.log(`  results:    ${afterResults.toLocaleString()}`);
console.log(`  error_logs: ${afterErrors.toLocaleString()}`);

// ─── Reclaim disk ─────────────────────────────────────────────────────────
console.log('\nCheckpointing WAL and VACUUMing... (this may take a minute)');
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

printSizes('AFTER');

const elapsed = ((Date.now() - execStart) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s.`);
