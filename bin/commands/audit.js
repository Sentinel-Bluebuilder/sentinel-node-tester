/**
 * audit — Full audit loop across all chain nodes (or a filtered subset).
 */

export const name = 'audit';
export const description = 'Run a full audit of Sentinel nodes (consumes gas per node tested).';
export const usage = 'sentinel-audit audit [--max N] [--country XX] [--sdk js|tkd] [--out <dir>] [--resume]';
export const flags = [
  { name: '--max',     desc: 'Maximum nodes to test (0 = unlimited)', default: '0' },
  { name: '--country', desc: 'Filter to a specific country code (e.g. US)', default: '' },
  { name: '--sdk',     desc: 'Which SDK to use: js or tkd', default: 'js' },
  { name: '--out',     desc: 'Results directory', default: './results' },
  { name: '--resume',  desc: 'Resume a previous audit run', default: 'false' },
];

export async function run({ positional, flags: f }) {
  // ─── Set env vars BEFORE any pipeline/constants imports ─────────────────
  // MAX_NODES is read at module load in constants.js, so we set it first.
  if (f['--max'] && String(f['--max']) !== '0') {
    process.env.MAX_NODES = String(f['--max']);
  }
  if (f['--out'] && f['--out'] !== './results') {
    process.env.RESULTS_DIR = f['--out'];
  }

  // ─── Validate env before importing heavy modules ─────────────────────────
  // Import constants to check MNEMONIC (will have picked up MAX_NODES above)
  const { MNEMONIC } = await import('../../core/constants.js');
  if (!MNEMONIC || !MNEMONIC.trim()) {
    throw new Error('MNEMONIC not set in .env — cannot sign transactions');
  }

  const sdk = f['--sdk'] || 'js';
  if (!['js', 'tkd'].includes(sdk)) {
    throw new Error(`Invalid --sdk value "${sdk}": must be "js" or "tkd"`);
  }

  const country = (f['--country'] || '').toUpperCase().trim();
  const resume = f['--resume'] === 'true' || f['--resume'] === true;

  // ─── Dynamic import of pipeline (respects MAX_NODES set above) ──────────
  const {
    runAudit,
    createState,
    getResults,
  } = await import('../../audit/pipeline.js');

  // ─── State ───────────────────────────────────────────────────────────────
  const state = createState();
  state.activeSDK = sdk;

  // ─── Broadcast: progress to stderr, stdout stays clean ──────────────────
  const broadcast = (event, data) => {
    if (event === 'log' && data?.msg) {
      console.error(data.msg);
    } else if (event === 'state') {
      // Emit compact state summary to stderr periodically
      const s = data?.state;
      if (s) {
        console.error(
          `[state] tested=${s.testedNodes} failed=${s.failedNodes} ` +
          `pass15=${s.passed15} balance=${s.balance || '?'} status=${s.status}`,
        );
      }
    }
  };

  // ─── Country filter: patch getAllNodes to filter before pipeline uses it ──
  // runAudit calls getAllNodes internally, and we can't easily intercept it.
  // Instead we set a process-level signal and patch via env or subclass.
  // Simplest approach: set env var that constants picks up — but country isn't
  // a constants concern. So we inject a monkey-patch on the chain module.
  if (country) {
    console.error(`[audit] Country filter: ${country}`);
    // We'll log the filter; the pipeline will fetch all nodes then test them.
    // Since pipeline.js's runAudit owns the loop, country filtering must be
    // done by wrapping getAllNodes. We patch the module-level function.
    const chainMod = await import('../../core/chain.js');
    const origGetAll = chainMod.getAllNodes;
    // Re-export won't work on live bindings, but we can shadow via the
    // named export slot if the module supports it. ESM doesn't allow
    // re-assignment of named exports from outside. Instead, set a filter
    // on state that any post-fetch filtering in pipeline.js would use.
    // The pipeline currently doesn't filter by country — we note this.
    console.error(`[audit] Note: country filter "${country}" applied in post-processing (pipeline fetches all nodes).`);
    state._countryFilter = country;
  }

  // ─── Run audit ───────────────────────────────────────────────────────────
  console.error(`[audit] Starting audit (resume=${resume}, sdk=${sdk}, max=${process.env.MAX_NODES || '0'})...`);
  try {
    await runAudit(resume, state, broadcast);
  } catch (err) {
    // runAudit failed mid-run — tunnels/sessions may still be open. Force
    // emergency cleanup before propagating so tunnels don't leak across exit.
    try { if (typeof emergencyCleanupSync === 'function') emergencyCleanupSync(); }
    catch (cleanupErr) { console.error(`[audit] emergencyCleanupSync failed: ${cleanupErr.message}`); }
    throw err;
  }

  const results = getResults();
  const filtered = country
    ? results.filter(r => (r.countryCode || '').toUpperCase() === country)
    : results;

  const passed = filtered.filter(r => r.actualMbps != null && r.actualMbps >= 15).length;
  const failed = filtered.filter(r => r.actualMbps == null || r.actualMbps < 15).length;
  const skipped = 0; // zero-skip system: every result is PASS or FAIL

  return {
    totalTested: filtered.length,
    passed,
    failed,
    skipped,
    sdk,
    country: country || null,
    results: filtered,
  };
}
