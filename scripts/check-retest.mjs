import http from 'http';
http.get('http://localhost:3001/api/state', res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const {state, results} = JSON.parse(d);
    const start = new Date(state.startedAt);
    const recent = results.filter(r => new Date(r.timestamp) >= start);
    const fails = recent.filter(r => r.error);
    const passes = recent.filter(r => !r.error);
    console.log('=== RETEST PROGRESS ===');
    console.log(`Status: ${state.status} | Queued: ${state.totalNodes} | Done: ${recent.length} | Current: ${state.currentNode?.substring(0,30) || 'none'}`);
    console.log(`Pass: ${passes.length} | Fail: ${fails.length} | Balance: ${state.balance}`);
    console.log();
    if (fails.length) {
      console.log('=== FAILURES ===');
      fails.forEach(f => {
        const err = f.error.length > 150 ? f.error.substring(0,150)+'...' : f.error;
        console.log(`${(f.moniker || f.address.substring(0,30)).padEnd(35)} | ${(f.type||'?').padEnd(9)} | ${(f.country||'?').padEnd(15)} | ${err}`);
      });
    }
    console.log();
    if (passes.length) {
      console.log('=== PASSES ===');
      passes.forEach(p => {
        console.log(`${(p.moniker || p.address.substring(0,30)).padEnd(35)} | ${(p.type||'?').padEnd(9)} | ${(p.actualMbps||0).toFixed(1).padStart(6)} Mbps | ${p.country||'?'}`);
      });
    }
  });
});
