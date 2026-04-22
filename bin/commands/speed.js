/**
 * speed — Baseline internet speed test (no VPN).
 *
 * Uses speedtestDirect() from the SDK via protocol/speedtest.js.
 * speedtestDirect() takes no arguments and returns { mbps, chunks, adaptive }.
 * This wrapper adds a timestamp and echoes those fields back.
 */

import { speedtestDirect } from '../../protocol/speedtest.js';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'speed';
export const description = 'Run a baseline internet speed test (no VPN) using Cloudflare.';
export const usage = 'sentinel-audit speed [--pretty]';
export const flags = [
  { flag: '--pretty', description: 'Human-readable output' },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run({ positional: _p, flags: _f } = {}) {
  const started = Date.now();
  const result = await speedtestDirect();
  const durationMs = Date.now() - started;

  return {
    mbps:            result.mbps     ?? null,
    chunks:          result.chunks   ?? null,
    adaptive:        result.adaptive ?? null,
    durationMs,
  };
}
