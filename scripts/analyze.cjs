const data = require('./results/results.json');
const nodes = Array.isArray(data) ? data : Object.values(data);

console.log('=== TOTAL NODES TESTED ===');
console.log('Total:', nodes.length);

const hasError = nodes.filter(n => n.error);
const noError = nodes.filter(n => (n.error === undefined || n.error === null || n.error === ''));
console.log('\n=== SUCCESS vs FAILURE ===');
console.log('Succeeded (no error field or empty):', noError.length);
console.log('Failed (has error):', hasError.length);

// Breakdown of error reasons
const errorReasons = {};
hasError.forEach(n => {
  let key = String(n.error || 'unknown');
  if (key.length > 120) key = key.substring(0, 120) + '...';
  errorReasons[key] = (errorReasons[key] || 0) + 1;
});

console.log('\n=== FAILURE REASONS (sorted by count) ===');
const sorted = Object.entries(errorReasons).sort((a, b) => b[1] - a[1]);
sorted.forEach(([reason, count]) => {
  console.log(count.toString().padStart(4) + '  ' + reason);
});

// All unique keys
const allKeys = new Set();
nodes.forEach(n => Object.keys(n).forEach(k => allKeys.add(k)));
console.log('\n=== ALL UNIQUE KEYS ===');
console.log([...allKeys].join(', '));

// Type breakdown
const types = {};
nodes.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
console.log('\n=== NODE TYPES ===');
Object.entries(types).sort((a,b) => b[1] - a[1]).forEach(([t, c]) => console.log(c.toString().padStart(4) + '  ' + t));

// "Active" LCD nodes that respond to status - need to check what this means
// If a node is in results.json it was reachable on LCD. Let's check if there's a statusCheck or similar field.
// Check for any field containing "status"
const statusFields = [...allKeys].filter(k => k.toLowerCase().includes('status'));
console.log('\n=== STATUS-RELATED FIELDS ===');
console.log(statusFields.length ? statusFields.join(', ') : 'None found');

// Check for lcdStatus or similar
const lcdFields = [...allKeys].filter(k => k.toLowerCase().includes('lcd'));
console.log('\n=== LCD-RELATED FIELDS ===');
console.log(lcdFields.length ? lcdFields.join(', ') : 'None found');
