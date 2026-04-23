const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'verify-result.txt');

try {
  const Database = require('better-sqlite3');
  fs.writeFileSync(OUT, 'Database loaded OK\n');
  const db = new Database(path.join(__dirname, '..', 'data', 'audit.db'), { readonly: true });
  const n = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
  fs.appendFileSync(OUT, 'runs=' + n + '\n');
  const r = db.prepare('SELECT COUNT(*) AS n FROM results').get().n;
  fs.appendFileSync(OUT, 'results=' + r + '\n');
  let e = 0;
  try { e = db.prepare('SELECT COUNT(*) AS n FROM error_logs').get().n; } catch {}
  fs.appendFileSync(OUT, 'error_logs=' + e + '\n');
  const cols = db.prepare('PRAGMA table_info(results)').all().map(c => c.name);
  fs.appendFileSync(OUT, 'columns=' + cols.join(',') + '\n');
  fs.appendFileSync(OUT, 'pass=' + (cols.includes('pass') ? 'YES' : 'MISSING') + '\n');
  fs.appendFileSync(OUT, 'stage=' + (cols.includes('stage') ? 'YES' : 'MISSING') + '\n');
  db.close();
  fs.appendFileSync(OUT, 'DONE\n');
} catch (err) {
  fs.writeFileSync(OUT, 'ERROR: ' + err.message + '\n' + (err.stack || '') + '\n');
}
