/**
 * Sentinel Node Tester — "Scanning…" ETA label regression tests
 *
 * Root cause this guards (2026-06): during the Phase-2 parallel online scan the
 * ETA is genuinely incomputable (no node-test completions to measure yet). The
 * dashboards showed a frozen-looking "Calculating…" (admin) / "ETA —" (live) for
 * the whole scan. The first fix keyed the label on totalNodes<=0 — which works
 * for a FRESH run but NOT a RESUME, where recomputeCounters() leaves totalNodes
 * at the restored positive value, so the scan was never detected and the label
 * stayed "Calculating…". The durable fix is an explicit state.scanning flag set
 * across the scan in pipeline.js, whitelisted into PUBLIC_STATE_KEYS, and read by
 * both dashboards' ETA branch.
 *
 * These are static source assertions (no native imports, no server, no DB).
 *
 * Run: node test/scanning-eta-label.test.js
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const pipeline = readFileSync(path.join(ROOT, 'audit/pipeline.js'), 'utf8');
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const admin = readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const live = readFileSync(path.join(ROOT, 'live.html'), 'utf8');

const results = { pass: 0, fail: 0 };
function ok(cond, name) {
  if (cond) { results.pass++; console.log(`  PASS  ${name}`); }
  else { results.fail++; console.error(`  FAIL  ${name}`); }
}

console.log('"Scanning…" ETA label — regression tests\n');

// ─── 1. pipeline.js sets state.scanning across the Phase-2 scan ───────────────
console.log('1. pipeline.js drives the scanning flag');
ok(/state\.scanning\s*=\s*true\s*;/.test(pipeline),
  'pipeline sets state.scanning = true before the scan');
// The clear must be in a finally so a scan throw can't leave it stuck true.
ok(/finally\s*{\s*[\s\S]*?state\.scanning\s*=\s*false\s*;[\s\S]*?}/.test(pipeline),
  'pipeline clears state.scanning = false in a finally (throw-safe)');
// Ordering: the `= true` assignment precedes the scanNodesParallel await it guards.
{
  const trueIdx = pipeline.indexOf('state.scanning = true');
  const scanIdx = pipeline.indexOf('scanNodesParallel(nodesToTest');
  ok(trueIdx !== -1 && scanIdx !== -1 && trueIdx < scanIdx,
    'scanning=true is set before the runAudit scanNodesParallel call');
}
// Reset at run start so a prior errored run can't leak a stale true.
ok(/state\.scanning\s*=\s*false;\s*\/\/[^\n]*Phase-2/.test(pipeline),
  'runAudit initialises state.scanning = false at the top');

// ─── 2. server.js ships scanning to the public/live surface ───────────────────
console.log('\n2. server.js whitelists scanning for public SSE');
ok(/PUBLIC_STATE_KEYS\s*=\s*\[[\s\S]*?'scanning'[\s\S]*?\]/.test(server),
  "PUBLIC_STATE_KEYS includes 'scanning' (else /live never sees it)");

// ─── 3. both dashboards key the "Scanning…" label on the flag ─────────────────
console.log('\n3. dashboards read the flag in the ETA branch');
ok(/state\.scanning\s*\|\|/.test(admin) && /Scanning…/.test(admin),
  "admin.html ETA branch tests state.scanning and renders 'Scanning…'");
ok(/_liveState\.scanning\s*\|\|/.test(live) && /Scanning…/.test(live),
  "live.html ETA branch tests _liveState.scanning and renders 'Scanning…'");

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n============================================================`);
console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed (${results.pass + results.fail} total)`);
console.log(`============================================================`);
process.exit(results.fail === 0 ? 0 : 1);
