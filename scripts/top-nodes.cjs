const fs = require('fs');
const data = JSON.parse(fs.readFileSync('results/results.json', 'utf8'));
const sorted = data.filter(r => r.actualMbps > 0).sort((a, b) => b.actualMbps - a.actualMbps).slice(0, 15);
sorted.forEach((r, i) => {
  const num = String(i + 1).padStart(2);
  const speed = r.actualMbps.toFixed(1).padStart(6);
  console.log(num + '. ' + speed + ' Mbps | ' + r.type + ' | ' + (r.city || '?') + ', ' + (r.country || '?') + ' | ' + r.address);
});
