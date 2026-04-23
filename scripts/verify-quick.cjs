/**
 * Quick synchronous verification using CommonJS + better-sqlite3 directly.
 * Run: node scripts/verify-quick.cjs
 * Output is written to: scripts/verify-output.txt
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'audit.db');
const OUT_PATH = path.join(__dirname, 'verify-output.txt');
// Truncate/create at start
fs.writeFileSync(OUT_PATH, '', 'utf8');
const lines = [];
const log = (...args) => {
  const line = args.join(' ');
  console.log(line);
  lines.push(line);
  // Write immediately so partial output is readable if script hangs
  fs.appendFileSync(OUT_PATH, line + '\n', 'utf8');
};

try {
  const db = new Database(DB_PATH, { readonly: true });

  // Row counts
  const runsCount = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
  const resultsCount = db.prepare('SELECT COUNT(*) AS n FROM results').get().n;
  let errorLogsCount = 0;
  try {
    errorLogsCount = db.prepare('SELECT COUNT(*) AS n FROM error_logs').get().n;
  } catch (e) {
    log('error_logs table not found:', e.message);
  }

  log('\n=== Row Counts ===');
  log('runs:      ', runsCount);
  log('results:   ', resultsCount);
  log('error_logs:', errorLogsCount);

  // Schema check
  const cols = db.prepare('PRAGMA table_info(results)').all().map(c => c.name);
  log('\n=== results columns ===');
  log(cols.join(', '));
  log('pass column: ', cols.includes('pass') ? 'YES' : 'MISSING');
  log('stage column:', cols.includes('stage') ? 'YES' : 'MISSING');

  // Sample data
  const sample = db.prepare(`
    SELECT r.node_addr, r.country, r.pass, r.stage, r.actual_mbps, r.tested_at
    FROM results r
    ORDER BY r.tested_at DESC
    LIMIT 5
  `).all();
  log('\n=== Latest 5 results ===');
  sample.forEach(row => {
    log(`  ${row.node_addr} | country=${row.country} | pass=${row.pass} | stage=${row.stage} | mbps=${row.actual_mbps}`);
  });

  // pass_bar manual check (get last 25 results for first node)
  const firstNode = sample[0]?.node_addr;
  if (firstNode) {
    const hist = db.prepare(`
      SELECT pass FROM results
      WHERE node_addr = ?
      ORDER BY tested_at DESC
      LIMIT 25
    `).all(firstNode);
    const bar = hist.map(h => h.pass ?? null).reverse();
    log('\n=== pass_bar for first node ===');
    log('node_addr:', firstNode);
    log('bar length:', bar.length, '(want 25)');
    log('bar:', JSON.stringify(bar));
  }

  // Error logs sample
  if (errorLogsCount > 0) {
    const errSample = db.prepare(`
      SELECT el.id, el.stage, el.error_code, el.error_message, el.result_id
      FROM error_logs el
      LIMIT 3
    `).all();
    log('\n=== error_logs sample (3 rows) ===');
    errSample.forEach(row => {
      log(`  id=${row.id} result_id=${row.result_id} stage=${row.stage} code=${row.error_code}`);
      log(`    msg: ${(row.error_message || '').slice(0, 80)}`);
    });
  }

  // Country list
  const countries = db.prepare(`
    SELECT country, COUNT(DISTINCT node_addr) AS node_count
    FROM (
      SELECT node_addr, country
      FROM results
      WHERE tested_at = (SELECT MAX(tested_at) FROM results r2 WHERE r2.node_addr = results.node_addr)
        AND country IS NOT NULL AND country != ''
    )
    GROUP BY country
    ORDER BY node_count DESC
    LIMIT 5
  `).all();
  log('\n=== Top 5 countries ===');
  countries.forEach(c => log(`  ${c.country}: ${c.node_count} nodes`));

  db.close();
  log('\n=== Verification COMPLETE ===');

} catch (err) {
  log('FATAL ERROR:', err.message);
  log(err.stack);
}

// Final flush (already written line by line above, this is a no-op safety)
// fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8');
