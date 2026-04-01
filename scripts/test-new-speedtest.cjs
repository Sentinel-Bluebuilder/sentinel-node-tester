// Test the new multi-request speedtest approach

async function run() {
  const mod = await import('./lib/speedtest.js');

  console.log('=== New Multi-Request Speed Test ===\n');

  console.log('Running 5 baseline tests...\n');
  for (let i = 1; i <= 5; i++) {
    const start = Date.now();
    const r = await mod.speedtestDirect();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  Test ${i}: ${r.mbps} Mbps  (chunks=${r.chunks}, adaptive=${r.adaptive}, ${elapsed}s)`);
  }

  console.log('\nDone.');
}

run().catch(console.error);
