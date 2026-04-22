/**
 * verify-sdks — Verify installed SDKs match their published GitHub tag.
 *
 * Downloads the GitHub tag tarball for each tracked SDK, hashes every source
 * file, and compares to the same-named files in node_modules/. Proves the
 * npm-published SDK is byte-identical to the GitHub source at that tag.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { getInstalledVersions, verifyAllSdks, verifySdk } from '../../core/sdk-verify.js';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'verify-sdks';
export const description = 'Verify installed SDKs match their GitHub tag (byte-for-byte source hash).';
export const usage = 'sentinel-audit verify-sdks [--sdk blue-js|tkd-js] [--pretty]';
export const flags = [
  { flag: '--sdk',    description: 'Verify only one SDK (blue-js or tkd-js). Default: all.' },
  { flag: '--pretty', description: 'Human-readable output' },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run({ flags: f = {} } = {}) {
  // Resolve the tester package root so we always find node_modules.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, '..', '..');

  const only = typeof f['--sdk'] === 'string' ? f['--sdk'] : null;
  const installed = getInstalledVersions(rootDir);

  const results = only
    ? { [only]: await verifySdk(only, rootDir) }
    : await verifyAllSdks(rootDir);

  const summary = {};
  for (const [key, r] of Object.entries(results)) {
    summary[key] = {
      pkg: r.pkg || installed[key]?.pkg || key,
      version: r.version || installed[key]?.version || null,
      repository: r.repository || installed[key]?.repository || null,
      ok: !!r.ok,
      ref: r.ref || null,
      exactRef: !!r.exactRef,
      warning: r.warning || null,
      counts: r.counts,
      mismatched: (r.mismatched || []).map(m => m.file),
      missingOnGithub: r.missingOnGithub || [],
      missingLocal: r.missingLocal || [],
      error: r.error || r.reason || null,
    };
  }

  if (f['--pretty']) {
    console.log('\nSDK Verification\n');
    for (const [key, s] of Object.entries(summary)) {
      const status = s.ok ? 'OK' : (s.error ? 'ERROR' : 'MISMATCH');
      console.log(`  ${key.padEnd(10)} ${s.pkg}@${s.version || '?'}`);
      console.log(`    Repository:  ${s.repository || '(unknown)'}`);
      console.log(`    Compared:    ${s.ref || '?'}${s.exactRef ? ' (exact tag)' : ' (fallback — no matching tag)'}`);
      console.log(`    Status:      ${status}`);
      if (s.warning) console.log(`    Warning:     ${s.warning}`);
      if (s.counts) {
        console.log(
          `    Files:       local=${s.counts.local} github=${s.counts.github} ` +
          `matched=${s.counts.matched} mismatched=${s.counts.mismatched} ` +
          `missingOnGithub=${s.counts.missingOnGithub} missingLocal=${s.counts.missingLocal}`,
        );
      }
      if (s.mismatched.length) {
        console.log('    Mismatched:');
        for (const f of s.mismatched.slice(0, 10)) console.log(`      ${f}`);
        if (s.mismatched.length > 10) console.log(`      ... and ${s.mismatched.length - 10} more`);
      }
      if (s.error) console.log(`    Error:       ${s.error}`);
      console.log('');
    }
    return;
  }

  return { ok: Object.values(summary).every(s => s.ok), results: summary };
}
