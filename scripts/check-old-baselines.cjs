// Check old results from the transcript/backup
const fs = require('fs');
// The results.json should have old data since the server cleared it
// Let me read the jsonl transcript to find old baseline patterns
// Actually let me just check if there's a backup

// Check current results
const r = JSON.parse(fs.readFileSync('results/results.json', 'utf8'));
if (r.length > 0) {
  const bls = r.filter(x => x.baselineAtTest != null).map(x => x.baselineAtTest);
  console.log('Current results:', r.length);
  console.log('Baselines:', bls.map(x => x.toFixed(2)).join(', '));
} else {
  console.log('No results in current file (cleared)');
}
