var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var fails = d.filter(function(r) { return r.error; });
console.log('All ' + fails.length + ' failures:');
fails.forEach(function(r) {
  console.log(r.address + ' | inPlan=' + r.inPlan + ' | peers=' + r.peers + ' | ' + (r.error || '').slice(0, 80));
});
