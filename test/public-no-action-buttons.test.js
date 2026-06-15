/**
 * Sentinel Node Tester — Public Pages Must Have Zero Action Buttons
 *
 * Per CLAUDE.md HARD RULE: public.html and live.html MUST have ZERO
 * user-facing action buttons. Public visitors are spectators only.
 * The admin is the only one who can start/stop testing.
 *
 * This test reads public.html and live.html as plain text and asserts that
 * none of the forbidden admin action patterns are present.
 *
 * Assertion design: we test for handler/button patterns, not bare words,
 * to avoid false positives from status text or comments that happen to
 * contain the words "start" or "stop".
 *
 * Run: node test/public-no-action-buttons.test.js
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

console.log('Public Pages — No Action Buttons — Static Tests\n');

const pub  = readSrc('public.html');
const live = readSrc('live.html');

// ─── 1. No devStart() call in public.html ────────────────────────────────────
// devStart() is the admin JS function that POSTs to /api/start.
// It must never appear in the public dashboard.
console.log('1. public.html: no devStart handler...');
assert(
  !pub.includes('devStart'),
  'public.html: does not contain "devStart" (admin-only audit trigger)',
);

// ─── 2. No devStart() call in live.html ──────────────────────────────────────
console.log('2. live.html: no devStart handler...');
assert(
  !live.includes('devStart'),
  'live.html: does not contain "devStart" (admin-only audit trigger)',
);

// ─── 3. No onclick wired to /api/start in public.html ────────────────────────
// Protect against a future button whose onclick directly POSTs to the start
// endpoint without going through devStart().
// Pattern: onclick="...api/start" or fetch calls directly embedded in onclick.
console.log('3. public.html: no onclick wired to /api/start...');
assert(
  !pub.includes("onclick=\"fetch('/api/start") &&
  !pub.includes('onclick="fetch("/api/start'),
  'public.html: no onclick directly calling /api/start',
);

// ─── 4. No onclick wired to /api/start in live.html ──────────────────────────
console.log('4. live.html: no onclick wired to /api/start...');
assert(
  !live.includes("onclick=\"fetch('/api/start") &&
  !live.includes('onclick="fetch("/api/start'),
  'live.html: no onclick directly calling /api/start',
);

// ─── 5. No >Start Test< button label in public.html ─────────────────────────
// Matches a button element whose content (between tags) is "Start Test".
// Uses the angle-bracket form to avoid matching aria labels / comments.
// We check for the button-content pattern ">Start Test<" (with any whitespace).
console.log('5. public.html: no ">Start Test<" button label...');
assert(
  !/>\s*Start Test\s*</.test(pub),
  'public.html: no button labeled "Start Test" (public must have zero action buttons)',
);

// ─── 6. No >Start Test< button label in live.html ───────────────────────────
console.log('6. live.html: no ">Start Test<" button label...');
assert(
  !/>\s*Start Test\s*</.test(live),
  'live.html: no button labeled "Start Test"',
);

// ─── 7. No >Resume< action button in public.html ────────────────────────────
// "Resume" as a standalone button label would let public restart a stopped run.
// We match the button-content form to avoid hitting aria-label or title attrs.
console.log('7. public.html: no ">Resume<" action button...');
assert(
  !/>\s*Resume\s*</.test(pub),
  'public.html: no button labeled "Resume"',
);

// ─── 8. No >Resume< action button in live.html ──────────────────────────────
console.log('8. live.html: no ">Resume<" action button...');
assert(
  !/>\s*Resume\s*</.test(live),
  'live.html: no button labeled "Resume"',
);

// ─── 9. No >Rescan< action button in public.html ────────────────────────────
console.log('9. public.html: no ">Rescan<" action button...');
assert(
  !/>\s*Rescan\s*</.test(pub),
  'public.html: no button labeled "Rescan"',
);

// ─── 10. No >Rescan< action button in live.html ──────────────────────────────
console.log('10. live.html: no ">Rescan<" action button...');
assert(
  !/>\s*Rescan\s*</.test(live),
  'live.html: no button labeled "Rescan"',
);

// ─── 11. No >Retest< action button in public.html ───────────────────────────
// Matches "Retest Failed", "Retest Nodes", etc.
console.log('11. public.html: no ">Retest..." action button...');
assert(
  !/>\s*Retest/.test(pub),
  'public.html: no button starting with "Retest"',
);

// ─── 12. No >Retest< action button in live.html ─────────────────────────────
console.log('12. live.html: no ">Retest..." action button...');
assert(
  !/>\s*Retest/.test(live),
  'live.html: no button starting with "Retest"',
);

// ─── 13. No >Stop< standalone action button in public.html ───────────────────
// A standalone ">Stop<" button would let public visitors halt a running audit.
// Intentionally narrow pattern (between tags with optional whitespace) to avoid
// false-positives from status text like "Test stopped" or aria attributes.
console.log('13. public.html: no standalone ">Stop<" action button...');
assert(
  !/>\s*Stop\s*</.test(pub),
  'public.html: no button labeled "Stop" (public must not be able to halt an audit)',
);

// ─── 14. No >Stop< standalone action button in live.html ─────────────────────
console.log('14. live.html: no standalone ">Stop<" action button...');
assert(
  !/>\s*Stop\s*</.test(live),
  'live.html: no button labeled "Stop"',
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
