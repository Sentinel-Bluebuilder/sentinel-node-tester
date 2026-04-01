// Experiment: compare single-stream vs multi-stream at various sizes
// This helps determine the best test approach for showing VPN overhead

async function run() {
  const mod = await import('./lib/speedtest.js');

  // We can't easily do single-stream with the exported functions,
  // but we can test speedtestDirect which does probe (single) + full (multi).
  // The probe phase IS single-stream 2MB. If probe < 3 Mbps it stays single.
  // We need to see what different sizes do in single-stream mode.

  // Test plan: run speedtestDirect with various TEST_MB values
  // and also check if we can force single-stream behavior

  console.log('=== Direct Connection Tests ===\n');

  // Test 1: Multiple runs at 10MB to see variance
  console.log('--- 10MB (3-stream, current default) ---');
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = await mod.speedtestDirect(10);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.streams} streams, ${r.adaptive}, ${((Date.now()-t)/1000).toFixed(1)}s)`);
  }

  // Test 2: 5MB
  console.log('\n--- 5MB (3-stream) ---');
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = await mod.speedtestDirect(5);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.streams} streams, ${r.adaptive}, ${((Date.now()-t)/1000).toFixed(1)}s)`);
  }

  // Test 3: 3MB
  console.log('\n--- 3MB (3-stream) ---');
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = await mod.speedtestDirect(3);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.streams} streams, ${r.adaptive}, ${((Date.now()-t)/1000).toFixed(1)}s)`);
  }

  // Test 4: 2MB (should be probe-only single-stream since probe IS 2MB)
  console.log('\n--- 2MB (3-stream, but per-stream is tiny) ---');
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = await mod.speedtestDirect(2);
    console.log(`  Run ${i+1}: ${r.mbps} Mbps (${r.streams} streams, ${r.adaptive}, ${((Date.now()-t)/1000).toFixed(1)}s)`);
  }

  console.log('\nDone.');
}

run().catch(console.error);
