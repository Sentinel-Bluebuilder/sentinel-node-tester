const fs = require('fs');
const d = JSON.parse(fs.readFileSync('./results/results.json', 'utf8'));
const failed = d.filter(r => r.error);

console.log('=== ALL 11 FAILURES — DEEP ANALYSIS ===\n');

failed.forEach(r => {
  const diag = r.diag || {};
  console.log('NODE:', r.address);
  console.log('  Type:', r.type, '| Moniker:', r.moniker, '| Peers:', r.peers);
  console.log('  Location:', r.country, r.city);
  console.log('  Error:', (r.error || '').slice(0, 150));

  if (diag.v2rayProto) {
    console.log('  V2Ray Proto:', diag.v2rayProto, '| Transport:', diag.v2rayTransport, '| Security:', diag.v2raySecurity);
    console.log('  Port:', diag.v2rayPort, '| Host:', diag.serverHost);
  }
  if (diag.v2rayRawMeta) {
    console.log('  ALL metadata entries:');
    diag.v2rayRawMeta.forEach((m, i) => {
      const proto = m.proxy_protocol === 1 ? 'vless' : 'vmess';
      const TMAP = { 1:'domainsocket', 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'websocket' };
      const transport = TMAP[m.transport_protocol] || 'unknown(' + m.transport_protocol + ')';
      const sec = m.transport_security === 2 ? 'tls' : 'none';
      console.log('    [' + i + '] port=' + m.port + ' ' + proto + '/' + transport + '/' + sec);
    });
  }
  if (diag.v2rayStdout) {
    console.log('  V2Ray stdout (full):');
    console.log('    ' + diag.v2rayStdout.replace(/\n/g, '\n    '));
  }
  if (diag.v2rayStderr) {
    console.log('  V2Ray stderr (full):');
    console.log('    ' + diag.v2rayStderr.slice(0, 500).replace(/\n/g, '\n    '));
  }
  if (diag.v2rayConfig) {
    const cfg = diag.v2rayConfig;
    console.log('  Config outbounds:', cfg.outbounds?.length);
    console.log('  Config balancer strategy:', cfg.routing?.balancers?.[0]?.strategy?.type);
  }
  console.log('');
});

// Also check: which outbound did V2Ray PICK for each socks5 failure?
console.log('\n=== SOCKS5 FAILURES: WHICH OUTBOUND WAS SELECTED? ===');
const s5 = failed.filter(r => r.error && r.error.includes('SOCKS5'));
s5.forEach(r => {
  const stdout = (r.diag || {}).v2rayStdout || '';
  const detourMatch = stdout.match(/taking detour \[([^\]]+)\]/);
  const meta = (r.diag || {}).v2rayRawMeta || [];
  console.log('\n' + (r.address || '').slice(0, 50));
  console.log('  Selected outbound:', detourMatch ? detourMatch[1] : 'UNKNOWN');
  console.log('  Available entries:', meta.length);
  meta.forEach((m, i) => {
    const proto = m.proxy_protocol === 1 ? 'vless' : 'vmess';
    const TMAP = { 2:'gun', 3:'grpc', 4:'http', 5:'kcp', 6:'quic', 7:'tcp', 8:'websocket' };
    console.log('    [' + i + '] ' + proto + '/' + (TMAP[m.transport_protocol]||'?') + '/' + (m.transport_security===2?'tls':'none') + ' port=' + m.port);
  });
});

// Sequence mismatch analysis
console.log('\n\n=== SEQUENCE MISMATCH FAILURES ===');
const seqFails = failed.filter(r => r.error && (r.error.includes('sequence mismatch') || r.error.includes('code 32')));
seqFails.forEach(r => {
  console.log((r.address || '').slice(0, 50));
  console.log('  Error:', (r.error || '').slice(0, 200));
  console.log('  Is retest:', (r.error || '').includes('retest:'));
  console.log('');
});

// The V2Ray crash
console.log('\n=== V2RAY CRASH ===');
const crashes = failed.filter(r => r.error && r.error.includes('v2ray exited'));
crashes.forEach(r => {
  console.log((r.address || '').slice(0, 50));
  console.log('  Full error:', r.error);
  const diag = r.diag || {};
  if (diag.v2rayStderr) console.log('  Stderr:', diag.v2rayStderr.slice(0, 500));
  if (diag.v2rayStdout) console.log('  Stdout:', diag.v2rayStdout.slice(0, 500));
  if (diag.v2rayRawMeta) console.log('  Meta:', JSON.stringify(diag.v2rayRawMeta));
  console.log('');
});
