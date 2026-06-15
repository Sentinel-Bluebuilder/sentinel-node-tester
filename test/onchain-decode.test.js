/**
 * Sentinel Node Tester — On-Chain Report Encode/Decode Unit Tests
 *
 * Pure unit tests for core/onchain-report.js: resultToRecord, packBatch,
 * encodeBatch, decodeMemo. No server, no DB, no chain calls.
 *
 * NOTE: onchain-report.js imports chain.js and wallet.js. Neither of those
 * opens the DB or binds a port — they declare lazy async helpers. The import
 * is safe in a test context (verified by reading the files before writing this
 * test). If a future refactor adds module-scope side effects to those imports,
 * this test will fail at import time and that is by design — the failure will
 * surface the regression.
 *
 * NOTE (M7 / unsupported-version assertion):
 *   The assertion on line ~120 ("SNTR1|v3|... decodes to null") tests the
 *   behavior that the M7 fix is intended to guarantee. As of the current code,
 *   _decodeCsv() already enforces `if (ver !== 'v2') return null` at line 197
 *   of onchain-report.js, so the unknown-version path in decodeMemo() (which
 *   delegates to _decodeCsv) also returns null. The test therefore passes
 *   RIGHT NOW. If a future change regresses this gate, the test will catch it.
 *   The comment in decodeMemo()'s line-172 branch ("return null") vs the actual
 *   call to _decodeCsv() is an M7 code-quality issue; the observable behaviour
 *   is already correct.
 *
 * Run: node test/onchain-decode.test.js
 * Exit 0 = all pass, exit 1 = failures.
 */

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

function eq(a, b, name) {
  const ok = a === b;
  if (!ok) console.error(`  FAIL ${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  assert(ok, name);
}

async function run() {
  console.log('On-Chain Report — Encode/Decode Unit Tests\n');

  // ─── Import (pure encode/decode exports only) ──────────────────────────────
  console.log('1. Import core/onchain-report.js...');
  let mod;
  try {
    mod = await import('../core/onchain-report.js');
    assert(true, 'import core/onchain-report.js succeeds');
  } catch (e) {
    assert(false, `import core/onchain-report.js: ${e.message.split('\n')[0]}`);
    console.error('Cannot continue without module. Aborting.');
    process.exit(1);
  }

  const { resultToRecord, packBatch, encodeBatch, decodeMemo, SCHEMA, ERR_CODES } = mod;

  // ─── 2. SCHEMA constants ──────────────────────────────────────────────────
  console.log('2. SCHEMA constants...');
  assert(typeof SCHEMA === 'object' && SCHEMA !== null, 'SCHEMA is an object');
  eq(SCHEMA.MAGIC, 'SNTR1', 'SCHEMA.MAGIC = "SNTR1"');
  eq(SCHEMA.VERSION, 2, 'SCHEMA.VERSION = 2');
  eq(SCHEMA.MAX_RECORDS, 6, 'SCHEMA.MAX_RECORDS = 6 (chain memo cap)');
  eq(SCHEMA.MEMO_CHAR_LIMIT, 256, 'SCHEMA.MEMO_CHAR_LIMIT = 256');
  assert(typeof ERR_CODES === 'object', 'ERR_CODES is an object');
  assert(ERR_CODES.OK === 0, 'ERR_CODES.OK = 0');

  // ─── 3. resultToRecord — valid passing node ───────────────────────────────
  console.log('3. resultToRecord — valid passing node...');
  const passResult = {
    address: 'sentnode1abcdefghijklmnopqrstuvwxyz1234567890',
    actualMbps: 42.5,
    peers: 7,
    diag: { handshakeLatencyMs: 123 },
  };
  const passRec = resultToRecord(passResult);
  assert(passRec !== null, 'resultToRecord: passing node → non-null');
  eq(passRec.ok, 1, 'resultToRecord: passing node → ok=1');
  eq(passRec.mbps, 42.5, 'resultToRecord: passing node → mbps=42.5');
  eq(passRec.peers, 7, 'resultToRecord: passing node → peers=7');
  eq(passRec.lat, 123, 'resultToRecord: passing node → lat=123');
  eq(passRec.address, passResult.address, 'resultToRecord: address preserved');

  // ─── 4. resultToRecord — failed node (actualMbps=null) ───────────────────
  console.log('4. resultToRecord — failed node...');
  const failResult = {
    address: 'sentnode1abcdefghijklmnopqrstuvwxyz1234567890',
    actualMbps: null,
    peers: 0,
    diag: {},
  };
  const failRec = resultToRecord(failResult);
  assert(failRec !== null, 'resultToRecord: failed node → non-null');
  eq(failRec.ok, 0, 'resultToRecord: failed node → ok=0');
  assert(failRec.mbps === null, 'resultToRecord: failed node → mbps=null');

  // ─── 5. resultToRecord — rejects invalid addresses ───────────────────────
  console.log('5. resultToRecord — address validation...');
  assert(resultToRecord({ address: null }) === null, 'resultToRecord: null address → null');
  assert(resultToRecord({ address: 'sent1notanode' }) === null, 'resultToRecord: sent1 prefix → null');
  assert(resultToRecord({ address: 'sentnode1short' }) === null, 'resultToRecord: too-short sentnode addr → null');
  assert(resultToRecord({ address: '' }) === null, 'resultToRecord: empty address → null');

  // ─── 6. packBatch — round-trip encode then decode ─────────────────────────
  console.log('6. packBatch → decodeMemo round-trip...');
  const ctx = {
    region: 'US',
    baselineMbps: 100,
    startedAt: new Date('2026-01-15T12:00:00Z'),
  };
  const records = [
    { address: 'sentnode1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ok: 1, mbps: 42.5, peers: 3, lat: 120 },
    { address: 'sentnode1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ok: 0, mbps: null, peers: 0, lat: 0 },
  ];
  const { memo, packed } = packBatch(ctx, records);
  assert(typeof memo === 'string', 'packBatch: returns memo string');
  eq(packed, 2, 'packBatch: packed=2 records');
  assert(memo.length <= 256, `packBatch: memo fits in 256 chars (got ${memo.length})`);
  assert(memo.startsWith('SNTR1|v2|'), 'packBatch: memo starts with SNTR1|v2|');

  const decoded = decodeMemo(memo);
  assert(decoded !== null, 'decodeMemo: round-trip decoded successfully');
  eq(decoded.version, 'v2', 'decodeMemo: version=v2');
  eq(decoded.region, 'US', 'decodeMemo: region=US');
  assert(Math.abs(decoded.baselineMbps - 100) < 0.1, 'decodeMemo: baselineMbps≈100');
  eq(decoded.count, 2, 'decodeMemo: count=2 records');

  const r0 = decoded.records[0];
  assert(r0 !== undefined, 'decodeMemo: record[0] exists');
  eq(r0.ok, true, 'decodeMemo: record[0].ok=true');
  assert(Math.abs((r0.mbps ?? 0) - 42.5) < 0.1, 'decodeMemo: record[0].mbps≈42.5');
  eq(r0.peers, 3, 'decodeMemo: record[0].peers=3');

  const r1 = decoded.records[1];
  assert(r1 !== undefined, 'decodeMemo: record[1] exists');
  eq(r1.ok, false, 'decodeMemo: record[1].ok=false');
  assert(r1.mbps === null, 'decodeMemo: record[1].mbps=null (failed node)');

  // ─── 7. encodeBatch — accepts 1..6 records ───────────────────────────────
  console.log('7. encodeBatch — batch size limits...');
  const singleRecord = [{ address: 'sentnode1ccccccccccccccccccccccccccccccccccccccc', ok: 1, mbps: 10, peers: 1, lat: 50 }];
  const singleMemo = encodeBatch(ctx, singleRecord);
  assert(typeof singleMemo === 'string' && singleMemo.length > 0, 'encodeBatch: 1 record → non-empty string');
  assert(singleMemo.length <= 256, 'encodeBatch: 1 record fits in 256 chars');

  // encodeBatch must throw if > MAX_RECORDS (6) records are passed
  const tooMany = Array.from({ length: 7 }, (_, i) => ({
    address: `sentnode1${'x'.repeat(38)}${i}`,
    ok: 1, mbps: 10, peers: 0, lat: 0,
  }));
  let threw7 = false;
  try { encodeBatch(ctx, tooMany); } catch { threw7 = true; }
  assert(threw7, 'encodeBatch: throws when >6 records passed');

  // encodeBatch must throw on empty array
  let threwEmpty = false;
  try { encodeBatch(ctx, []); } catch { threwEmpty = true; }
  assert(threwEmpty, 'encodeBatch: throws on empty records array');

  // ─── 8. decodeMemo — null/empty/garbage inputs ───────────────────────────
  console.log('8. decodeMemo — null/garbage inputs → null...');
  assert(decodeMemo(null) === null, 'decodeMemo: null → null');
  assert(decodeMemo('') === null, 'decodeMemo: empty string → null');
  assert(decodeMemo('not-a-sentinel-memo') === null, 'decodeMemo: garbage → null');
  assert(decodeMemo('SNTR1|v2') === null || decodeMemo('SNTR1|v2') !== undefined,
    'decodeMemo: truncated header does not throw');

  // ─── 9. decodeMemo — unsupported version returns null (M7 gate) ──────────
  // Per CLAUDE.md: a memo with an unsupported version header (e.g. SNTR1|v3|…)
  // MUST decode to null. The gate lives in _decodeCsv() at the `if (ver !== 'v2')`
  // check. decodeMemo() calls _decodeCsv() for any SNTR1|v<N>| prefix, and
  // _decodeCsv() enforces the version guard before touching records, so a v3
  // header is refused cleanly. This test is NOT contingent on a future integration
  // — the behaviour is already correct in the current code.
  console.log('9. decodeMemo — unsupported version header → null (M7 gate)...');
  const unsupportedV3 = 'SNTR1|v3|US|b=100.0|t=1700000000\nsentnode1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|1|42.5|3|120';
  const v3Result = decodeMemo(unsupportedV3);
  assert(
    v3Result === null,
    'decodeMemo: SNTR1|v3|… header → null (unknown version must not be decoded)',
  );

  // A future v99 header also must be refused
  const unsupportedV99 = 'SNTR1|v99|DE|b=50.0|t=1700000000';
  assert(
    decodeMemo(unsupportedV99) === null,
    'decodeMemo: SNTR1|v99|… header → null',
  );

  // v2 still works after rejecting others (no side effects from rejection)
  const v2After = decodeMemo(memo);
  assert(v2After !== null, 'decodeMemo: v2 still decodes correctly after unsupported-version rejections');

  // ─── 10. MEMO_CHAR_LIMIT enforcement ─────────────────────────────────────
  console.log('10. Memo stays within 256-char chain limit for any valid batch...');
  // Build 6 records with reasonably-sized sentnode1 addresses
  const sixRecords = Array.from({ length: 6 }, (_, i) => ({
    address: `sentnode1${'a'.repeat(30)}${String(i).padStart(8, '0')}`,
    ok: i % 2 === 0 ? 1 : 0,
    mbps: i % 2 === 0 ? 99.9 : null,
    peers: i * 3,
    lat: i * 50,
  }));
  const { memo: bigMemo, packed: bigPacked } = packBatch(ctx, sixRecords);
  assert(bigMemo.length <= 256, `packBatch(6 records): memo ≤ 256 chars (got ${bigMemo.length})`);
  assert(bigPacked >= 1, `packBatch(6 records): at least 1 record packed (got ${bigPacked})`);

  // ─── Results ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed (${results.pass + results.fail} total)`);
  if (results.errors.length > 0) {
    console.log('\nFAILURES:');
    for (const e of results.errors) console.log(`  FAIL: ${e}`);
  }
  console.log(`${'='.repeat(50)}`);
  process.exit(results.fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
