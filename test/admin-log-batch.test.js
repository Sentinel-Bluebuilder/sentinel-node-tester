/**
 * Admin log-replay — main-thread regression test
 *
 * Bug: opening admin.html replayed the server log buffer (up to
 * LOG_BUFFER_MAX = 5000 lines) by calling appendLog() once per line. Each
 * appendLog set `body.scrollTop = body.scrollHeight`, a forced synchronous
 * reflow — so a full buffer meant ~5000 reflows on page load and the tab froze.
 * It also built 5000 DOM nodes only to trim back to 500.
 *
 * Fix: appendLogBatch() builds the (last 500) lines into one DocumentFragment
 * and inserts + scrolls exactly once. This test runs the REAL functions from
 * admin.html against a fake DOM and asserts the work is O(cap), single-reflow.
 *
 * Run: node test/admin-log-batch.test.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const out = { pass: 0, fail: 0, errors: [] };
function ok(cond, name) {
  if (cond) { out.pass++; console.log(`  PASS  ${name}`); }
  else      { out.fail++; out.errors.push(name); console.log(`  FAIL  ${name}`); }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'admin.html'), 'utf8');

// Extract a `function NAME(...) { ... }` block by balanced-brace scan. The
// admin.html log helpers only contain balanced braces (template `${}` pairs),
// so a simple depth counter is sufficient here.
function extractFn(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found in admin.html`);
  let depth = 0, started = false, j = m.index;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(m.index, j);
}

const FNS = ['escHtml', 'logCategory', '_logEntryMatches', '_buildLogEntry', 'appendLog', 'appendLogBatch'];
const extracted = FNS.map(n => extractFn(html, n)).join('\n\n');

// ─── Fake DOM ──────────────────────────────────────────────────────────────
let createElementCount = 0;
let createFragCount = 0;

function makeNode(tag) {
  const node = {
    tagName: tag,
    dataset: {},
    style: {},
    _children: [],
    _scrollWrites: 0,
    className: '',
    innerHTML: '',
    scrollHeight: 1000,
    __isFrag: tag === '#fragment',
    get children() { return this._children; },
    get firstChild() { return this._children[0]; },
    appendChild(c) {
      if (c && c.__isFrag) { for (const cc of c._children) this._children.push(cc); c._children = []; }
      else this._children.push(c);
      return c;
    },
    insertBefore(c) { this._children.unshift(c); return c; },
    removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
  };
  // Count writes to scrollTop — each write is a forced reflow in the browser.
  let _scrollTop = 0;
  Object.defineProperty(node, 'scrollTop', {
    get() { return _scrollTop; },
    set(v) { _scrollTop = v; node._scrollWrites++; },
  });
  return node;
}

const logBody = makeNode('div');
const fakeDocument = {
  getElementById(id) { return id === 'logBody' ? logBody : null; },
  createElement(tag) { createElementCount++; return makeNode(tag); },
  createDocumentFragment() { createFragCount++; return makeNode('#fragment'); },
};

const sandbox = {
  document: fakeDocument,
  _logFilter: 'all',
  LOG_DOM_MAX: 500,
  Date,
  console,
};
vm.createContext(sandbox);
vm.runInContext(extracted, sandbox);

const LOG_DOM_MAX = 500;

console.log('\nAdmin log-replay — main-thread regression\n');

// ─── 1. Full 5000-line buffer: O(cap) work, single reflow ────────────────────
console.log('[1] appendLogBatch(5000 lines) is bounded + single-reflow');
const big = Array.from({ length: 5000 }, (_, i) => `line ${i} — node sentnode1${i}`);
createElementCount = 0; createFragCount = 0; logBody._scrollWrites = 0;
vm.runInContext('appendLogBatch(globalThis.__big)', Object.assign(sandbox, { __big: big }));

ok(logBody.children.length === LOG_DOM_MAX,
   `DOM capped at ${LOG_DOM_MAX} rows (got ${logBody.children.length})`);
ok(logBody._scrollWrites === 1,
   `exactly ONE reflow for the whole buffer (got ${logBody._scrollWrites})`);
ok(createElementCount === LOG_DOM_MAX,
   `builds only ${LOG_DOM_MAX} nodes, not 5000 (got ${createElementCount})`);
ok(createFragCount === 1, `uses one DocumentFragment (got ${createFragCount})`);
// Only the LAST 500 lines are kept (matches the cap the live path enforces).
ok(logBody.children[logBody.children.length - 1].innerHTML.includes('line 4999'),
   'keeps the newest line (4999) at the tail');
ok(logBody.children[0].innerHTML.includes('line 4500'),
   'oldest kept line is 4500 (last 500 of 5000)');

// ─── 2. Small buffer: appends all, still single reflow ───────────────────────
console.log('[2] appendLogBatch(small buffer) appends all, single reflow');
logBody._children = []; createElementCount = 0; logBody._scrollWrites = 0;
const small = ['alpha', 'bravo', 'charlie'];
vm.runInContext('appendLogBatch(globalThis.__small)', Object.assign(sandbox, { __small: small }));
ok(logBody.children.length === 3, `appended all 3 (got ${logBody.children.length})`);
ok(logBody._scrollWrites === 1, `single reflow (got ${logBody._scrollWrites})`);

// ─── 3. Guards ───────────────────────────────────────────────────────────────
console.log('[3] guards: empty / non-array are no-ops');
logBody._children = []; logBody._scrollWrites = 0;
vm.runInContext('appendLogBatch([]); appendLogBatch(null); appendLogBatch(undefined)', sandbox);
ok(logBody.children.length === 0, 'no rows added for empty/null/undefined');
ok(logBody._scrollWrites === 0, 'no reflow for empty/null/undefined');

// ─── 4. Live single-line appendLog still trims to cap ────────────────────────
console.log('[4] appendLog single-line path stays bounded');
logBody._children = [];
for (let i = 0; i < 600; i++) {
  vm.runInContext(`appendLog(globalThis.__m)`, Object.assign(sandbox, { __m: `live ${i}` }));
}
ok(logBody.children.length === LOG_DOM_MAX,
   `single-line appends trim to ${LOG_DOM_MAX} (got ${logBody.children.length})`);

console.log(`\n${'='.repeat(60)}\nRESULTS: ${out.pass} passed, ${out.fail} failed (${out.pass + out.fail} total)`);
if (out.errors.length) for (const e of out.errors) console.log(`  FAIL: ${e}`);
console.log('='.repeat(60));
process.exit(out.fail ? 1 : 0);
