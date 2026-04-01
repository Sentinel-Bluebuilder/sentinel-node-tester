var fs = require('fs');
var d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
var failed = d.filter(function(r) { return r.error; });
var ok = d.filter(function(r) { return r.actualMbps > 0; });
var TMAP = { 1:'ds', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'ws' };

console.log('=== OVERVIEW: ' + d.length + ' total, ' + ok.length + ' OK, ' + failed.length + ' FAIL ===\n');

// Categorize failures
var cats = {};
failed.forEach(function(r) {
  var err = r.error || '';
  var cat;
  if (err.indexOf('SOCKS5') !== -1) cat = 'SOCKS5 unreachable';
  else if (err.indexOf('sequence mismatch') !== -1) cat = 'Tx sequence mismatch';
  else if (err.indexOf('already exists') !== -1) cat = 'Tx already exists';
  else if (err.indexOf('v2ray exited') !== -1) cat = 'V2Ray crash';
  else if (err.indexOf('handshake failed') !== -1 || err.indexOf('Handshake') !== -1) cat = 'Handshake failed';
  else if (err.indexOf('offline') !== -1 || err.indexOf('ECONNREFUSED') !== -1 || err.indexOf('ETIMEDOUT') !== -1) cat = 'Node offline';
  else if (err.indexOf('insufficient') !== -1 || err.indexOf('balance') !== -1) cat = 'Insufficient funds';
  else if (err.indexOf('timed out') !== -1 || err.indexOf('timeout') !== -1) cat = 'Timeout';
  else if (err.indexOf('skipped') !== -1) cat = 'Skipped';
  else cat = 'Other';
  if (!cats[cat]) cats[cat] = [];
  cats[cat].push(r);
});

Object.keys(cats).sort().forEach(function(cat) {
  var items = cats[cat];
  console.log('--- ' + cat + ' (' + items.length + ') ---');
  items.forEach(function(r) {
    var diag = r.diag || {};
    var meta = diag.v2rayRawMeta || [];
    var transports = meta.map(function(m) {
      return (m.proxy_protocol === 1 ? 'vless' : 'vmess') + '/' + (TMAP[m.transport_protocol] || '?') + '/' + (m.transport_security === 2 ? 'tls' : 'none') + ':' + m.port;
    }).join(', ');
    console.log('  ' + r.address.slice(0, 45));
    console.log('    type=' + r.type + ' moniker=' + (r.moniker || '?') + ' peers=' + r.peers + ' inPlan=' + r.inPlan);
    console.log('    err: ' + (r.error || '').slice(0, 150));
    if (transports) console.log('    transports: ' + transports);
    if (diag.v2rayProto) console.log('    tried: ' + diag.v2rayProto + '/' + diag.v2rayTransport + '/' + diag.v2raySecurity + ':' + diag.v2rayPort);
    console.log('');
  });
});

// Transport success rates
console.log('\n=== TRANSPORT SUCCESS RATES ===');
var tcounts = {};
d.forEach(function(r) {
  if (r.type !== 'V2Ray') return;
  var diag = r.diag || {};
  if (diag.v2rayTransport) {
    var key = diag.v2rayProto + '/' + diag.v2rayTransport + '/' + diag.v2raySecurity;
    if (!tcounts[key]) tcounts[key] = { ok: 0, fail: 0 };
    if (r.actualMbps > 0) tcounts[key].ok++;
    else tcounts[key].fail++;
  }
});
Object.keys(tcounts).sort().forEach(function(k) {
  var c = tcounts[k];
  var rate = ((c.ok / (c.ok + c.fail)) * 100).toFixed(0);
  console.log('  ' + k + ': ' + c.ok + ' ok / ' + c.fail + ' fail (' + rate + '%)');
});
