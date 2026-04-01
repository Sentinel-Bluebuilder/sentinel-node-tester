const fs = require('fs');
const r = JSON.parse(fs.readFileSync(__dirname + '/results/results.json', 'utf8'));

const tmap = { 1: 'ds', 2: 'gun', 3: 'grpc', 4: 'http', 5: 'kcp', 6: 'quic', 7: 'tcp', 8: 'ws' };
const smap = { 0: 'none', 1: 'none', 2: 'tls' };

console.log('=== ALL 13 FAILURES — DEEP ANALYSIS ===\n');

const allFails = r.filter(n => n.error || n.actualMbps == null);
allFails.forEach(n => {
  const plan = n.inPlan ? 'IN-PLAN' : 'not-plan';
  console.log(`${plan} | ${n.type} | ${n.address}`);
  console.log(`  Error: ${n.error}`);

  if (n.type === 'V2Ray') {
    const meta = (n.diag || {}).v2rayRawMeta || [];
    const transports = meta.map(m => {
      const tp = tmap[m.transport_protocol] || '?';
      const sec = smap[m.transport_security] || '?';
      const proto = m.proxy_protocol === 1 ? 'vless' : 'vmess';
      return `${proto}/${tp}/${sec}:${m.port}`;
    });
    console.log(`  Transports: [${transports.join(', ')}]`);

    const hasNonGrpc = meta.some(m => m.transport_protocol !== 3);
    const hasNonQuic = meta.some(m => m.transport_protocol !== 6);
    const hasTcp = meta.some(m => m.transport_protocol === 7);
    const hasWs = meta.some(m => m.transport_protocol === 8);
    const hasKcp = meta.some(m => m.transport_protocol === 5);

    let verdict;
    if (hasTcp || hasWs) {
      verdict = 'CODE BUG — has tcp/ws but failed (fallback should have worked)';
    } else if (hasKcp) {
      verdict = 'CODE BUG — has kcp but failed (fallback should have worked)';
    } else if (hasNonGrpc && hasNonQuic) {
      verdict = 'POSSIBLE CODE BUG — has alternative transports';
    } else if (!hasNonGrpc) {
      verdict = 'NODE ISSUE — grpc-only, no viable fallback';
    } else {
      verdict = 'AMBIGUOUS — only grpc+quic, may be node issue';
    }
    console.log(`  Verdict: ${verdict}`);

    // Check what the old code actually tried
    const attempts = (n.diag || {}).v2rayAttempts;
    if (attempts && attempts !== 'NONE') {
      console.log(`  Attempts: ${attempts.length}`);
      attempts.forEach(a => console.log(`    ${a.label} → ${a.result}`));
    } else {
      console.log(`  Attempts: OLD CODE (no fallback loop)`);
    }
  } else {
    // WireGuard
    const diag = n.diag || {};
    console.log(`  Diag: ${JSON.stringify(diag).slice(0, 200)}`);
    if (n.error && n.error.includes('sequence mismatch')) {
      console.log('  Verdict: TRANSIENT — tx sequence race, should pass on retry');
    } else if (n.error && n.error.includes('invalid status inactive')) {
      console.log('  Verdict: NODE ISSUE — node went inactive on-chain');
    } else {
      console.log('  Verdict: NEEDS INVESTIGATION');
    }
  }
  console.log();
});

// Summary
console.log('=== SUMMARY ===');
let codeBugs = 0, nodeIssues = 0, transient = 0;
allFails.forEach(n => {
  if (n.error && n.error.includes('sequence mismatch')) { transient++; return; }
  if (n.error && n.error.includes('inactive')) { nodeIssues++; return; }
  if (n.type === 'V2Ray') {
    const meta = (n.diag || {}).v2rayRawMeta || [];
    const hasTcp = meta.some(m => m.transport_protocol === 7);
    const hasWs = meta.some(m => m.transport_protocol === 8);
    const hasKcp = meta.some(m => m.transport_protocol === 5);
    if (hasTcp || hasWs || hasKcp) {
      codeBugs++;
    } else {
      const hasNonGrpc = meta.some(m => m.transport_protocol !== 3);
      if (hasNonGrpc) codeBugs++;
      else nodeIssues++;
    }
  }
});
console.log(`Code bugs (should have used fallback): ${codeBugs}`);
console.log(`Node issues (broken/inactive/grpc-only): ${nodeIssues}`);
console.log(`Transient (tx sequence, retry will fix): ${transient}`);
