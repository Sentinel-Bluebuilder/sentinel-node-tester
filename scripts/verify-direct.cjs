/**
 * Minimal verification — writes ONLY to file, no console output.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'audit.db');
const OUT_PATH = path.join(__dirname, '..', 'verify-result.txt');

const out = [];

try {
  const db = new Database(DB_PATH, { readonly: true });

  const runsCount    = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
  const resultsCount = db.prepare('SELECT COUNT(*) AS n FROM results').get().n;
  let errCount = 0;
  try { errCount = db.prepare('SELECT COUNT(*) AS n FROM error_logs').get().n; } catch {}

  out.push('=== Row Counts ===');
  out.push('runs=' + runsCount);
  out.push('results=' + resultsCount);
  out.push('error_logs=' + errCount);

  const cols = db.prepare('PRAGMA table_info(results)').all().map(c => c.name);
  out.push('');
  out.push('=== results schema ===');
  out.push(cols.join(', '));
  out.push('pass=' + (cols.includes('pass') ? 'YES' : 'MISSING'));
  out.push('stage=' + (cols.includes('stage') ? 'YES' : 'MISSING'));

  const sample = db.prepare(`
    SELECT node_addr, country, pass, stage, actual_mbps, tested_at
    FROM results ORDER BY tested_at DESC LIMIT 5
  `).all();
  out.push('');
  out.push('=== Latest 5 results ===');
  sample.forEach(r => out.push(
    `  ${r.node_addr} | country=${r.country} | pass=${r.pass} | stage=${r.stage} | mbps=${r.actual_mbps}`
  ));

  const firstNode = sample[0] && sample[0].node_addr;
  if (firstNode) {
    const hist = db.prepare(`
      SELECT pass FROM results WHERE node_addr=? ORDER BY tested_at DESC LIMIT 25
    `).all(firstNode);
    const bar = hist.map(h => h.pass != null ? h.pass : null).reverse();
    out.push('');
    out.push('=== pass_bar ===');
    out.push('addr=' + firstNode);
    out.push('length=' + bar.length + ' (want up to 25)');
    out.push('bar=' + JSON.stringify(bar));
  }

  if (errCount > 0) {
    const es = db.prepare(`
      SELECT id, stage, error_code, error_message, result_id FROM error_logs LIMIT 3
    `).all();
    out.push('');
    out.push('=== error_logs sample ===');
    es.forEach(e => {
      out.push(`  id=${e.id} result_id=${e.result_id} stage=${e.stage} code=${e.error_code}`);
      out.push(`    msg: ${(e.error_message || '').slice(0, 100)}`);
    });
  }

  const countries = db.prepare(`
    SELECT country, COUNT(DISTINCT node_addr) AS node_count
    FROM (
      SELECT node_addr, country
      FROM results
      WHERE tested_at = (SELECT MAX(tested_at) FROM results r2 WHERE r2.node_addr = results.node_addr)
        AND country IS NOT NULL AND country != ''
    )
    GROUP BY country ORDER BY node_count DESC LIMIT 5
  `).all();
  out.push('');
  out.push('=== Top 5 countries ===');
  countries.forEach(c => out.push(`  ${c.country}: ${c.node_count} nodes`));

  db.close();
  out.push('');
  out.push('=== COMPLETE ===');
} catch (err) {
  out.push('FATAL: ' + err.message);
  out.push(err.stack || '');
}

fs.writeFileSync(OUT_PATH, out.join('\n') + '\n');
process.exit(0);
