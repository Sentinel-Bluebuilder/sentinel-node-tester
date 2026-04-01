/**
 * Sentinel Node Tester — Diagnostics & VPN Interference Detection
 * Network health checks, retry logic, interference pause/resume.
 */

import { detectVpnInterference } from '../platforms/windows/network.js';
import { sleep } from './speedtest.js';

// ─── Interference Polling ────────────────────────────────────────────────────
const POLL_INTERVAL = 30_000; // 30s between interference checks

/**
 * Wait until VPN interference clears.
 * Polls every 30s, calls broadcast with status updates.
 * @param {Function} broadcast - SSE broadcast function
 * @param {Object} state - Audit state object (mutated: status, pauseReason)
 * @param {number} maxWaitMs - Maximum wait time (default: 10 min)
 * @returns {Promise<boolean>} True if cleared, false if timed out
 */
export async function waitForInterferenceClear(broadcast, state, maxWaitMs = 600_000) {
  const deadline = Date.now() + maxWaitMs;
  let pollCount = 0;

  while (Date.now() < deadline) {
    if (state.stopRequested) return false;

    const interference = await detectVpnInterference();
    if (!interference) {
      // Clear!
      state.status = 'running';
      state.pauseReason = null;
      if (broadcast) {
        broadcast('log', { msg: '✓ VPN interference cleared — resuming audit' });
        broadcast('state', { state });
      }
      return true;
    }

    pollCount++;
    if (pollCount === 1 || pollCount % 4 === 0) {
      if (broadcast) broadcast('log', { msg: `⏸ Still paused: ${interference} (checking every 30s)` });
    }

    await sleep(POLL_INTERVAL);
  }

  // Timed out
  if (broadcast) broadcast('log', { msg: `⚠ VPN interference did not clear after ${maxWaitMs / 60_000} minutes` });
  return false;
}

/**
 * Check for VPN interference and pause if detected.
 * Call this before each node test in the audit loop.
 * @param {Function} broadcast
 * @param {Object} state
 * @returns {Promise<boolean>} True if OK to proceed, false if should abort
 */
export async function checkAndPauseIfInterference(broadcast, state) {
  const interference = await detectVpnInterference();
  if (!interference) return true;

  // Interference detected — pause
  if (broadcast) {
    broadcast('log', { msg: `⚠ VPN interference detected — pausing audit: ${interference}` });
  }
  state.status = 'paused';
  state.pauseReason = interference;
  if (broadcast) broadcast('state', { state });

  // Wait for it to clear
  const cleared = await waitForInterferenceClear(broadcast, state);
  return cleared;
}

/**
 * Classify a test failure for retry strategy.
 * @param {Error} err
 * @returns {'vpn_interference'|'chain_lag'|'network_timeout'|'session_conflict'|'node_error'|'fatal'}
 */
export function classifyFailure(err) {
  const msg = err.message || '';

  // VPN interference — another VPN is active
  if (err.code === 'VPN_INTERFERENCE') return 'vpn_interference';

  // Chain lag — session not yet visible to node
  if (/does not exist/i.test(msg) && /blockchain|chain/i.test(msg)) return 'chain_lag';
  if (/does not exist on blockchain/i.test(msg)) return 'chain_lag';

  // 409 persistent after fresh session payment — no point retrying again
  if (/persistent even after fresh session/i.test(msg)) return 'node_error';

  // Session conflict — 409 already exists (inner retry + fresh session handles this)
  if (/already exists/i.test(msg) || /409/i.test(msg)) return 'session_conflict';

  // Clock drift VMess-only — cannot connect, node's clock is wrong
  if (/clock drift.*AEAD/i.test(msg)) return 'node_error';

  // Node inactive on chain — genuinely deactivated by operator
  if (/inactive on chain/i.test(msg)) return 'node_error';

  // Invalid price — chain rejects node's registered price; inner retry handles this
  if (/invalid price|Payment failed even without max_price/i.test(msg)) return 'node_error';

  // V2Ray service dead — no ports open, 0 peers
  if (/V2Ray service dead/i.test(msg)) return 'node_error';

  // Address mismatch persistent — node-side config bug
  if (/address mismatch.*persistent/i.test(msg)) return 'node_error';

  // Network timeout / unreachable — node didn't respond or routing failed
  if (/timeout/i.test(msg) || /ETIMEDOUT/i.test(msg) || /ECONNREFUSED/i.test(msg)) return 'network_timeout';
  if (/ENOTFOUND/i.test(msg) || /ECONNRESET/i.test(msg)) return 'network_timeout';
  if (/ENETUNREACH/i.test(msg) || /EHOSTUNREACH/i.test(msg)) return 'network_timeout';

  // Speed test failures are retriable
  if (/speed.*test.*failed/i.test(msg) || /SOCKS5/i.test(msg)) return 'network_timeout';

  // Node-specific bugs
  if (/wrong number of signers/i.test(msg)) return 'node_error';

  // Everything else is fatal (no retry)
  return 'fatal';
}
