#!/usr/bin/env node
/**
 * Sentinel Node Tester — Full Results + DB Cleanup / Reconcile
 *
 * One tool for keeping the two stores healthy and consistent:
 *   • SQLite   data/audit.db   — runs / results / error_logs / batches
 *   • Files    results/        — results.json, .state-snapshot.json,
 *                                runs/index.json + runs/test-NNN/ snapshots,
 *                                audit-*.log
 *
 * Replaces backfill-runs / cleanup-runaway-runs / verify-db-results.
 *
 *   DEFAULT (no flags)        Read-only report. Opens the DB read-only — NO
 *                             migrations, no write lock, nothing mutated.
 *   --fix                     Apply safe repairs. Backs up audit.db + index.json
 *                             first, then:
 *                               · re-sync run-index labels to their snapshots
 *                               · drop dangling/duplicate entries, clear bad activeRun
 *                               · register orphan snapshot dirs (no fabricated spend)
 *                               · prune runaway 'continuous-loop iteration%' rows
 *                               · backfill file snapshots missing from SQLite
 *                               · DB slim-down (one-time backfill for legacy data):
 *                                   – offload inline results.raw_json blobs to
 *                                     results/raw/run-<run_id>/<id>.json, then NULL
 *                                     the column (write+verify BEFORE null = no loss)
 *                                   – cap legacy error_logs.log_snippet at 16 KB tail
 *                                     (idempotent backstop to migration v11)
 *                                   – prune batch_results to DEFAULT_BATCH_RETENTION
 *   --purge-orphan-logs       (with --fix) quarantine orphan audit logs into
 *                             results/.cleanup-trash/<ts>/ (move, not delete;
 *                             never the active or a recently-written log).
 *
 *   node scripts/cleanup.mjs                 # report
 *   node scripts/cleanup.mjs --fix           # repair + prune + backfill
 *   node scripts/cleanup.mjs --fix --purge-orphan-logs
 *   npm run cleanup [-- --fix]
 *
 * Run with the SERVER STOPPED. Exit 0 = consistent (or all repairs applied),
 * 1 = unresolved issues remain.
 *
 * NOTE (per adversarial review): the index↔SQLite correlation is a HEURISTIC
 * (finish-time + node count) and is reported as INFORMATIONAL only — it never
 * writes spend/refund, because that match is unreliable across the auto-save,
 * boot-reconcile, continuous-loop and retest paths and could fabricate values.
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RAW_DIR, DEFAULT_BATCH_RETENTION } from '../core/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const RUNS_DIR = path.join(RESULTS_DIR, 'runs');
const RUNS_INDEX = path.join(RUNS_DIR, 'index.json');
const RESULTS_FILE = path.join(RESULTS_DIR, 'results.json');
const SNAPSHOT_FILE = path.join(RESULTS_DIR, '.state-snapshot.json');
const DB_PATH = path.join(ROOT, 'data', 'audit.db');

const FIX = process.argv.includes('--fix');
const PURGE_LOGS = process.argv.includes('--purge-orphan-logs');
const MATCH_TOLERANCE_MS = 15_000;
const BACKFILL_TOLERANCE_MS = 60_000; // wider dedup window for backfill (save-time skew)
const RECENT_LOG_MS = 24 * 60 * 60 * 1000;       // never purge a log written in the last day
const RUNAWAY_NOTES = 'continuous-loop iteration%';
const LOG_SNIPPET_CAP = 16384;                    // bytes — mirrors core/db.js insertErrorLog + migration v11

// Human-readable byte size for the slim-down report.
const humanBytes = n => {
  if (n == null || !Number.isFinite(Number(n))) return '0 B';
  let b = Number(n);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

// ─── reporter ─────────────────────────────────────────────────────────────────
// hard      = cannot be auto-fixed (integrity / schema / unparseable / write failures)
// repairable= fixed under --fix (label drift, dangling, orphan dir, runaway rows…)
// info      = expected/optional, never affects exit (cross-store, orphan logs, absent files)
let nHard = 0, nRepair = 0, nInfo = 0, nFixed = 0;
const C = { red: s => `\x1b[31m${s}\x1b[0m`, yel: s => `\x1b[33m${s}\x1b[0m`, grn: s => `\x1b[32m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` };
const ok        = m => console.log(`  ${C.grn('✓')} ${m}`);
const hard      = m => { nHard++;   console.log(`  ${C.red('✗')} ${m}`); };
const repairable= m => { nRepair++; console.log(`  ${C.yel('⚠')} ${m}`); };
const info      = m => { nInfo++;   console.log(`  ${C.dim('ℹ ' + m)}`); };
const fixd      = m => { nFixed++;  console.log(`    ${C.grn('↳ fixed:')} ${m}`); };
const todo      = m => console.log(`    ${C.dim('↳ would fix: ' + m)}`);
const section   = t => console.log(`\n${C.b(t)}`);

const loadJson = p => { if (!existsSync(p)) return undefined; try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const snapResults = n => path.join(RUNS_DIR, `test-${String(n).padStart(3, '0')}`, 'results.json');
const recompute = rows => ({
  total:  rows.length,
  passed: rows.filter(r => r && r.actualMbps != null).length,
  failed: rows.filter(r => r && r.actualMbps == null).length,
  pass10: rows.filter(r => r && r.actualMbps != null && r.actualMbps >= 10).length,
});

console.log(C.b('\n══ Sentinel cleanup — results + audit.db ══'));
console.log(C.dim(`mode: ${FIX ? 'FIX (mutates, after backup)' : 'report (read-only)'}${PURGE_LOGS ? ' +purge-orphan-logs' : ''}`));

// ─── open DB READ-ONLY for verification (no migrations, no write lock) ────────
let rdb = null;
if (existsSync(DB_PATH)) {
  try { rdb = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
  catch (e) { hard(`cannot open ${path.relative(ROOT, DB_PATH)} read-only: ${e.message}`); }
} else info(`no audit.db at ${path.relative(ROOT, DB_PATH)} (ok on a fresh box)`);

// ─── 1. SQLite integrity ──────────────────────────────────────────────────────
section('1. SQLite (data/audit.db)');
let runawayCount = 0;
if (rdb) {
  try { const v = rdb.prepare('PRAGMA integrity_check').get()?.integrity_check; v === 'ok' ? ok('integrity_check: ok') : hard(`integrity_check: ${v}`); }
  catch (e) { hard(`integrity_check failed: ${e.message}`); }
  try { ok(`schema_version: ${rdb.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version ?? '(none)'}`); }
  catch (e) { hard(`schema_version unreadable: ${e.message}`); }
  for (const t of ['runs', 'results', 'error_logs', 'batches', 'batch_results']) {
    try { ok(`table ${t}: ${rdb.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c} rows`); }
    catch (e) { hard(`table ${t} missing/unreadable: ${e.message}`); }
  }
  try {
    const cols = rdb.prepare('PRAGMA table_info(runs)').all().map(c => c.name);
    for (const col of ['spent_udvpn', 'refunded_udvpn']) cols.includes(col) ? ok(`runs.${col} present`) : hard(`runs.${col} missing (migration v10 not applied)`);
  } catch (e) { hard(`runs columns unreadable: ${e.message}`); }
  try {
    runawayCount = rdb.prepare('SELECT COUNT(*) AS c FROM runs WHERE notes LIKE ?').get(RUNAWAY_NOTES).c;
    runawayCount > 0 ? repairable(`${runawayCount.toLocaleString()} runaway 'continuous-loop iteration' run rows`) : ok('no runaway continuous-loop rows');
  } catch { /* table issue already reported */ }
}

// ─── 2. File JSON parse ───────────────────────────────────────────────────────
section('2. File results (parse)');
let indexUnparseable = false;
for (const [label, p] of [['results.json', RESULTS_FILE], ['.state-snapshot.json', SNAPSHOT_FILE], ['runs/index.json', RUNS_INDEX]]) {
  const v = loadJson(p);
  if (v === undefined) ok(`${label}: not present (ok if never run)`);
  else if (v === null) { hard(`${label}: unparseable JSON — left untouched`); if (p === RUNS_INDEX) indexUnparseable = true; }
  else ok(`${label}: parses`);
}

// ─── 3. Run index ↔ snapshots (computed ONCE; written only under --fix) ───────
section('3. Run index ↔ snapshots');
const rawIndex = (!indexUnparseable && loadJson(RUNS_INDEX)) || { runs: [], activeRun: null };
if (!Array.isArray(rawIndex.runs)) rawIndex.runs = [];
let indexChanged = false;
const cleanRuns = [];
const known = new Set();
const seen = new Set();

if (indexUnparseable) {
  console.log(C.dim('  index.json unparseable — skipping index repairs to avoid clobbering it.'));
} else {
  for (const entry of rawIndex.runs) {
    if (seen.has(entry.number)) { repairable(`#${entry.number}: duplicate index entry`); indexChanged = FIX || indexChanged; FIX ? fixd(`dropped duplicate #${entry.number}`) : todo(`drop duplicate #${entry.number}`); continue; }
    seen.add(entry.number);
    const rj = snapResults(entry.number);
    const rows = existsSync(rj) ? loadJson(rj) : undefined;
    if (rows === undefined) { repairable(`#${entry.number}: snapshot missing`); indexChanged = FIX || indexChanged; FIX ? fixd(`dropped dangling #${entry.number}`) : todo(`drop dangling #${entry.number}`); continue; }
    if (!Array.isArray(rows)) { repairable(`#${entry.number}: snapshot unparseable`); indexChanged = FIX || indexChanged; FIX ? fixd(`dropped corrupt #${entry.number}`) : todo(`drop corrupt #${entry.number}`); continue; }
    known.add(entry.number);
    const c = recompute(rows);
    if (entry.total !== c.total || entry.passed !== c.passed || entry.failed !== c.failed || entry.pass10 !== c.pass10) {
      repairable(`#${entry.number}: label drift — index ${entry.passed}/${entry.total} vs snapshot ${c.passed}/${c.total}`);
      if (FIX) { Object.assign(entry, c); indexChanged = true; fixd(`re-synced #${entry.number} → ${c.passed}/${c.total}`); } else todo(`re-sync #${entry.number}`);
    } else ok(`#${entry.number}: label matches snapshot (${c.passed}/${c.total})`);
    cleanRuns.push(entry);
  }

  if (existsSync(RUNS_DIR)) {
    for (const name of readdirSync(RUNS_DIR)) {
      const m = /^test-(\d+)$/.exec(name);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (cleanRuns.some(r => r.number === num)) continue;
      const rows = existsSync(snapResults(num)) ? loadJson(snapResults(num)) : undefined;
      if (!Array.isArray(rows)) continue;
      repairable(`orphan snapshot dir test-${m[1]} (no index entry, ${rows.length} rows)`);
      const c = recompute(rows);
      let date; try { date = statSync(snapResults(num)).mtime.toISOString(); } catch { date = new Date().toISOString(); }
      const entry = { number: num, label: 'Recovered (orphan dir)', date, ...c, sdk: null, spentUdvpn: null, auditLog: null };
      known.add(num); // track existence in both modes so the activeRun check below is accurate
      if (FIX) { cleanRuns.push(entry); indexChanged = true; fixd(`registered orphan test-${m[1]} as #${num}`); } else todo(`register orphan test-${m[1]}`);
    }
  }

  let activeRun = rawIndex.activeRun;
  if (activeRun != null && !known.has(activeRun)) { repairable(`index.activeRun=${activeRun} points to a non-existent run`); if (FIX) { activeRun = null; indexChanged = true; fixd('cleared dangling activeRun'); } else todo('clear dangling activeRun'); }
  else ok(`index.activeRun: ${activeRun ?? 'null'} (valid)`);
  rawIndex.activeRun = activeRun;
}

// ─── 4. Run index ↔ SQLite (INFORMATIONAL ONLY) ───────────────────────────────
section('4. Run index ↔ SQLite (informational)');
console.log(C.dim('  Heuristic match (finish-time + node count); reported, never auto-fixed.'));
if (rdb && cleanRuns.length) {
  let matched = 0, unmatched = 0, spendDiff = 0;
  for (const e of cleanRuns) {
    const finishedAt = Date.parse(e.date);
    if (!Number.isFinite(finishedAt) || e.total == null) { unmatched++; continue; }
    const row = rdb.prepare('SELECT spent_udvpn, refunded_udvpn FROM runs WHERE finished_at IS NOT NULL AND node_count = ? AND ABS(finished_at - ?) <= ? ORDER BY ABS(finished_at - ?) ASC LIMIT 1').get(e.total, finishedAt, MATCH_TOLERANCE_MS, finishedAt);
    if (!row) { unmatched++; continue; }
    matched++;
    if (e.spentUdvpn != null && Number(e.spentUdvpn) !== row.spent_udvpn) spendDiff++;
  }
  info(`${matched} index run(s) matched a SQLite row, ${unmatched} unmatched (normal for continuous/auto-saved runs)`);
  if (spendDiff) info(`${spendDiff} matched run(s) differ on spend/refund vs SQLite — review manually, not auto-fixed`);
} else console.log(C.dim('  (nothing to correlate)'));

// ─── 5. Orphan audit logs (protect active + referenced + recent) ──────────────
section('5. Orphan audit logs');
let orphanLogs = [];
if (existsSync(RESULTS_DIR)) {
  const referenced = new Set(cleanRuns.map(r => r.auditLog).filter(Boolean));
  const active = (() => { const s = loadJson(SNAPSHOT_FILE); return s && s.auditLogPath ? path.basename(s.auditLogPath) : null; })();
  const now = Date.now();
  const logs = readdirSync(RESULTS_DIR).filter(f => /^(audit|retest)-.*\.log$/.test(f));
  orphanLogs = logs.filter(f => {
    if (referenced.has(f) || f === active) return false;
    let mtime = 0; try { mtime = statSync(path.join(RESULTS_DIR, f)).mtimeMs; } catch {}
    return now - mtime >= RECENT_LOG_MS; // protect recently-written (possibly live) logs
  });
  if (!orphanLogs.length) ok(`no purgeable orphan logs (${logs.length} log file(s))`);
  else { info(`${orphanLogs.length} orphan log file(s): ${orphanLogs.slice(0, 5).join(', ')}${orphanLogs.length > 5 ? ' …' : ''}`); if (PURGE_LOGS && !FIX) console.log(C.dim('    (--purge-orphan-logs needs --fix to take effect — ignored)')); else if (!(FIX && PURGE_LOGS)) console.log(C.dim('    (pass --fix --purge-orphan-logs to quarantine these)')); }
}

// ─── 6. DB slim-down (one-time backfill for legacy data) ──────────────────────
// These mirror the forward-going behaviour that core/db.js now applies on every
// insert: raw_json blobs offloaded to per-run files, log_snippet capped at 16 KB,
// batch_results bounded. Existing rows from before those commits still carry the
// inline blob / oversized snippet / unbounded batch history; this section reports
// (and, under --fix, performs) the one-time migration of that legacy data.
section('6. DB slim-down (legacy backfill)');
let rawJsonRows = 0;          // results rows still holding an inline raw_json blob
let logSnippetRows = 0;       // error_logs rows whose snippet exceeds the 16 KB cap
let batchCount = 0;           // total batches
let batchResultRows = 0;      // total batch_results rows
if (rdb) {
  try {
    const r = rdb.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(length(raw_json)), 0) AS bytes FROM results WHERE raw_json IS NOT NULL').get();
    rawJsonRows = r.c;
    rawJsonRows > 0
      ? repairable(`${rawJsonRows.toLocaleString()} results row(s) still hold an inline raw_json blob (~${humanBytes(r.bytes)} reclaimable → offload to results/raw/run-*/<id>.json + NULL column)`)
      : ok('no inline raw_json blobs (already offloaded)');
  } catch (e) { hard(`raw_json scan failed: ${e.message}`); }

  try {
    logSnippetRows = rdb.prepare(`SELECT COUNT(*) AS c FROM error_logs WHERE log_snippet IS NOT NULL AND length(log_snippet) > ${LOG_SNIPPET_CAP}`).get().c;
    logSnippetRows > 0
      ? repairable(`${logSnippetRows.toLocaleString()} error_logs row(s) exceed the 16 KB log_snippet cap (would truncate to tail)`)
      : ok('no oversized log_snippet rows (migration v11 already applied)');
  } catch (e) { hard(`log_snippet scan failed: ${e.message}`); }

  try {
    batchCount = rdb.prepare('SELECT COUNT(*) AS c FROM batches').get().c;
    batchResultRows = rdb.prepare('SELECT COUNT(*) AS c FROM batch_results').get().c;
    const overRetention = Math.max(0, batchCount - DEFAULT_BATCH_RETENTION);
    overRetention > 0
      ? repairable(`${batchCount.toLocaleString()} batch(es) / ${batchResultRows.toLocaleString()} batch_results row(s); ~${overRetention.toLocaleString()} batch(es) over the ${DEFAULT_BATCH_RETENTION} retention cap (would prune)`)
      : ok(`${batchCount.toLocaleString()} batch(es) / ${batchResultRows.toLocaleString()} batch_results row(s) — within the ${DEFAULT_BATCH_RETENTION} retention cap`);
  } catch (e) { hard(`batch_results scan failed: ${e.message}`); }
}

// Close our OWN read-only handle before mutating: if it stays open, the WAL
// checkpoint below can report `busy` and falsely abort the whole --fix on a
// perfectly healthy, server-stopped box.
if (rdb) { try { rdb.close(); } catch {} rdb = null; }

// ─── apply mutations (only under --fix) ───────────────────────────────────────
if (FIX) {
  section('Applying fixes');
  const ts = Date.now();
  // Always back up audit.db before ANY DB write (prune OR backfill). Refuse to
  // write if the WAL couldn't be fully checkpointed (server likely running → a
  // .db-only copy would be an incomplete, non-restorable backup).
  let dbWriteOk = existsSync(DB_PATH);
  let abortAll = false; // a blocked checkpoint => server running => mutate NOTHING (incl. index)
  if (dbWriteOk) {
    try {
      const w = new Database(DB_PATH);
      const cp = w.pragma('wal_checkpoint(TRUNCATE)');
      const busy = Array.isArray(cp) ? cp[0]?.busy : cp?.busy;
      w.close();
      if (busy) { hard('WAL checkpoint blocked — is the server running? Stop it and re-run. No changes made.'); dbWriteOk = false; abortAll = true; }
      else { copyFileSync(DB_PATH, `${DB_PATH}.bak-${ts}`); console.log(`  ${C.grn('●')} backed up audit.db → ${path.basename(DB_PATH)}.bak-${ts}`); }
    } catch (e) { hard(`audit.db backup failed — aborting all changes: ${e.message}`); dbWriteOk = false; abortAll = true; }
  }

  if (runawayCount > 0 && dbWriteOk) {
    try {
      const w = new Database(DB_PATH);
      w.pragma('foreign_keys = ON');
      const before = w.prepare('SELECT COUNT(*) AS c FROM runs').get().c;
      // DELETE (not CREATE-TABLE-AS rebuild) so the PRIMARY KEY, indexes, column
      // constraints and schema_version survive. Delete child results first
      // (error_logs cascade off results) so no FK reference is left dangling.
      w.transaction(() => {
        w.prepare('DELETE FROM results WHERE run_id IN (SELECT id FROM runs WHERE notes LIKE ?)').run(RUNAWAY_NOTES);
        w.prepare('DELETE FROM runs WHERE notes LIKE ?').run(RUNAWAY_NOTES);
      })();
      const fk = w.prepare('PRAGMA foreign_key_check').all();
      w.pragma('wal_checkpoint(TRUNCATE)');
      const after = w.prepare('SELECT COUNT(*) AS c FROM runs').get().c;
      w.close();
      if (fk.length) hard(`prune left ${fk.length} FK violation(s) — restore audit.db from the backup`);
      else fixd(`pruned ${(before - after).toLocaleString()} runaway run rows + children (${before.toLocaleString()} → ${after.toLocaleString()})`);
    } catch (e) { hard(`runaway prune failed (restore audit.db from the backup): ${e.message}`); }
  }

  if (indexChanged && !indexUnparseable && !abortAll) {
    try {
      if (existsSync(RUNS_INDEX)) copyFileSync(RUNS_INDEX, `${RUNS_INDEX}.bak-${ts}`);
      writeFileSync(RUNS_INDEX, JSON.stringify({ runs: cleanRuns, activeRun: rawIndex.activeRun }, null, 2), 'utf8');
      console.log(`  ${C.grn('●')} wrote reconciled index.json (backup: index.json.bak-${ts})`);
    } catch (e) { hard(`could not write index.json: ${e.message}`); }
  }

  // Backfill file runs missing from SQLite. Idempotent via a tolerance match on
  // node_count + the save-time finish (see the dedup note below). mode is derived
  // from the snapshot rows (mostly TEST_RUN_SKIP → 'test') or a 'Sub. Plan' label,
  // never guessed as p2p (which would corrupt analytics + violate TEST RUN
  // isolation). The active run is skipped (its DB row exists, unfinished).
  if (dbWriteOk) {
    try {
      const { getDb, insertRun, updateRunOnFinish, insertResultsBatch } = await import('../core/db.js');
      const wdb = getDb();
      const existsStmt = wdb.prepare('SELECT id FROM runs WHERE node_count = ? AND finished_at IS NOT NULL AND ABS(finished_at - ?) <= ? LIMIT 1');
      let added = 0;
      for (const e of cleanRuns) {
        if (rawIndex.activeRun != null && e.number === rawIndex.activeRun) continue;
        const rows = loadJson(snapResults(e.number));
        if (!Array.isArray(rows) || !rows.length) continue;
        const times = rows.map(r => r && r.timestamp ? new Date(r.timestamp).getTime() : 0).filter(t => t > 0);
        // Dedup against what the server actually stored: saveCurrentRun writes the
        // SQLite finished_at = Date.now() at save, which is exactly the index
        // `date`. Key on that (not max(row timestamp), which lags it). Skip — never
        // insert — runs we can't time, so a re-run stays idempotent.
        const finished_at = Number.isFinite(Date.parse(e.date)) ? Date.parse(e.date) : (times.length ? Math.max(...times) : null);
        if (finished_at == null) { info(`#${e.number}: snapshot has no finish time — skipped backfill (can't dedup safely)`); continue; }
        if (existsStmt.get(rows.length, finished_at, BACKFILL_TOLERANCE_MS)) continue; // already in SQLite
        const started_at = times.length ? Math.min(...times) : finished_at;
        const skips = rows.filter(r => r && (r.errorCode === 'TEST_RUN_SKIP' || r.skipped)).length;
        const mode = skips > rows.length / 2 ? 'test' : (/sub\.?\s*plan/i.test(e.label || '') ? 'subscription' : 'p2p');
        const runId = insertRun({ started_at, mode, notes: e.label || `test-${e.number}` });
        updateRunOnFinish(runId, { finished_at, node_count: rows.length, pass_count: rows.filter(r => r && r.actualMbps != null).length });
        insertResultsBatch(runId, rows);
        added++;
      }
      added ? fixd(`backfilled ${added} file run(s) into SQLite`) : console.log(`  ${C.dim('↳ backfill: SQLite already has every file run')}`);
    } catch (e) { hard(`SQLite backfill failed: ${e.message}`); }
  } else console.log(`  ${C.dim('↳ backfill skipped (DB writes disabled)')}`);

  // ── DB slim-down (one-time legacy backfill) ───────────────────────────────
  // Gated on dbWriteOk (audit.db backed up + WAL checkpoint succeeded → server
  // stopped). Mirrors core/db.js forward behaviour for pre-slim-down rows.
  if (dbWriteOk) {
    try {
      const { getDb, readRawJson, pruneBatchResults } = await import('../core/db.js');
      const sdb = getDb();

      // Action 1: offload inline raw_json blobs to per-run files, then NULL the
      // column. Order is write+verify BEFORE null so a crash mid-pass never
      // loses a blob — a re-run just re-offloads any row whose column is still
      // set. writeRawJson is not exported from core/db.js, so replicate its exact
      // path + write (mkdirSync recursive + writeFileSync) inline.
      const blobRows = sdb.prepare('SELECT id, run_id, raw_json FROM results WHERE raw_json IS NOT NULL').all();
      if (!blobRows.length) console.log(`  ${C.dim('↳ raw_json offload: no inline blobs to migrate')}`);
      else {
        const nullStmt = sdb.prepare('UPDATE results SET raw_json = NULL WHERE id = ?');
        let offloaded = 0, skippedWrite = 0;
        // Stage writes first (file I/O outside the txn), collecting the ids whose
        // file is confirmed on disk; null only those, inside a single txn.
        const ready = [];
        for (const row of blobRows) {
          const dir = path.join(RAW_DIR, `run-${row.run_id}`);
          const file = path.join(dir, `${row.id}.json`);
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(file, row.raw_json);
            // VERIFY before we agree to null: file exists and is non-empty.
            const st = statSync(file);
            if (st.size > 0) ready.push(row.id);
            else { skippedWrite++; hard(`raw_json offload: ${file} wrote 0 bytes — left column intact for result ${row.id}`); }
          } catch (e) { skippedWrite++; hard(`raw_json offload: write failed for result ${row.id} — left column intact: ${e.message}`); }
        }
        if (ready.length) {
          sdb.transaction(() => { for (const id of ready) { nullStmt.run(id); offloaded++; } })();
        }
        // Sanity sample: rehydrate the first migrated row from disk.
        if (ready.length) {
          const sample = blobRows.find(r => r.id === ready[0]);
          const back = readRawJson(sample.run_id, sample.id);
          if (back == null) hard(`raw_json offload: verify-read of run-${sample.run_id}/${sample.id}.json returned null after write`);
        }
        fixd(`offloaded ${offloaded.toLocaleString()} raw_json blob(s) to results/raw/run-*/<id>.json + NULLed column${skippedWrite ? ` (${skippedWrite} skipped — column left intact, no data loss)` : ''}`);
      }

      // Action 2: cap legacy oversized log_snippet (idempotent backstop to v11).
      const capRes = sdb.prepare(
        `UPDATE error_logs SET log_snippet = substr(log_snippet, length(log_snippet) - ${LOG_SNIPPET_CAP} + 1) WHERE log_snippet IS NOT NULL AND length(log_snippet) > ${LOG_SNIPPET_CAP}`,
      ).run();
      capRes.changes > 0
        ? fixd(`capped ${capRes.changes.toLocaleString()} oversized log_snippet row(s) to 16 KB tail`)
        : console.log(`  ${C.dim('↳ log_snippet cap: nothing to truncate (v11 already applied)')}`);

      // Action 3: prune batch_results to retention (reuse core/db.js keep-set).
      const pr = pruneBatchResults({ keepBatches: DEFAULT_BATCH_RETENTION });
      (pr.deletedBatchResults || pr.deletedBatches)
        ? fixd(`pruned ${pr.deletedBatchResults.toLocaleString()} batch_results row(s) + ${pr.deletedBatches.toLocaleString()} batch(es) (kept ${pr.keptBatches.toLocaleString()})`)
        : console.log(`  ${C.dim(`↳ batch_results prune: within retention (kept ${pr.keptBatches.toLocaleString()})`)}`);

      // Reclaim freed pages and flush the WAL.
      try { sdb.pragma('wal_checkpoint(TRUNCATE)'); }
      catch (e) { hard(`slim-down checkpoint failed: ${e.message}`); }
    } catch (e) { hard(`DB slim-down failed (restore audit.db from the backup): ${e.message}`); }
  } else console.log(`  ${C.dim('↳ slim-down skipped (DB writes disabled)')}`);

  if (PURGE_LOGS && orphanLogs.length && !abortAll) {
    const trash = path.join(RESULTS_DIR, '.cleanup-trash', String(ts));
    try {
      mkdirSync(trash, { recursive: true });
      for (const f of orphanLogs) { try { renameSync(path.join(RESULTS_DIR, f), path.join(trash, f)); fixd(`quarantined ${f}`); } catch (e) { hard(`quarantine ${f} failed: ${e.message}`); } }
      console.log(`  ${C.grn('●')} orphan logs moved to ${path.relative(ROOT, trash)} (delete manually once verified)`);
    } catch (e) { hard(`could not create quarantine dir: ${e.message}`); }
  }
}

if (rdb) { try { rdb.close(); } catch {} }

// ─── summary + exit ───────────────────────────────────────────────────────────
console.log(`\n${C.b('Summary:')} ${nHard} unfixable, ${nRepair} repairable, ${nInfo} informational${FIX ? `, ${nFixed} fixed` : ''}.`);
if (!FIX && nRepair > 0) console.log(C.dim('Re-run with --fix to apply repairs (backs up audit.db + index.json first).'));
// report mode: any hard or repairable issue → 1. fix mode: repairables were applied, so only unfixable (hard) failures fail the run.
process.exit((FIX ? nHard : nHard + nRepair) > 0 ? 1 : 0);
