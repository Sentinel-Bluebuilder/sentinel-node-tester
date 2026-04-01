var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var fails = d.filter(function(r) { return r.error; });

console.log('=== FAILURE AUDIT: OUR FAULT vs NODE FAULT ===\n');

var ourFault = [];
var nodeFault = [];
var unclear = [];

fails.forEach(function(r) {
  var err = r.error || '';
  var cat;
  if (err.indexOf('sequence mismatch') !== -1) {
    cat = 'OUR FAULT: Sequence mismatch (batch payment race condition)';
    ourFault.push(r);
  } else if (err.indexOf('already exists') !== -1) {
    cat = 'OUR FAULT: Session already exists (stale session handling)';
    ourFault.push(r);
  } else if (err.indexOf('SOCKS5') !== -1) {
    // Need to determine if this is our config or node issue
    unclear.push(r);
    cat = 'NEEDS INVESTIGATION: SOCKS5 unreachable';
  } else if (err.indexOf('v2ray exited') !== -1) {
    cat = 'POSSIBLY OURS: V2Ray crash';
    unclear.push(r);
  } else if (err.indexOf('handshake failed') !== -1 || err.indexOf('Handshake') !== -1) {
    cat = 'NODE: Handshake failed';
    nodeFault.push(r);
  } else if (err.indexOf('offline') !== -1 || err.indexOf('ECONNREFUSED') !== -1 || err.indexOf('ETIMEDOUT') !== -1) {
    cat = 'NODE: Offline/unreachable';
    nodeFault.push(r);
  } else if (err.indexOf('insufficient') !== -1 || err.indexOf('balance') !== -1) {
    cat = 'OUR FAULT: Insufficient balance';
    ourFault.push(r);
  } else {
    cat = 'UNKNOWN';
    unclear.push(r);
  }

  var inPlan = r.inPlan ? ' [IN PLAN]' : '';
  console.log(cat + inPlan);
  console.log('  ' + r.address.slice(0, 50));
  console.log('  moniker: ' + (r.moniker || '?') + ' | type: ' + (r.type || '?'));
  console.log('  err: ' + err.slice(0, 120));
  console.log('');
});

console.log('=== SUMMARY ===');
console.log('Total failures:', fails.length);
console.log('OUR FAULT:', ourFault.length, '(' + ourFault.filter(function(r){return r.inPlan}).length + ' in-plan)');
console.log('NODE FAULT:', nodeFault.length, '(' + nodeFault.filter(function(r){return r.inPlan}).length + ' in-plan)');
console.log('UNCLEAR:', unclear.length, '(' + unclear.filter(function(r){return r.inPlan}).length + ' in-plan)');

// Estimate token waste
console.log('\n=== TOKEN WASTE ESTIMATE ===');
var wastedNodes = ourFault.length;
// Each test: ~1GB session + gas (~400000 udvpn total)
console.log('Wasted sessions (our fault):', wastedNodes);
console.log('Est. waste:', wastedNodes + ' sessions x ~400000 udvpn = ~' + (wastedNodes * 400000 / 1000000).toFixed(2) + ' DVPN');

// Check if any "our fault" failures were retested (burning more tokens)
var retested = fails.filter(function(r) { return r.error && r.error.indexOf('retest:') === 0; });
console.log('Retested failures:', retested.length, '(additional token spend per retest)');
