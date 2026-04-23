/**
 * Sentinel Node Tester — Historical Run Backfill
 *
 * Reads every results.json under results/runs/test-NNN/, maps each into the
 * SQLite schema, and inserts them.  Idempotent: a run with the same
 * (started_at, mode) is skipped.
 *
 * Usage:
 *   node scripts/backfill-runs.mjs
 *
 * Output:
 *   Files scanned: N | Runs inserted: N | Results inserted: N | Skipped: N
 */

import path from 'path';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// Dynamic import so the DB module can open data/audit.db relative to its own __dirname.
const { insertRun, updateRunOnFinish, insertResultsBatch, findRunByKey, insertResult, insertErrorLog } =
  await import('../core/db.js');

// ─── Locate all run directories ───────────────────────────────────────────────

const RUNS_DIR = path.join(PROJECT_ROOT, 'results', 'runs');
const INDEX_FILE = path.join(RUNS_DIR, 'index.json');

if (!existsSync(RUNS_DIR)) {
  console.error(`runs/ directory not found at ${RUNS_DIR}`);
  process.exit(1);
}

// Load the index to get metadata (sdk, label, date) per run number
let indexRuns = [];
if (existsSync(INDEX_FILE)) {
  try {
    const raw = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
    indexRuns = raw.runs || [];
  } catch (e) {
    console.warn(`Warning: could not parse index.json — ${e.message}`);
  }
}

function getIndexEntry(num) {
  return indexRuns.find(r => r.number === num) || null;
}

// ─── Counters ─────────────────────────────────────────────────────────────────

let filesScanned = 0;
let runsInserted = 0;
let resultsInserted = 0;
let errorLogsTotal = 0;
let skipped = 0;

// ─── Process each test-NNN directory ─────────────────────────────────────────

const runDirs = readdirSync(RUNS_DIR)
  .filter(d => /^test-\d+$/.test(d))
  .sort(); // ensures numerical order

for (const dirName of runDirs) {
  const resultsFile = path.join(RUNS_DIR, dirName, 'results.json');
  if (!existsSync(resultsFile)) continue;

  filesScanned++;

  // Parse the run number from "test-001" → 1
  const num = parseInt(dirName.replace('test-', ''), 10);
  const meta = getIndexEntry(num);

  // Derive started_at from the index entry date, or fall back to the first
  // result's timestamp, or use 0 as a sentinel.
  let started_at;
  if (meta?.date) {
    started_at = new Date(meta.date).getTime();
  } else {
    // Will be overridden below once we read results
    started_at = 0;
  }

  // Derive mode from the index sdk field (best-effort)
  const mode = meta?.sdk === 'subscription' ? 'subscription'
             : meta?.sdk === 'plan'         ? 'subscription'
             : 'p2p';

  let results;
  try {
    results = JSON.parse(readFileSync(resultsFile, 'utf8'));
  } catch (e) {
    console.warn(`  Skipping ${dirName}: JSON parse error — ${e.message}`);
    skipped++;
    continue;
  }

  if (!Array.isArray(results) || results.length === 0) {
    skipped++;
    continue;
  }

  // Use earliest result timestamp as started_at if we didn't have an index date
  if (started_at === 0) {
    const times = results
      .map(r => r.timestamp ? new Date(r.timestamp).getTime() : null)
      .filter(t => t != null && t > 0);
    started_at = times.length > 0 ? Math.min(...times) : Date.now();
  }

  // Idempotency check
  const existing = findRunByKey(started_at, mode);
  if (existing) {
    skipped++;
    continue;
  }

  // Derive finished_at from the latest result timestamp
  const resultTimes = results
    .map(r => r.timestamp ? new Date(r.timestamp).getTime() : null)
    .filter(t => t != null && t > 0);
  const finished_at = resultTimes.length > 0 ? Math.max(...resultTimes) : null;

  const pass_count = results.filter(r => r.actualMbps != null).length;
  const node_count = results.length;

  const notes = meta?.label || dirName;

  // Insert run
  let runId;
  try {
    runId = insertRun({ started_at, mode, notes });
    updateRunOnFinish(runId, { finished_at, node_count, pass_count });
  } catch (e) {
    console.warn(`  Error inserting run ${dirName}: ${e.message}`);
    skipped++;
    continue;
  }

  // Insert all results in one transaction, then add error_logs for failed results.
  // error_logs require individual result_id, so we do a second pass for failures.
  let errorLogsInserted = 0;
  try {
    insertResultsBatch(runId, results);
    resultsInserted += results.length;
    runsInserted++;
    console.log(`  [test-${String(num).padStart(3, '0')}] run_id=${runId} | ${node_count} results | ${pass_count} passed`);
  } catch (e) {
    console.warn(`  Error inserting results for run ${dirName}: ${e.message}`);
    skipped++;
    continue;
  }

  // Second pass: insert error_log rows for failed results that have error info.
  // Historical JSON may have: error (message), errorCode, and rarely log/stage fields.
  for (const r of results) {
    if (r.actualMbps != null) continue; // passed — skip
    const errorMsg = r.error || r.errorMessage || null;
    if (!errorMsg) continue;

    // Derive stage from error text (mirrors db.js deriveStage logic)
    let stage = 'other';
    if (/insufficient|no udvpn pricing|no pricing/i.test(errorMsg)) stage = 'wallet';
    else if (/rpc|abci query|broadcast|tx failed|sign|code: 1\d\d/i.test(errorMsg)) stage = 'rpc';
    else if (/handshake|address mismatch|already exists|409|does not exist/i.test(errorMsg)) stage = 'handshake';
    else if (/session|sessionid|waitforsession/i.test(errorMsg)) stage = 'session';
    else if (/speed|socks5|mbps|tunnel|throughput/i.test(errorMsg)) stage = 'speedtest';

    // Override with JSON-provided stage if present
    if (r.stage && ['handshake', 'session', 'speedtest', 'wallet', 'rpc', 'other'].includes(r.stage)) {
      stage = r.stage;
    }

    // We need the result_id — re-query for the most recently inserted row for this node+run
    // (insertResultsBatch doesn't return IDs). Use a direct DB lookup.
    try {
      const { getDb } = await import('../core/db.js');
      const db = getDb();
      const resultRow = db.prepare(
        'SELECT id FROM results WHERE run_id = ? AND node_addr = ? ORDER BY id DESC LIMIT 1',
      ).get(runId, r.address || '');

      if (resultRow) {
        const logSnippet = r.log ? String(r.log).slice(-8192) : null;
        insertErrorLog({
          result_id:     resultRow.id,
          stage,
          error_code:    r.errorCode || null,
          error_message: errorMsg.slice(0, 2048),
          log_snippet:   logSnippet,
        });
        errorLogsInserted++;
      }
    } catch (elErr) {
      // Non-fatal — skip this error log row
    }
  }

  if (errorLogsInserted > 0) {
    console.log(`    └─ ${errorLogsInserted} error_log rows inserted`);
  }
  errorLogsTotal += errorLogsInserted;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log('Backfill complete.');
console.log(`  Files scanned:    ${filesScanned}`);
console.log(`  Runs inserted:    ${runsInserted}`);
console.log(`  Results inserted: ${resultsInserted}`);
console.log(`  Error logs:       ${errorLogsTotal}`);
console.log(`  Skipped:          ${skipped}`);
