const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));
const uncapped = r.filter(x => x.actualMbps != null && x.baselineAtTest != null && x.actualMbps > x.baselineAtTest);
console.log('Uncapped nodes:', uncapped.length);
uncapped.forEach(x => console.log(
  x.actualMbps.toFixed(2), '/', x.baselineAtTest.toFixed(2),
  x.city, x.type, x.timestamp
));
