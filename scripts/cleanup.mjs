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
  try { ok(`schema_version: ${rdb.prepare('SELECT version FROM schema_version LIMIT 1').get()?.version ?? '(none)'}`); }
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
      const entry = { number: num, label: 'Recovered (orphan dir)', date, ...c, sdk: null, spentUdvpn: null, refundedUdvpn: null, auditLog: null };
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
    if (e.spentUdvpn != null && (Number(e.spentUdvpn) !== row.spent_udvpn || Number(e.refundedUdvpn) !== row.refunded_udvpn)) spendDiff++;
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
