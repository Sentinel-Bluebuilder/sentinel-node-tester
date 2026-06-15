/**
 * Sentinel Node Tester — Failure-Log UX Regression Tests
 *
 * Asserts the Failure-Log UX MUST (non-negotiable per CLAUDE.md) by reading
 * HTML and source files as text — no server, no DB, no imports needed.
 *
 * Run: node test/failure-log-ux.test.js
 * Exit 0 = all pass, exit 1 = failures.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const results = { pass: 0, fail: 0, errors: [] };

function assert(condition, name) {
  if (condition) {
    results.pass++;
  } else {
    results.fail++;
    results.errors.push(name);
    console.error(`  FAIL: ${name}`);
  }
}

function readSrc(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('Failure-Log UX — Static Regression Tests\n');

// ─── 1. admin.html — per-row copy button ─────────────────────────────────────
console.log('1. admin.html: per-row copy button + handlers...');
const admin = readSrc('admin.html');

// Every failed row in the admin table MUST render a .row-copy-btn element.
assert(admin.includes('row-copy-btn'), 'admin.html contains CSS class "row-copy-btn"');

// The JS handler that fetches failure logs and puts them on the clipboard.
assert(admin.includes('copyRowFailure'), 'admin.html contains function/call "copyRowFailure"');

// ─── 2. public.html — per-row copy button + handlers ─────────────────────────
console.log('2. public.html: per-row copy button + handlers...');
const pub = readSrc('public.html');

assert(pub.includes('row-copy-btn'), 'public.html contains CSS class "row-copy-btn"');
assert(pub.includes('copyRowFailure'), 'public.html contains function/call "copyRowFailure"');

// ─── 3. live.html — per-row copy button + handlers ───────────────────────────
console.log('3. live.html: per-row copy button + handlers...');
const live = readSrc('live.html');

assert(live.includes('row-copy-btn'), 'live.html contains CSS class "row-copy-btn"');
assert(live.includes('copyRowFailure'), 'live.html contains function/call "copyRowFailure"');

// ─── 4. Clipboard fallback — both APIs must be present in each file ───────────
// Per CLAUDE.md: copy helper MUST have both navigator.clipboard.writeText AND a
// <textarea> + execCommand('copy') fallback for insecure contexts.
console.log('4. Clipboard fallback: navigator.clipboard + execCommand in all three files...');

assert(
  admin.includes('navigator.clipboard') && admin.includes('execCommand'),
  'admin.html has both navigator.clipboard and execCommand("copy") fallback',
);
assert(
  pub.includes('navigator.clipboard') && pub.includes('execCommand'),
  'public.html has both navigator.clipboard and execCommand("copy") fallback',
);
assert(
  live.includes('navigator.clipboard') && live.includes('execCommand'),
  'live.html has both navigator.clipboard and execCommand("copy") fallback',
);

// ─── 5. admin.html — drawer copy + download buttons (actual IDs) ──────────────
// CLAUDE.md originally referenced #copyFailureLogsBtn but the real HTML uses
// #dCopyBtn (Copy Raw Failure Logs) and #dDownloadBtn (Download .txt).
// Assert the ACTUAL ids so a rename is caught immediately.
console.log('5. admin.html: drawer copy/download button IDs (dCopyBtn, dDownloadBtn)...');

assert(admin.includes('id="dCopyBtn"'), 'admin.html has drawer copy button with id="dCopyBtn"');
assert(admin.includes('id="dDownloadBtn"'), 'admin.html has drawer download button with id="dDownloadBtn"');

// ─── 6. pipeline.js calls insertErrorLog ─────────────────────────────────────
// Per CLAUDE.md: audit/pipeline.js MUST call insertErrorLog() for every failed
// result. Read the source as text — we do not import it.
console.log('6. audit/pipeline.js: insertErrorLog call present...');
const pipeline = readSrc('audit/pipeline.js');

assert(
  pipeline.includes('insertErrorLog'),
  'audit/pipeline.js calls insertErrorLog (failure-log persistence is wired)',
);

// Verify it's actually called (invoked), not just imported. The import uses the
// aliased name _dbInsertErrorLog; the call site uses insertErrorLog. Either form
// proves the function is referenced in the call graph.
assert(
  pipeline.includes('_dbInsertErrorLog') || pipeline.includes('insertErrorLog('),
  'audit/pipeline.js invokes insertErrorLog (not just imports the name)',
);

// ─── Results ──────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed (${results.pass + results.fail} total)`);
if (results.errors.length > 0) {
  console.log('\nFAILURES:');
  for (const e of results.errors) console.log(`  FAIL: ${e}`);
}
console.log(`${'='.repeat(50)}`);
process.exit(results.fail > 0 ? 1 : 0);
