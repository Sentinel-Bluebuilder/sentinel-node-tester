var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var failed = d.filter(function(r) { return r.error; });
var ok = d.filter(function(r) { return r.actualMbps > 0; });

console.log('Total:', d.length, 'OK:', ok.length, 'Fail:', failed.length);
console.log('');
failed.forEach(function(r) {
  console.log(r.address.slice(0, 50));
  console.log('  Error:', (r.error || '').slice(0, 180));
  console.log('  Timestamp:', r.timestamp || 'none');
  console.log('');
});
