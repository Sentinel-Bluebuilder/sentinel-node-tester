// Deep scan for plan-node relationships using all possible endpoint patterns
const LCDS = [
  'https://sentinel-api.polkachu.com',
  'https://api.sentinel.quokkastake.io',
  'https://sentinel-rest.publicnode.com',
];

async function tryEndpoint(lcd, path) {
  try {
    const url = lcd + path;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    const data = JSON.parse(text);
    if (data.code) return null; // error
    return data;
  } catch { return null; }
}

async function run() {
  const lcd = LCDS[0];

  // Comprehensive endpoint scan
  const paths = [
    // Subscription plan queries
    '/sentinel/subscription/v3/plans',
    '/sentinel/subscription/v3/plan',
    // Provider queries (providers create plans with nodes)
    '/sentinel/provider/v3/providers',
    '/sentinel/provider/v2/providers',
    // Node queries with plan filter
    '/sentinel/node/v3/nodes?plan_id=36&pagination.limit=5',
    '/sentinel/node/v3/nodes?subscription_plan_id=36&pagination.limit=5',
    // Session queries for plan-based sessions
    '/sentinel/session/v3/sessions?plan_id=36&pagination.limit=5',
    // Check subscription 508130 in detail
    '/sentinel/subscription/v3/subscriptions/508130',
    // Plan-specific node lists
    '/sentinel/subscription/v3/plans/36',
    '/sentinel/subscription/v3/plans/36/nodes',
    // Allocation queries
    '/sentinel/subscription/v3/subscriptions/508130/allocations',
    '/sentinel/subscription/v3/allocations?subscription_id=508130',
    // Plan direct
    '/sentinel/plan/v3/plans/36',
    '/sentinel/plan/v3/plans/29',
    // Provider plans
    '/sentinel/provider/v3/plans/36',
  ];

  for (const p of paths) {
    for (const l of LCDS) {
      const data = await tryEndpoint(l, p);
      if (data) {
        const str = JSON.stringify(data);
        console.log(`FOUND ${l}${p}`);
        console.log(`  ${str.slice(0, 600)}`);
        console.log();
        break; // found on one LCD, skip others
      }
    }
  }

  // Also check cosmos proto types that might be registered
  console.log('=== Checking gRPC gateway discovery ===');
  const data = await tryEndpoint(lcd, '/cosmos/base/reflection/v1beta1/app_descriptor/query_services');
  if (data) {
    const services = JSON.stringify(data);
    // Find sentinel-related services
    const matches = services.match(/sentinel[^"]+/g) || [];
    console.log('Sentinel services:', [...new Set(matches)].join('\n  '));
  }
}

run().catch(console.error);
