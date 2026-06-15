/**
 * Sentinel Node Tester — Failure error_code classification regression tests
 *
 * Root cause this guards (2026-06): buildFailResult() set `error` (the message)
 * but never set `errorCode`, so batch_results.error_code landed NULL and
 * error_logs.error_code fell back to 'UNKNOWN' for every real failure — the
 * per-row failure-copy block (a product MUST) showed "Error code: UNKNOWN".
 * Real prod failures looked like:
 *   connect EHOSTUNREACH 198.51.100.1:21045   -> must map to HOST_UNREACH
 *   Node test timed out                        -> must map to TIMEOUT
 *   … TKD handshake HTTP 500: {…}              -> must map to HTTP_ERROR
 *
 * These tests extract the pure classifyProbeError() from pipeline.js by source
 * (no native imports, no DB, no server) and assert the mappings, plus a static
 * check that buildFailResult wires classifyProbeError into errorCode.
 *
 * Run: node test/error-code-classification.test.js
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const src = readFileSync(path.join(ROOT, 'audit/pipeline.js'), 'utf8');

const results = { pass: 0, fail: 0 };
function ok(cond, name) {
  if (cond) { results.pass++; console.log(`  PASS  ${name}`); }
  else { results.fail++; console.error(`  FAIL  ${name}`); }
}

// ─── Extract the pure classifyProbeError(err) function from source ───────────
// It references only locals (err/msg/code) so it can be evaluated standalone.
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find function ${name}`);
  // Find the body's opening brace by first balancing the parameter-list parens,
  // so a default param like `diag = {}` in the signature is NOT mistaken for the
  // function body's `{` (that bug silently truncated buildFailResult).
  const parenOpen = src.indexOf('(', start);
  let pd = 0, bodyOpen = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') { pd--; if (pd === 0) { bodyOpen = src.indexOf('{', i); break; } }
  }
  if (bodyOpen === -1) throw new Error(`could not find body open for ${name}`);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const body = src.slice(start, i + 1);
        if (!body.startsWith(`function ${name}(`)) throw new Error('mis-extracted ' + name);
        return body;
      }
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const classifyBody = extractFn('classifyProbeError');
const classifyProbeError = new Function(`${classifyBody}; return classifyProbeError;`)();

console.log('Failure error_code classification — regression tests\n');

// ─── 1. The three real prod failure shapes map to stable codes ───────────────
console.log('1. observed prod failure messages map to real codes');
ok(classifyProbeError({ message: 'connect EHOSTUNREACH 198.51.100.1:21045' }) === 'HOST_UNREACH',
  "'connect EHOSTUNREACH …' -> HOST_UNREACH");
ok(classifyProbeError({ message: 'Node test timed out' }) === 'TIMEOUT',
  "'Node test timed out' -> TIMEOUT (the 'timed out' wording fix)");
ok(classifyProbeError({ message: '409 persistent even after fresh session: TKD handshake HTTP 500: {"suc' }) === 'HTTP_ERROR',
  "'… HTTP 500 …' -> HTTP_ERROR");

// ─── 2. Code-based + other branches still classify ───────────────────────────
console.log('\n2. code-based branches + non-null fallback');
ok(classifyProbeError({ message: 'whatever', code: 'ETIMEDOUT' }) === 'TIMEOUT', "code ETIMEDOUT -> TIMEOUT");
ok(classifyProbeError({ message: 'connect ECONNREFUSED 1.2.3.4:5' }) === 'TCP_REFUSED', "ECONNREFUSED -> TCP_REFUSED");
ok(classifyProbeError({ message: 'getaddrinfo ENOTFOUND host' }) === 'DNS_FAIL', "ENOTFOUND -> DNS_FAIL");
ok(classifyProbeError({ message: 'some unrecognized failure' }) === 'OTHER', "unknown -> OTHER (never null)");
ok(typeof classifyProbeError({ message: '' }) === 'string' && classifyProbeError({ message: '' }).length > 0,
  "empty message still yields a non-empty code");

// ─── 3. buildFailResult wires classifyProbeError into errorCode ──────────────
console.log('\n3. buildFailResult sets errorCode (static wiring check)');
// Extract the exact function bodies (robust to layout/length changes) rather
// than slicing fixed char windows — see code-quality review of 9fedfbe.
const bfrBody = extractFn('buildFailResult');
ok(/errorCode:\s*classifyProbeError\(/.test(bfrBody),
  'buildFailResult assigns errorCode: classifyProbeError(...)');
ok(/timed out/.test(classifyBody),
  "classifyProbeError timeout branch also matches 'timed out'");

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n============================================================`);
console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed (${results.pass + results.fail} total)`);
console.log(`============================================================`);
process.exit(results.fail === 0 ? 0 : 1);
