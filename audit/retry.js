/**
 * Sentinel Node Tester — Retry Strategies
 * Zero-skip system: every node gets PASS or FAIL, never "skip".
 * Interference pause, chain lag wait, network retry.
 */

import { classifyFailure, checkAndPauseIfInterference } from '../protocol/diagnostics.js';
import { clearCredential } from '../core/session.js';
import { sleep } from '../protocol/speedtest.js';

// ─── Retry Configuration ────────────────────────────────────────────────────
const MAX_RETRIES = 2;
const CHAIN_LAG_WAIT_MS = 10_000;
const NETWORK_RETRY_WAIT_MS = 5_000;
const NODE_TIMEOUT_MS = 300_000; // 5-minute hard timeout per node (3 outbounds × 45s + overhead)

/**
 * Execute a node test with zero-skip retry logic.
 * Every node MUST end as PASS (result with actualMbps) or FAIL (result with error).
 *
 * Retry strategy:
 *   1. VPN interference → PAUSE, wait for clear, retry
 *   2. Chain lag (404) → wait 10s, retry
 *   3. Network timeout → wait 5s, retry (up to MAX_RETRIES)
 *   4. Session conflict (409) → clear creds, handled by testNode internally
 *   5. All retries exhausted → FAIL with detailed diagnosis
 *
 * @param {Function} testFn - async () => TestResult (the testNode call)
 * @param {Function} broadcast - SSE broadcast function
 * @param {Object} state - Audit state (mutated for pause/resume)
 * @param {string} nodeAddr - Node address for logging
 * @returns {{ result: import('../core/types.js').TestResult|null, retried: number }}
 */
export async function testWithRetry(testFn, broadcast, state, nodeAddr) {
  let retried = 0;
  let lastErr = null;
  const nodeDeadline = Date.now() + NODE_TIMEOUT_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (state.stopRequested) break;
    if (Date.now() > nodeDeadline) {
      lastErr = lastErr || new Error(`Node test timed out after ${NODE_TIMEOUT_MS / 1000}s`);
      if (broadcast) broadcast('log', { msg: `  ⏱ Node hard timeout (${NODE_TIMEOUT_MS / 1000}s) — moving on` });
      break;
    }

    try {
      const result = await Promise.race([
        testFn(),
        new Promise((_, reject) => {
          const remaining = nodeDeadline - Date.now();
          if (remaining <= 0) reject(new Error('Node test timed out'));
          else setTimeout(() => reject(new Error('Node test timed out')), remaining);
        }),
        // Stop-aware: poll every 500ms so stop takes effect within 500ms
        new Promise((_, reject) => {
          const iv = setInterval(() => {
            if (state.stopRequested) { clearInterval(iv); reject(new Error('Stop requested')); }
          }, 500);
          // Clean up interval after node timeout
          setTimeout(() => clearInterval(iv), NODE_TIMEOUT_MS + 1000);
        }),
      ]);
      return { result, retried };
    } catch (err) {
      lastErr = err;

      // Stop requested — exit immediately, not a node failure
      if (err.message === 'Stop requested' || state.stopRequested) {
        lastErr = err;
        lastErr._stopRequested = true;
        break;
      }

      const failType = classifyFailure(err);

      // Insufficient balance — pass through to pipeline for pause handling
      if (err._pauseAudit) {
        break;
      }

      // Fatal errors — no retry
      if (failType === 'fatal' || failType === 'node_error') {
        break;
      }

      // VPN interference — pause and wait
      if (failType === 'vpn_interference') {
        if (broadcast) broadcast('log', { msg: `  🔄 VPN interference on attempt ${attempt + 1} — pausing...` });
        const cleared = await checkAndPauseIfInterference(broadcast, state);
        if (!cleared) break;
        retried++;
        state.retryCount = (state.retryCount || 0) + 1;
        continue;
      }

      // Last attempt — don't retry
      if (attempt >= MAX_RETRIES) break;

      // Chain lag — wait longer
      if (failType === 'chain_lag') {
        if (broadcast) broadcast('log', { msg: `  ⏳ Chain lag — waiting ${CHAIN_LAG_WAIT_MS / 1000}s before retry (${attempt + 1}/${MAX_RETRIES})` });
        await sleep(CHAIN_LAG_WAIT_MS);
        retried++;
        state.retryCount = (state.retryCount || 0) + 1;
        continue;
      }

      // Session conflict — clear credentials
      if (failType === 'session_conflict') {
        if (broadcast) broadcast('log', { msg: `  🔄 Session conflict — clearing cache, retrying (${attempt + 1}/${MAX_RETRIES})` });
        clearCredential(nodeAddr);
        await sleep(2000);
        retried++;
        state.retryCount = (state.retryCount || 0) + 1;
        continue;
      }

      // Network timeout — short wait
      if (failType === 'network_timeout') {
        if (broadcast) broadcast('log', { msg: `  ⏱ Network timeout — retrying in ${NETWORK_RETRY_WAIT_MS / 1000}s (${attempt + 1}/${MAX_RETRIES})` });
        await sleep(NETWORK_RETRY_WAIT_MS);
        retried++;
        state.retryCount = (state.retryCount || 0) + 1;
        continue;
      }
    }
  }

  // All retries exhausted — return the last error for FAIL result creation
  return { result: null, retried, error: lastErr };
}
