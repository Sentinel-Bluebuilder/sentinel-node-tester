// Discover subscription plans and plan-to-node relationships
const LCD = 'https://sentinel-api.polkachu.com';

async function run() {
  // 1. Get all subscriptions to find plan IDs
  console.log('=== Fetching subscriptions ===');
  let allSubs = [];
  let nextKey = null;
  do {
    let url = `${LCD}/sentinel/subscription/v3/subscriptions?pagination.limit=100`;
    if (nextKey) url += `&pagination.key=${encodeURIComponent(nextKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    allSubs.push(...(data.subscriptions || []));
    nextKey = data.pagination?.next_key || null;
  } while (nextKey && allSubs.length < 500);

  console.log(`Total subscriptions: ${allSubs.length}`);

  // Group by plan_id
  const plans = {};
  for (const s of allSubs) {
    const pid = s.plan_id || 'none';
    if (!plans[pid]) plans[pid] = [];
    plans[pid].push(s);
  }
  console.log('\nPlan IDs:');
  for (const [pid, subs] of Object.entries(plans)) {
    console.log(`  Plan ${pid}: ${subs.length} subscriptions, status=${subs[0].status}, price=${subs[0].price?.quote_value} ${subs[0].price?.denom}`);
  }

  // 2. Try to find plan details - what nodes are in each plan
  console.log('\n=== Searching for plan-node mappings ===');

  // Try various endpoint patterns
  const endpoints = [
    '/sentinel/subscription/v3/plan/{id}',
    '/sentinel/subscription/v3/plans/{id}',
    '/sentinel/subscription/v3/plans/{id}/nodes',
    '/sentinel/plan/v3/{id}',
    '/sentinel/plan/v3/{id}/nodes',
    '/sentinel/provider/v3/plans/{id}',
  ];

  for (const pid of Object.keys(plans).slice(0, 3)) {
    console.log(`\nTrying plan ${pid}:`);
    for (const ep of endpoints) {
      const url = LCD + ep.replace('{id}', pid);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (!data.code) {
          console.log(`  FOUND: ${ep} =>`, JSON.stringify(data).slice(0, 300));
        }
      } catch {}
    }
  }

  // 3. Look at provider endpoints (plans are created by providers)
  console.log('\n=== Checking provider endpoints ===');
  const providerEndpoints = [
    '/sentinel/provider/v3/providers',
    '/sentinel/providers',
  ];
  for (const ep of providerEndpoints) {
    try {
      const res = await fetch(LCD + ep + '?pagination.limit=5', { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (!data.code) {
        console.log(`  ${ep} =>`, JSON.stringify(data).slice(0, 500));
      }
    } catch {}
  }

  // 4. Check subscription allocations (how data is allocated per node within a subscription)
  console.log('\n=== Checking allocation endpoints ===');
  const sub = allSubs[0];
  if (sub) {
    const allocEndpoints = [
      `/sentinel/subscription/v3/subscriptions/${sub.id}/allocations`,
      `/sentinel/subscription/v3/allocations?subscription_id=${sub.id}`,
    ];
    for (const ep of allocEndpoints) {
      try {
        const res = await fetch(LCD + ep + '&pagination.limit=5', { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (!data.code) {
          console.log(`  ${ep} =>`, JSON.stringify(data).slice(0, 500));
        }
      } catch {}
    }
  }

  // 5. Look for nodes that reference plans in node data
  console.log('\n=== Checking node data for plan references ===');
  const nodeRes = await fetch(`${LCD}/sentinel/node/v3/nodes?status=1&pagination.limit=3`);
  const nodeData = await nodeRes.json();
  for (const n of (nodeData.nodes || [])) {
    console.log(`  ${n.address}: keys = ${Object.keys(n).join(', ')}`);
  }
}

run().catch(console.error);
