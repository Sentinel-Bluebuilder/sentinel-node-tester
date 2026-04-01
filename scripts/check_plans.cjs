var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var socks = d.filter(function(r) { return r.error && r.error.indexOf('SOCKS5') !== -1; });

console.log('=== REMAINING SOCKS5 FAILURES — PLAN STATUS ===');
socks.forEach(function(r) {
  console.log(r.address.slice(0, 50));
  console.log('  inPlan:', r.inPlan, '| planIds:', JSON.stringify(r.planIds || []));
  console.log('  moniker:', r.moniker, '| peers:', r.peers);
  console.log('');
});

console.log('=== ALL FAILURES SUMMARY ===');
var allFail = d.filter(function(r) { return r.error; });
var inPlan = allFail.filter(function(r) { return r.inPlan; });
console.log('Total failures:', allFail.length);
console.log('In a plan:', inPlan.length);
inPlan.forEach(function(r) {
  console.log('  ' + r.address.slice(0, 50) + ' plans:', JSON.stringify(r.planIds));
});
