var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var socks = d.filter(function(r) { return r.error && r.error.indexOf('SOCKS5') !== -1 && r.diag && r.diag.v2rayConfig; });

socks.forEach(function(r) {
  console.log('=== ' + r.address.slice(0, 40) + ' ===');
  console.log(JSON.stringify(r.diag.v2rayConfig, null, 2));
  console.log('\n');
});
