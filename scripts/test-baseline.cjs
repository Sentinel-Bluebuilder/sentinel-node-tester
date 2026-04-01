// Run 5 baseline tests back-to-back and show the values
const { execSync } = require('child_process');

async function run() {
  // Dynamic import the ESM module
  const mod = await import('./lib/speedtest.js');

  console.log('Running 5 baseline speed tests back-to-back...\n');

  for (let i = 1; i <= 5; i++) {
    const result = await mod.speedtestDirect(10);
    console.log(`  Test ${i}: ${result.mbps} Mbps  (streams=${result.streams}, adaptive=${result.adaptive})`);
  }
}

run().catch(console.error);
