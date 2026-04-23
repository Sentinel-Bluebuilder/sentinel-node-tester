/**
 * Sentinel Node Tester — Continuous Loop Runner
 * Singleton controller that runs repeated audit passes (p2p or subscription)
 * with a configurable inter-pass delay, interruptible stop, and SSE events.
 *
 * Events emitted (use .on()):
 *   'loop:started'        { mode, minDelayMs, iteration: 0 }
 *   'loop:stopping'       {}
 *   'loop:stopped'        { iterations, reason }
 *   'loop:error'          { error: string, iteration }
 *   'iteration:start'     { iteration, mode }
 *   'iteration:end'       { iteration, mode, durationMs, passed, failed }
 */

import { EventEmitter } from 'events';
import { createState } from './pipeline.js';
import { sleep } from '../protocol/speedtest.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_DELAY_MS = 30_000;       // Hard floor — prevent chain spam
const SLEEP_TICK_MS = 1_000;       // Interruptible-sleep check interval

// ─── Internal State ───────────────────────────────────────────────────────────

const _emitter = new EventEmitter();
_emitter.setMaxListeners(50);

const _ctrl = {
  running: false,
  stopRequested: false,
  iteration: 0,
  mode: null,
  planId: null,
  minDelayMs: MIN_DELAY_MS,
  subscriptionGranter: null,
  startedAt: null,
  lastError: null,
};

// Injected pipeline runner (overridable in tests)
let _runnerFn = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds but check `_ctrl.stopRequested` every SLEEP_TICK_MS.
 * Returns true if interrupted early, false if the full duration elapsed.
 *
 * @param {number} ms
 * @returns {Promise<boolean>} true if stopped early
 */
async function sleepInterruptible(ms) {
  // Always yield at least one turn so a stop() from another task has a chance
  // to set stopRequested before the next iteration starts, even when ms=0.
  await sleep(0);
  if (_ctrl.stopRequested) return true;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (_ctrl.stopRequested) return true;
    const remaining = end - Date.now();
    await sleep(Math.min(SLEEP_TICK_MS, remaining > 0 ? remaining : 0));
  }
  return _ctrl.stopRequested;
}

/**
 * Verify that a fee-grant allowance is active for subscription mode.
 * Uses `queryFeeGrant` from core/chain.js.
 *
 * @param {string} granterAddr   - Plan owner's sent1... address
 * @param {string} granteeAddr   - Tester wallet's sent1... address
 * @returns {Promise<void>} Throws if no active allowance found.
 */
async function verifyFeeGrant(granterAddr, granteeAddr) {
  const { queryFeeGrant } = await import('../core/chain.js');
  const { ensureLcd } = await import('../core/chain.js');
  const lcd = await ensureLcd();
  const grant = await queryFeeGrant(lcd, granterAddr, granteeAddr);
  if (!grant) {
    throw new Error(
      `No active fee-grant from ${granterAddr} to ${granteeAddr}. ` +
      'The plan owner must grant a fee allowance before subscription mode can run.',
    );
  }
}

// ─── Core Loop ────────────────────────────────────────────────────────────────

/**
 * Run one audit pass (p2p or subscription) and return summary counts.
 *
 * @param {object} loopState - Pipeline state object (created fresh per iteration)
 * @returns {Promise<{ passed: number, failed: number }>}
 */
async function _runOnePass(loopState) {
  // Use injected mock runner if provided (test path), otherwise resolve real pipeline.
  // ES module imports are cached by Node so repeated imports are near-zero cost.
  let runner = _runnerFn;
  if (!runner) {
    const pipeline = await import('./pipeline.js');
    runner = _ctrl.mode === 'subscription'
      ? (st) => pipeline.runSubPlanTest(
          _ctrl.planId,
          _ctrl.subscriptionId,
          _ctrl.subscriptionGranter,
          st,
          () => {}, // noop broadcast — loop emits its own events
        )
      : (st) => pipeline.runAudit(false, st, () => {});
  }

  await runner(loopState);

  // Count outcomes from pipeline state
  const passed = loopState.testedNodes || 0;
  const failed  = loopState.failedNodes  || 0;
  return { passed, failed };
}

/**
 * Main loop body — runs until stopRequested or unrecoverable error.
 */
async function _runLoop() {
  _ctrl.running = true;
  _ctrl.stopRequested = false;
  _ctrl.startedAt = Date.now();
  _ctrl.iteration = 0;

  let stopReason = 'requested';

  try {
    while (!_ctrl.stopRequested) {
      _ctrl.iteration += 1;
      const iterStart = Date.now();

      _emitter.emit('iteration:start', {
        iteration: _ctrl.iteration,
        mode: _ctrl.mode,
      });

      // Fresh pipeline state per iteration so counters reset cleanly
      const loopState = createState();
      loopState.stopRequested = false;

      // ─── Persistence: open a DB run record ──────────────────────────────
      // Skip DB writes when a mock runner is injected (test path). Tests that
      // need DB persistence should use their own :memory: handle via useDb().
      let dbRunId = null;
      if (!_runnerFn) {
        try {
          const { insertRun } = await import('../core/db.js');
          dbRunId = insertRun({
            started_at:     iterStart,
            mode:           _ctrl.mode,
            plan_id:        _ctrl.planId || null,
            wallet_address: null, // resolved by pipeline from MNEMONIC
            notes:          `continuous-loop iteration ${_ctrl.iteration}`,
            tester_sdk:     _ctrl.activeSDK || 'js',
            tester_os:      process.platform,
          });
        } catch (dbErr) {
          // Non-fatal — audit continues without DB tracking
          console.error(`[continuous] insertRun failed: ${dbErr.message}`);
        }
      }

      let passed = 0;
      let failed = 0;
      let iterErr = null;

      try {
        ({ passed, failed } = await _runOnePass(loopState));
      } catch (err) {
        iterErr = err;
        _ctrl.lastError = err.message || String(err);
        _emitter.emit('loop:error', {
          error: _ctrl.lastError,
          iteration: _ctrl.iteration,
        });
      }

      const durationMs = Date.now() - iterStart;

      // ─── Persistence: close the DB run record ───────────────────────────
      if (dbRunId != null) {
        try {
          const { updateRunOnFinish } = await import('../core/db.js');
          updateRunOnFinish(dbRunId, {
            finished_at: Date.now(),
            node_count:  passed + failed,
            pass_count:  passed,
          });
        } catch (dbErr) {
          console.error(`[continuous] updateRunOnFinish failed: ${dbErr.message}`);
        }
      }

      _emitter.emit('iteration:end', {
        iteration: _ctrl.iteration,
        mode: _ctrl.mode,
        durationMs,
        passed,
        failed,
        error: iterErr ? iterErr.message : null,
      });

      // Honor stop request that arrived during the pass
      if (_ctrl.stopRequested) {
        stopReason = 'requested';
        break;
      }

      // Interruptible delay before the next iteration
      const delayMs = _delayOverride !== null ? _delayOverride : _ctrl.minDelayMs;
      const interrupted = await sleepInterruptible(delayMs);
      if (interrupted) {
        stopReason = 'requested';
        break;
      }
    }
  } catch (outerErr) {
    stopReason = 'error';
    _ctrl.lastError = outerErr.message || String(outerErr);
    _emitter.emit('loop:error', {
      error: _ctrl.lastError,
      iteration: _ctrl.iteration,
    });
  } finally {
    _ctrl.running = false;
    _ctrl.stopRequested = false;
    _emitter.emit('loop:stopped', {
      iterations: _ctrl.iteration,
      reason: stopReason,
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the continuous loop.
 *
 * @param {{
 *   mode?: 'p2p' | 'subscription',
 *   planId?: string,
 *   subscriptionId?: string,
 *   minDelayMs?: number,
 *   subscriptionGranter?: string,
 * }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function start(opts = {}) {
  if (_ctrl.running) {
    return { ok: false, error: 'Loop already running' };
  }

  const mode = opts.mode || 'p2p';

  // ─── Validate mode ────────────────────────────────────────────────────────
  if (mode !== 'p2p' && mode !== 'subscription') {
    return { ok: false, error: `Invalid mode "${mode}". Must be "p2p" or "subscription"` };
  }

  // ─── Wallet safety check ──────────────────────────────────────────────────
  // Read live from env so tests can override process.env.MNEMONIC.
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic || !mnemonic.trim()) {
    return {
      ok: false,
      error: 'MNEMONIC not set in .env — cannot sign session TXs',
    };
  }

  // ─── Subscription-mode prerequisites ─────────────────────────────────────
  if (mode === 'subscription') {
    if (!opts.planId) {
      return { ok: false, error: 'planId required for subscription mode' };
    }
    if (!opts.subscriptionId) {
      return { ok: false, error: 'subscriptionId required for subscription mode' };
    }
    if (!opts.subscriptionGranter) {
      return { ok: false, error: 'subscriptionGranter (sent1... plan owner address) required for subscription mode' };
    }

    // Verify fee-grant before we spend any tokens
    try {
      const { cachedWalletSetup } = await import('../core/wallet.js');
      const { address } = await cachedWalletSetup();
      await verifyFeeGrant(opts.subscriptionGranter, address);
    } catch (fgErr) {
      return { ok: false, error: `Fee-grant check failed: ${fgErr.message}` };
    }
  }

  // ─── Clamp delay to minimum ───────────────────────────────────────────────
  const minDelayMs = Math.max(
    MIN_DELAY_MS,
    typeof opts.minDelayMs === 'number' ? opts.minDelayMs : MIN_DELAY_MS,
  );

  // ─── Store config ─────────────────────────────────────────────────────────
  _ctrl.mode               = mode;
  _ctrl.planId             = opts.planId || null;
  _ctrl.subscriptionId     = opts.subscriptionId || null;
  _ctrl.subscriptionGranter = opts.subscriptionGranter || null;
  _ctrl.minDelayMs         = minDelayMs;
  _ctrl.lastError          = null;
  _ctrl.iteration          = 0;

  _emitter.emit('loop:started', {
    mode,
    minDelayMs,
    iteration: 0,
    planId: _ctrl.planId,
  });

  // Fire-and-forget — loop runs in background
  _runLoop().catch(err => {
    // Should be caught internally, but belt-and-suspenders
    console.error(`[continuous] _runLoop unhandled: ${err.message}`);
  });

  return { ok: true, mode, minDelayMs };
}

/**
 * Request the loop to stop. Returns immediately; loop stops within SLEEP_TICK_MS.
 *
 * @returns {{ ok: boolean }}
 */
export function stop() {
  if (!_ctrl.running) return { ok: true, alreadyStopped: true };
  _ctrl.stopRequested = true;
  _emitter.emit('loop:stopping', {});
  return { ok: true };
}

/**
 * Current loop status snapshot.
 *
 * @returns {{
 *   running: boolean,
 *   iteration: number,
 *   mode: string|null,
 *   planId: string|null,
 *   minDelayMs: number,
 *   startedAt: number|null,
 *   lastError: string|null,
 *   uptime: number|null,
 * }}
 */
export function status() {
  return {
    running:      _ctrl.running,
    iteration:    _ctrl.iteration,
    mode:         _ctrl.mode,
    planId:       _ctrl.planId,
    minDelayMs:   _ctrl.minDelayMs,
    startedAt:    _ctrl.startedAt,
    lastError:    _ctrl.lastError,
    uptime:       _ctrl.startedAt ? Date.now() - _ctrl.startedAt : null,
  };
}

/**
 * Register an event listener.
 *
 * @param {string} event
 * @param {Function} handler
 * @returns {EventEmitter}
 */
export function on(event, handler) {
  return _emitter.on(event, handler);
}

/**
 * Remove an event listener.
 *
 * @param {string} event
 * @param {Function} handler
 * @returns {EventEmitter}
 */
export function off(event, handler) {
  return _emitter.off(event, handler);
}

// ─── Test Injection (test use only) ──────────────────────────────────────────

/**
 * Replace the pipeline runner with a mock function.
 * MUST be called before start(). Reset to null to restore real pipeline.
 *
 * The injected function receives the loopState object and must return
 * a Promise that resolves when the "pass" is complete. Set
 * `loopState.testedNodes` and `loopState.failedNodes` to control counts.
 *
 * @param {Function|null} fn
 */
export function _injectRunnerFn(fn) {
  _runnerFn = fn;
}

/**
 * Override the inter-pass delay for tests. Pass null to restore production value.
 * Has no effect on the minimum; only the value used in sleepInterruptible() is changed.
 *
 * @param {number|null} ms
 */
export function _setDelayOverride(ms) {
  _delayOverride = ms;
}

// Internal: test-only delay override (bypasses MIN_DELAY_MS for speed)
let _delayOverride = null;
