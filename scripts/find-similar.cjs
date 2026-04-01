const r = JSON.parse(require('fs').readFileSync('results/results.json', 'utf8'));

// Find working V2Ray nodes that used grpc or mkcp/kcp transport
const grpcPass = r.filter(x => x.type === 'V2Ray' && x.actualMbps > 0 && x.diag &&
  (x.diag.v2rayTransport === 'grpc' || (x.diag.v2rayTransport && x.diag.v2rayTransport.includes('grpc'))));
const kcpPass = r.filter(x => x.type === 'V2Ray' && x.actualMbps > 0 && x.diag &&
  (x.diag.v2rayTransport === 'kcp' || x.diag.v2rayTransport === 'mkcp'));

console.log('Working grpc nodes:', grpcPass.length);
grpcPass.slice(0, 3).forEach(n => {
  console.log('  ', n.diag.serverHost, n.diag.v2rayTransport + '/' + n.diag.v2raySecurity, n.actualMbps + 'Mbps');
  console.log('    meta:', JSON.stringify(n.diag.v2rayRawMeta));
});

console.log('\nWorking mkcp/kcp nodes:', kcpPass.length);
kcpPass.slice(0, 3).forEach(n => {
  console.log('  ', n.diag.serverHost, n.diag.v2rayTransport + '/' + n.diag.v2raySecurity, n.actualMbps + 'Mbps');
  console.log('    meta:', JSON.stringify(n.diag.v2rayRawMeta));
});

// Show ALL grpc failures
const grpcFail = r.filter(x => x.type === 'V2Ray' && (x.actualMbps == null || x.actualMbps === 0) && x.diag && x.diag.v2rayRawMeta);
console.log('\nAll V2Ray failures with metadata:');
grpcFail.forEach(n => {
  const meta = n.diag.v2rayRawMeta || [];
  const transports = meta.map(m => 'tp=' + m.transport_protocol + '/ts=' + m.transport_security).join(', ');
  console.log('  ', (n.diag.serverHost || '?'), transports, '|', (n.error || '').substring(0, 80));
});
