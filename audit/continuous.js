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
 *
 * Batch-model events (each full node-sweep is one batch):
 *   'batch:start'         { batchId, snapshotSize, mode, startedAt }
 *   'batch:node:result'   { batchId, address, moniker, country, city, type,
 *                           actualMbps, peers, maxPeers, error, errorCode, testedAt }
 *   'batch:end'           { batchId, passed, failed, durationMs }
 *   'batch:gap'           { gapMs, nextBatchAt }
 */

import { EventEmitter } from 'events';
import { createState } from './pipeline.js';
import { sleep } from '../protocol/speedtest.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_DELAY_MS = 30_000;       // Hard floor — prevent chain spam
const SLEEP_TICK_MS = 1_000;       // Interruptible-sleep check interval
const MIN_INSERT_INTERVAL_MS = 1_000; // Lowest rate at which a runs row may be inserted
const SAFETY_MAX_ITERATIONS = 100_000; // Absolute loop-iteration ceiling

let _lastInsertAt = 0;             // Row-insert rate fuse (module-scoped)

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
  const { queryFeeGrantRpcFirst, getRpcClient, ensureLcd } = await import('../core/chain.js');
  const lcd = await ensureLcd();
  const rpcClient = await getRpcClient();
  const grant = await queryFeeGrantRpcFirst(rpcClient, lcd, granterAddr, granteeAddr);
  if (!grant) {
    throw new Error(
      `No active fee-grant from ${granterAddr} to ${granteeAddr}. ` +
      'The plan owner must grant a fee allowance before subscription mode can run.',
    );
  }
}

// ─── Batch State ──────────────────────────────────────────────────────────────

/** Incremented each time a new batch starts. Module-scoped for export via status(). */
let _batchId = 0;

/**
 * Build a sanitized `batch:node:result` payload from a raw pipeline result.
 * Strips wallet, SDK, OS, baseline, inPlan, diag fields — public-safe only.
 *
 * @param {object} result - Raw pipeline result object
 * @param {number} batchId
 * @returns {object}
 */
function _sanitizeBatchNodeResult(result, batchId) {
  return {
    batchId,
    address:   result.address   || '',
    moniker:   result.moniker   || null,
    country:   result.country   || null,
    city:      result.city      || null,
    type:      result.type      || null,
    actualMbps: result.actualMbps ?? null,
    peers:     result.peers     ?? null,
    maxPeers:  result.maxPeers  ?? null,
    error:     result.error     ? String(result.error).slice(0, 200) : null,
    errorCode: result.errorCode || null,
    testedAt:  Date.now(),
  };
}

// ─── Core Loop ────────────────────────────────────────────────────────────────

/**
 * Run one audit pass (p2p or subscription) and return summary counts.
 * During the pass, each node result is captured and emitted as `batch:node:result`
 * and persisted to the `batch_results` DB table.
 *
 * @param {object} loopState - Pipeline state object (created fresh per iteration)
 * @param {number} batchId   - Current batch DB id
 * @returns {Promise<{ passed: number, failed: number }>}
 */
async function _runOnePass(loopState, batchId) {
  // Build a broadcast intercept that captures 'result' events for batch tracking.
  // All other broadcast types (log, state) are silently dropped (noop) —
  // the continuous loop emits its own high-level events instead.
  let _dbModule = null;
  const _getDb = async () => {
    if (!_dbModule && !_runnerFn) {
      try { _dbModule = await import('../core/db.js'); } catch { /* non-fatal */ }
    }
    return _dbModule;
  };

  function batchBroadcast(type, data) {
    if (type !== 'result') return; // only care about per-node results
    const raw = data?.result;
    if (!raw) return;
    const payload = _sanitizeBatchNodeResult(raw, batchId);
    _emitter.emit('batch:node:result', payload);
    // Also emit old-compat event so existing public SSE listeners see per-node data
    _emitter.emit('public-test:node:result', payload);
    // Persist to batch_results (non-blocking, non-fatal)
    _getDb().then(db => {
      if (db) {
        try { db.insertBatchResult(batchId, payload); } catch { /* non-fatal */ }
      }
    }).catch(() => {});
  }

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
          batchBroadcast,
        )
      : (st) => pipeline.runAudit(false, st, batchBroadcast);
  }

  await runner(loopState);

  // Count outcomes from pipeline state
  const passed = loopState.testedNodes || 0;
  const failed  = loopState.failedNodes  || 0;
  return { passed, failed };
}

/**
 * Resolve the number of nodes in the current snapshot (best-effort).
 * Used to populate `snapshot_size` on the batch record.
 * Returns 0 on any error rather than blocking loop startup.
 *
 * @returns {Promise<number>}
 */
async function _resolveSnapshotSize() {
  try {
    const { getAllNodes, ensureLcd } = await import('../core/chain.js');
    await ensureLcd();
    const nodes = await getAllNodes(() => {});
    return Array.isArray(nodes) ? nodes.length : 0;
  } catch {
    return 0;
  }
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
      // Absolute ceiling: no real operator wants 100K iterations; if we hit
      // this, the sleep/yield logic has failed and we must bail.
      if (_ctrl.iteration >= SAFETY_MAX_ITERATIONS) {
        stopReason = 'safety-max-iterations';
        _ctrl.lastError = `continuous loop exceeded ${SAFETY_MAX_ITERATIONS} iterations — aborting`;
        break;
      }

      _ctrl.iteration += 1;
      const iterStart = Date.now();

      _emitter.emit('iteration:start', {
        iteration: _ctrl.iteration,
        mode: _ctrl.mode,
      });

      // Fresh pipeline state per iteration so counters reset cleanly
      const loopState = createState();
      loopState.stopRequested = false;

      // ─── Rate fuse ───────────────────────────────────────────────────────
      // Refuse to insert more than 1 runs row per second. Any caller that
      // bypasses the delay floor (bad test, misconfigured override) is
      // short-circuited here so the DB cannot explode.
      const sinceLast = iterStart - _lastInsertAt;
      if (_lastInsertAt !== 0 && sinceLast < MIN_INSERT_INTERVAL_MS) {
        const backoff = MIN_INSERT_INTERVAL_MS - sinceLast;
        console.warn(`[continuous] insert rate fuse engaged — sleeping ${backoff}ms`);
        await sleep(backoff);
        if (_ctrl.stopRequested) break;
      }

      // ─── Persistence: open a DB run record (legacy runs table) ──────────
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
          _lastInsertAt = iterStart;
        } catch (dbErr) {
          // Non-fatal — audit continues without DB tracking
          console.error(`[continuous] insertRun failed: ${dbErr.message}`);
        }
      }

      // ─── Batch: open a batch record ──────────────────────────────────────
      // Each iteration of the continuous loop is one "batch" — a complete
      // sweep of the node snapshot. batchId is module-scoped so status() can
      // expose it and API endpoints can query it.
      let currentBatchId = 0;
      let snapshotSize = 0;
      if (!_runnerFn) {
        snapshotSize = await _resolveSnapshotSize();
        try {
          const { insertBatch } = await import('../core/db.js');
          currentBatchId = insertBatch({
            started_at:    iterStart,
            snapshot_size: snapshotSize,
            mode:          _ctrl.mode || 'p2p',
          });
          _batchId = currentBatchId;
        } catch (dbErr) {
          console.error(`[continuous] insertBatch failed: ${dbErr.message}`);
        }
      }

      _emitter.emit('batch:start', {
        batchId:      currentBatchId,
        snapshotSize,
        mode:         _ctrl.mode,
        startedAt:    iterStart,
        iteration:    _ctrl.iteration,
      });

      let passed = 0;
      let failed = 0;
      let iterErr = null;

      try {
        ({ passed, failed } = await _runOnePass(loopState, currentBatchId));
      } catch (err) {
        iterErr = err;
        _ctrl.lastError = err.message || String(err);
        _emitter.emit('loop:error', {
          error: _ctrl.lastError,
          iteration: _ctrl.iteration,
        });
      }

      const durationMs = Date.now() - iterStart;

      // ─── Persistence: close the DB run record (legacy) ──────────────────
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

      // ─── Batch: close the batch record ──────────────────────────────────
      if (!_runnerFn && currentBatchId > 0) {
        try {
          const { updateBatchOnFinish } = await import('../core/db.js');
          updateBatchOnFinish(currentBatchId, {
            finished_at: Date.now(),
            passed,
            failed,
          });
        } catch (dbErr) {
          console.error(`[continuous] updateBatchOnFinish failed: ${dbErr.message}`);
        }
      }

      _emitter.emit('batch:end', {
        batchId:   currentBatchId,
        passed,
        failed,
        durationMs,
        iteration: _ctrl.iteration,
      });

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
      const nextBatchAt = Date.now() + delayMs;

      _emitter.emit('batch:gap', {
        gapMs:       delayMs,
        nextBatchAt,
        iteration:   _ctrl.iteration,
      });

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
    batchId:      _batchId,
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
  // Guard: only tests may drop below the production floor. Opening this to
  // prod callers would defeat MIN_DELAY_MS and the insert-rate fuse together.
  if (ms !== null && ms < MIN_DELAY_MS) {
    const isTest = process.env.NODE_ENV === 'test'
      || /\.test\.m?js/.test(process.argv.join(' '));
    if (!isTest) {
      throw new Error(
        `_setDelayOverride(${ms}) refused: sub-floor values are test-only. ` +
        `Set NODE_ENV=test or invoke from a *.test.js process.`
      );
    }
  }
  _delayOverride = ms;
}

// Internal: test-only delay override (bypasses MIN_DELAY_MS for speed)
let _delayOverride = null;
