/**
 * Sentinel Node Tester — Audit Pipeline
 * Main audit loop (runAudit), retest (runRetestSkips), plan test (runPlanTest).
 * Zero-skip system: every node ends as PASS or FAIL.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import path from 'path';

import {
  MNEMONIC, DENOM, GIGS as _GIGS_LEGACY, TEST_MB, MAX_NODES, NODE_DELAY,
  RESULTS_DIR, RESULTS_FILE, FAILURE_LOG, BATCH_SIZE as _BATCH_SIZE_LEGACY, PROJECT_ROOT,
  V3_SUB_TYPE, V3_SUB_SESSION_TYPE,
} from '../core/constants.js';
import { gigsRT, batchSizeRT, autoCancelRT, onchainEnabledRT, onchainBatchSizeRT, onchainRegionRT } from '../core/settings.js';
import { resultToRecord, encodeBatch, commitBatch as commitOnchainBatch } from '../core/onchain-report.js';

// Runtime aliases — read once per audit start so a single run uses a stable
// value, but each new run picks up the latest operator-configured setting.
let GIGS = _GIGS_LEGACY;
let BATCH_SIZE = _BATCH_SIZE_LEGACY;
function refreshAuditSettings() {
  GIGS = gigsRT();
  BATCH_SIZE = batchSizeRT();
}
import { cachedWalletSetup, createFreshClient, signAndBroadcastRetry } from '../core/wallet.js';
import { getAllNodes, fetchPlanMembership, ensureLcd, getActiveLcd, getRpcClient, rpcFetchAllNodesForPlanPaginated, withFreshRpc } from '../core/chain.js';
import { rpcQueryNode } from 'blue-js-sdk';
import {
  submitBatchPayment, submitBatchCancel, waitForBatchSessions, waitForSessionActive,
  clearPoisonedSessions, clearPaidNodes, clearAllCredentials, invalidateSessionCache, parseNodePriceUdvpn,
} from '../core/session.js';
import { nodeStatusV3 } from '../protocol/v3protocol.js';
import { speedtestDirect, sleep as _rawSleep, resolveCfHost } from '../protocol/speedtest.js';

// ─── Stop-aware sleep ────────────────────────────────────────────────────────
// Every sleep in the pipeline races against a module-scope stop signal.
// When `triggerPipelineStop()` is called (from /api/stop), every pending
// sleep resolves instantly so the loop drops back to its `if (state.stopRequested) break`
// check on the next tick.
const _stopWaiters = new Set();
let _pipelineStopFlag = false;
function sleep(ms) {
  if (_pipelineStopFlag) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = setTimeout(() => { _stopWaiters.delete(wake); resolve(); }, ms);
    const wake = () => { try { clearTimeout(timer); } catch {} _stopWaiters.delete(wake); resolve(); };
    _stopWaiters.add(wake);
  });
}
export function triggerPipelineStop() {
  _pipelineStopFlag = true;
  for (const w of _stopWaiters) { try { w(); } catch {} }
  _stopWaiters.clear();
}
export function resetPipelineStop() {
  _pipelineStopFlag = false;
}

// True when the user clicked Stop. Three signals are checked because the stop
// can race with an in-flight node test: the global state flag, an injected
// `_stopRequested` marker on thrown errors, and the literal string thrown by
// any awaited helper that pre-checks the flag.
export function isStopSignal(state, error) {
  if (state?.stopRequested) return true;
  if (error?._stopRequested) return true;
  const msg = error?.message ?? error;
  return typeof msg === 'string' && msg === 'Stop requested';
}

// Platform-aware imports — Windows / Linux / macOS each have full implementations
let WG_AVAILABLE, IS_ADMIN, emergencyCleanupSync, uninstallWgTunnel, checkV2Ray;
if (process.platform === 'win32') {
  ({ WG_AVAILABLE, IS_ADMIN, emergencyCleanupSync, uninstallWgTunnel } = await import('../platforms/windows/wireguard.js'));
  ({ checkV2Ray } = await import('../platforms/windows/v2ray.js'));
} else if (process.platform === 'linux') {
  ({ WG_AVAILABLE, IS_ADMIN, emergencyCleanupSync, uninstallWgTunnel } = await import('../platforms/linux/wireguard.js'));
  ({ checkV2Ray } = await import('../platforms/linux/v2ray.js'));
} else if (process.platform === 'darwin') {
  ({ WG_AVAILABLE, IS_ADMIN, emergencyCleanupSync, uninstallWgTunnel } = await import('../platforms/macos/wireguard.js'));
  ({ checkV2Ray } = await import('../platforms/macos/v2ray.js'));
} else {
  WG_AVAILABLE = false;
  IS_ADMIN = process.getuid?.() === 0 || false;
  emergencyCleanupSync = () => {};
  uninstallWgTunnel = async () => {};
  checkV2Ray = async () => false;
}
import { checkAndPauseIfInterference, classifyFailure } from '../protocol/diagnostics.js';
import { loadTransportCache, getCacheStats, saveTransportCache } from '../core/transport-cache.js';
import { testNode } from './node-test.js';
import { testWithRetry } from './retry.js';
import { insertResult as _dbInsertResult, insertErrorLog as _dbInsertErrorLog } from '../core/db.js';

// ─── Internet Health Check & Auto-Resume ─────────────────────────────────────
const INTERNET_CHECK_TARGETS = ['https://www.google.com', 'https://1.1.1.1', 'https://www.cloudflare.com'];
const INTERNET_POLL_MS = 15 * 60_000; // 15 minutes

async function checkInternet() {
  for (const url of INTERNET_CHECK_TARGETS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok || res.status < 500) return true;
    } catch {}
  }
  return false;
}

function isInternetError(err) {
  const msg = err?.message || '';
  return /ENETUNREACH|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|fetch failed|socket hang up/i.test(msg);
}

/**
 * Pause audit when internet is down. Poll with backoff until it comes back.
 * Uses short sleep intervals so stop requests take effect quickly.
 * Backoff: 30s → 1m → 2m → 5m → 10m → 15m (max).
 */
async function waitForInternet(broadcast, state) {
  state.status = 'paused_internet';
  state.pauseReason = 'Internet down — checking with backoff';
  broadcast('state', { state });
  broadcast('log', { msg: `\n🌐 Internet appears down. Pausing audit...` });

  const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, INTERNET_POLL_MS];
  let attempt = 0;

  while (!state.stopRequested) {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    // Sleep in 2s chunks so stop requests take effect quickly
    const chunks = Math.ceil(delay / 2000);
    for (let i = 0; i < chunks; i++) {
      if (state.stopRequested) return false;
      await sleep(2000);
    }
    if (state.stopRequested) return false;
    broadcast('log', { msg: `🌐 Checking internet connectivity...` });
    const online = await checkInternet();
    if (online) {
      broadcast('log', { msg: `🌐 ✓ Internet restored! Resuming audit...` });
      state.status = 'running';
      state.pauseReason = null;
      broadcast('state', { state });
      return true;
    }
    const nextDelay = BACKOFF_MS[Math.min(attempt + 1, BACKOFF_MS.length - 1)];
    broadcast('log', { msg: `🌐 ✗ Still down. Next check in ${Math.round(nextDelay / 1000)}s...` });
    attempt++;
  }
  return false;
}

// ─── Results & State (shared across pipeline functions) ─────────────────────
mkdirSync(RESULTS_DIR, { recursive: true });

let results = [];
if (existsSync(RESULTS_FILE)) {
  try { results = JSON.parse(readFileSync(RESULTS_FILE, 'utf8')); } catch { }
}

export function getResults() { return results; }

// ─── Crash-Safe Results Persistence ────────────────────────────────────────
// Write to temp file then rename (atomic on most filesystems).
// Also continuously save to the active run directory so a kill never loses data.
let _activeRunDir = null;
let _activeDbRunId = null;

export function setActiveRunDir(dir) { _activeRunDir = dir; }

/** Set the SQLite run_id for the current audit run (called from server.js). */
export function setActiveDbRunId(id) { _activeDbRunId = id; }
/** Get the current SQLite run_id (null if not yet set). */
export function getActiveDbRunId() { return _activeDbRunId; }

// ─── On-chain reporter (per-run state) ───────────────────────────────────────
// Buffers per-node records during a run and self-sends a memo TX with the
// encoded batch every `onchainBatchSize` nodes. Opt-in via settings; failure
// to commit is non-fatal — audit continues.
let _onchainReporter = null;

function _initOnchainReporter(account, client, state, broadcast) {
  if (!onchainEnabledRT()) { _onchainReporter = null; return; }
  _onchainReporter = {
    enabled: true,
    batchSize: onchainBatchSizeRT(),
    region: onchainRegionRT() || (state.testerCountry || ''),
    baselineMbps: Math.round(state.baselineMbps || 0),
    startedAt: state.startedAt ? new Date(state.startedAt) : new Date(),
    signerAddress: account.address,
    client,
    broadcast,
    buffer: [],
    committed: 0,
    lastTxhash: null,
  };
  broadcast('log', { msg: `📡 On-chain reporting ON — every ${_onchainReporter.batchSize} nodes (region=${_onchainReporter.region || 'auto'}, baseline=${_onchainReporter.baselineMbps}Mbps)` });
}

async function _flushOnchainBatch(force = false) {
  const r = _onchainReporter;
  if (!r || !r.enabled) return;
  if (r.buffer.length === 0) return;
  if (!force && r.buffer.length < r.batchSize) return;
  const batch = r.buffer.splice(0, Math.min(r.buffer.length, 6));
  try {
    const encoded = encodeBatch(
      { region: r.region, baselineMbps: r.baselineMbps, startedAt: r.startedAt },
      batch,
    );
    const res = await commitOnchainBatch(r.client, r.signerAddress, encoded, r.broadcast);
    r.committed += batch.length;
    r.lastTxhash = res.txhash;
    const url = res.txhash ? `https://p2pscan.com/transactions/${res.txhash}` : '';
    r.broadcast('log', { msg: `📡 On-chain report posted: ${batch.length} nodes, ${res.memoBytes}B @h${res.height} → ${url}` });
  } catch (e) {
    r.broadcast('log', { msg: `⚠ On-chain report failed (non-fatal): ${e.message}` });
  }
}

function _bufferOnchainRecord(result) {
  const r = _onchainReporter;
  if (!r || !r.enabled) return;
  const rec = resultToRecord(result);
  if (!rec) return;
  r.buffer.push(rec);
  if (r.buffer.length >= r.batchSize) {
    // Fire and forget — must not block the audit loop.
    _flushOnchainBatch(false).catch(() => {});
  }
}

async function _finalizeOnchainReporter() {
  if (!_onchainReporter) return;
  await _flushOnchainBatch(true);
  if (_onchainReporter) {
    _onchainReporter.broadcast?.('log', { msg: `📡 On-chain reporting done — ${_onchainReporter.committed} nodes posted across ${_onchainReporter.lastTxhash ? 'multiple TXs' : 'no TXs'}.` });
  }
  _onchainReporter = null;
}

export function saveResults() {
  const data = JSON.stringify(results, null, 2);
  const tmpFile = RESULTS_FILE + '.tmp';
  writeFileSync(tmpFile, data, 'utf8');
  try { renameSync(tmpFile, RESULTS_FILE); } catch { writeFileSync(RESULTS_FILE, data, 'utf8'); }

  // Also save to the active run directory (crash-safe copy)
  if (_activeRunDir) {
    const runFile = path.join(_activeRunDir, 'results.json');
    const runTmp = runFile + '.tmp';
    try {
      writeFileSync(runTmp, data, 'utf8');
      try { renameSync(runTmp, runFile); } catch { writeFileSync(runFile, data, 'utf8'); }
    } catch { /* run dir may not exist yet */ }
  }
}

export function logFailure(nodeAddr, error, context = {}) {
  const entry = { ts: new Date().toISOString(), node: nodeAddr, error, ...context };
  appendFileSync(FAILURE_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

// ─── Log-snippet sanitizer ────────────────────────────────────────────────────
// Strip anything that looks like a wallet address, mnemonic, key material,
// or auth header before persisting or broadcasting.
const _WALLET_RE    = /sent1[a-z0-9]{38}/g;
const _MNEMONIC_RE  = /MNEMONIC\s*=\s*\S+/gi;
const _HEX64_RE     = /[0-9a-fA-F]{64}/g;
// 12+ consecutive lowercase ASCII words (3-8 chars each) — BIP-39 mnemonic shape.
// Conservative: requires 12 words minimum; will also catch 24-word phrases.
const _BIP39_RE     = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g;
// Lines containing Bearer tokens or Authorization headers are dropped entirely.
const _AUTH_LINE_RE = /^.*(?:BEARER\s|Authorization:).*/gim;
const _MAX_SNIPPET  = 4096;

function _sanitizeSnippet(raw) {
  if (!raw) return null;
  const s = String(raw)
    .replace(_AUTH_LINE_RE, '[auth-redacted]')
    .replace(_BIP39_RE, '[mnemonic-redacted]')
    .replace(_WALLET_RE, '[addr]')
    .replace(_MNEMONIC_RE, 'MNEMONIC=[redacted]')
    .replace(_HEX64_RE, '[key]');
  return s.length > _MAX_SNIPPET ? s.slice(-_MAX_SNIPPET) : s;
}

function upsertResult(result, logSnippet = null) {
  const idx = results.findIndex(r => r.address === result.address);
  if (idx !== -1) results[idx] = result;
  else results.push(result);

  // ─── On-chain reporter (opt-in, fire-and-forget) ─────────────────────────
  try { _bufferOnchainRecord(result); } catch (e) {
    console.warn('[onchain] buffer failed:', e.message);
  }

  // ─── SQLite persistence (non-blocking — failure must not stop the audit) ─
  if (_activeDbRunId != null) {
    try {
      const resultId = _dbInsertResult(_activeDbRunId, result);
      // For failed tests, also write a detailed error_log row.
      if (result.actualMbps == null && result.error && resultId) {
        try {
          // Derive stage from the error text (mirrors deriveStage in db.js)
          const err = result.error || '';
          let stage = 'other';
          if (/insufficient|no udvpn pricing|no pricing/i.test(err)) stage = 'wallet';
          else if (/rpc|abci query|broadcast|tx failed|sign|code: 1\d\d/i.test(err)) stage = 'rpc';
          else if (/handshake|address mismatch|already exists|409|does not exist/i.test(err)) stage = 'handshake';
          else if (/session|sessionid|waitforsession/i.test(err)) stage = 'session';
          else if (/speed|socks5|mbps|tunnel|throughput/i.test(err)) stage = 'speedtest';
          _dbInsertErrorLog({
            result_id:     Number(resultId),
            stage,
            error_code:    result.errorCode || 'UNKNOWN',
            error_message: err.slice(0, 2048),
            log_snippet:   _sanitizeSnippet(logSnippet),
          });
        } catch (elErr) {
          console.error(`[db] insertErrorLog failed: ${elErr.message}`);
        }
      }
    } catch (dbErr) {
      // Log but never throw — JSON file is the authoritative backup
      console.error(`[db] insertResult failed: ${dbErr.message}`);
    }
  }
}

/**
 * Create initial state object.
 * Note: 'skippedNodes' is now 'failedNodes' — zero-skip system.
 */
export function createState() {
  return {
    status: 'idle',
    totalNodes: 0,
    testedNodes: 0,
    failedNodes: 0,
    skippedNodes: 0,
    retryCount: 0,
    passed15: 0,
    passed10: 0,
    passedBaseline: 0,
    baselineMbps: null,
    baselineHistory: [],
    nodeSpeedHistory: [],
    currentNode: null,
    currentType: null,
    currentLocation: null,
    walletAddress: null,
    balance: null,
    balanceUdvpn: 0,
    estimatedTotalCost: null,
    spentUdvpn: 0,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    stopRequested: false,
    lowBalanceWarning: false,
    pauseReason: null,
    activeBatchId: 0,
    // Address of the node that was in-flight when Stop was received.
    // Cleared once consumed by the next /api/resume so resume picks up
    // with that exact node first instead of whatever order the parallel
    // online-scan happens to return.
    resumeHeadAddr: null,
  };
}

/** Recompute state counters from current results */
function recomputeCounters(state) {
  state.testedNodes = results.filter(r => r.actualMbps != null).length;
  state.failedNodes = results.filter(r => r.actualMbps == null && !r.skipped && r.errorCode !== 'TEST_RUN_SKIP').length;
  state.skippedNodes = results.filter(r => r.skipped || r.errorCode === 'TEST_RUN_SKIP').length;
  state.passed15 = results.filter(r => r.baselineAtTest >= 30 && r.actualMbps >= 15).length;
  state.passed10 = results.filter(r => r.actualMbps >= 10).length;
  state.passedBaseline = results.filter(r => {
    const thresh = r.dynamicThreshold != null ? r.dynamicThreshold
      : (r.baselineAtTest != null ? r.baselineAtTest * 0.5 : null);
    return thresh != null && r.actualMbps >= thresh;
  }).length;
}

/**
 * Bucket a probe error into a coarse category so the dashboard log shows
 * *why* nodes are offline instead of a meaningless "0 online".
 */
function classifyProbeError(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  const code = err?.code || '';
  if (msg.includes('timeout') || code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'TIMEOUT';
  if (code === 'ENOTFOUND' || msg.includes('getaddrinfo') || msg.includes('enotfound')) return 'DNS_FAIL';
  if (code === 'ECONNREFUSED' || msg.includes('econnrefused')) return 'TCP_REFUSED';
  if (code === 'ECONNRESET' || msg.includes('econnreset')) return 'TCP_RESET';
  if (code === 'EHOSTUNREACH' || msg.includes('ehostunreach')) return 'HOST_UNREACH';
  if (code === 'ENETUNREACH' || msg.includes('enetunreach')) return 'NET_UNREACH';
  if (msg.includes('cert') || msg.includes('tls') || msg.includes('ssl') || msg.includes('self-signed') || msg.includes('certificate')) return 'TLS_FAIL';
  if (msg.includes('no result') || msg.includes('empty')) return 'EMPTY_RESPONSE';
  if (msg.includes('http')) return 'HTTP_ERROR';
  return 'OTHER';
}

/** Scan nodes for online status in parallel */
async function scanNodesParallel(nodes, concurrency, broadcast, state) {
  const online = [];
  const errorBuckets = Object.create(null);
  let idx = 0;
  let scanned = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= nodes.length) break;
      const node = nodes[i];
      try {
        const status = await Promise.race([
          nodeStatusV3(node.remoteUrl),
          sleep(6000).then(() => { throw new Error('timeout'); }),
        ]);
        online.push({ node, status });
      } catch (err) {
        const bucket = classifyProbeError(err);
        errorBuckets[bucket] = (errorBuckets[bucket] || 0) + 1;
      }
      scanned++;
      if (scanned % 100 === 0 || scanned === nodes.length) {
        // Bucket bracket only on the final summary line. Intermediate
        // milestones stay clean — operators can read the full breakdown
        // off the final line or the per-node failure log.
        const isFinal = scanned === nodes.length;
        let tail = '';
        if (isFinal) {
          const bucketSummary = Object.entries(errorBuckets)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ');
          if (bucketSummary) tail = ` [${bucketSummary}]`;
        }
        if (broadcast) broadcast('log', { msg: `  Scanned ${scanned}/${nodes.length} — ${online.length} online${tail}` });
        if (broadcast) broadcast('state', { state });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, nodes.length) }, worker));
  // Stash on state so callers can surface buckets in summary logs / API.
  if (state) state.lastScanErrorBuckets = errorBuckets;
  online.errorBuckets = errorBuckets;
  return online;
}

// Exported for universal-test reachability phase.
export { scanNodesParallel, classifyProbeError };

/**
 * Build a FAIL result from an error (zero-skip: every failure is explicit).
 */
function buildFailResult(node, status, state, errMsg, diag = {}) {
  const bl = state.baselineMbps;
  // Use diag or previous result data for fields when status is null (retest path)
  const prevResult = results.find(r => r.address === node.address);
  return {
    timestamp: new Date().toISOString(),
    address: node.address,
    type: state.currentType || status?.type || prevResult?.type || null,
    moniker: status?.moniker || prevResult?.moniker || '',
    country: status?.location?.country || prevResult?.country || '',
    countryCode: status?.location?.country_code || prevResult?.countryCode || '',
    city: status?.location?.city || prevResult?.city || '',
    reportedDownloadMbps: 0,
    actualMbps: null,
    baselineAtTest: bl ?? null,
    ispBottleneck: false,
    baselineViable: bl != null && bl >= 30,
    dynamicThreshold: bl != null ? parseFloat((bl * 0.5).toFixed(2)) : null,
    slaApplicable: bl != null && bl >= 30,
    pass15mbps: false,
    pass10mbps: false,
    passBaseline: false,
    peers: status?.peers ?? prevResult?.peers ?? null,
    maxPeers: status?.qos?.max_peers ?? prevResult?.maxPeers ?? null,
    gigabytePrices: node.gigabyte_prices || [],
    inPlan: (node.planIds || []).length > 0,
    planIds: node.planIds || [],
    googleAccessible: null,
    googleLatencyMs: null,
    sdk: state.activeSDK || 'js',
    os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    error: errMsg,
    timedOut: /timeout/i.test(errMsg),
    diag,
  };
}

// ─── Main Audit ─────────────────────────────────────────────────────────────
export async function runAudit(resume, state, broadcast, preloadedNodes = null, opts = {}) {
  resetPipelineStop();
  refreshAuditSettings();
  state.status = 'running';
  // Preserve the original startedAt across Stop/Resume so the dashboard's
  // "started at" / ETA / elapsed-time mirror the original run exactly.
  // Only stamp a fresh time on a brand-new run.
  if (!resume || !state.startedAt) state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.retryCount = 0;
  state.retestMode = false;
  state.retestPassed = null;
  state.retestFailed = null;

  state.testRun = !!opts.testRun;
  // Route isolation — pin runMode so a leftover 'subscription' from a prior
  // sub-plan run cannot accidentally propagate into a P2P / TEST_RUN audit.
  state.runMode = state.testRun ? 'test' : 'p2p';
  if (state.runMode !== 'subscription') {
    state.runPlanId = null;
    state.runSubscriptionId = null;
    state.runGranter = null;
  }

  clearPoisonedSessions();
  clearPaidNodes();
  clearAllCredentials(); // Wipe stale sessions from previous runs — force fresh payment
  invalidateSessionCache(); // Wipe stale session map — prevents wrong node→session mapping
  broadcast('state', { state });

  // Create audit log file. On resume, reuse the prior run's log file so the
  // entire run appends to a single file — otherwise a Stop/Resume splits the
  // log across multiple files and the boot-time logBuffer rehydration only
  // sees the newest one (prior-run logs vanish from /api/public/logs).
  let auditLogPath;
  if (resume && state.auditLogPath && existsSync(state.auditLogPath)) {
    auditLogPath = state.auditLogPath;
  } else {
    const logTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    auditLogPath = path.join(PROJECT_ROOT, 'results', `audit-${logTs}.log`);
    state.auditLogPath = auditLogPath;
  }
  const logLine = (msg) => { try { appendFileSync(auditLogPath, msg + '\n', 'utf8'); } catch {} };
  if (resume) {
    logLine(`${'='.repeat(80)}`);
    logLine(`RESUMED: ${new Date().toISOString()}`);
    logLine(`${'='.repeat(80)}`);
  } else {
    logLine(`Sentinel Node Tester — Full Audit Log`);
    logLine(`Started: ${state.startedAt} | Resume: ${resume}`);
    logLine(`${'='.repeat(80)}`);
  }

  // Wrap broadcast to also write to log file
  const origBroadcast = broadcast;
  broadcast = (type, data) => {
    origBroadcast(type, data);
    if (type === 'log' && data?.msg) logLine(data.msg);
  };

  broadcast('log', { msg: `📝 Log file: results/${path.basename(auditLogPath)}${resume ? ' (resumed — appending)' : ''}` });

  // ─── Wallet / client setup ────────────────────────
  broadcast('log', { msg: '🔑 Setting up wallet...' });
  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  broadcast('log', { msg: `Wallet: ${account.address}` });

  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
  state.spentUdvpn = 0;

  if (resume) {
    broadcast('log', { msg: `Resuming audit with ${results.length} existing results...` });
    recomputeCounters(state);
  } else {
    results.length = 0;
    state.testedNodes = 0;
    state.failedNodes = 0;
    state.passed15 = 0;
    state.passed10 = 0;
    state.passedBaseline = 0;
    state.nodeSpeedHistory = [];
    state.baselineHistory = [];
    saveResults();
  }

  broadcast('log', { msg: `Balance: ${state.balance}` });
  broadcast('state', { state });

  const v2rayAvailable = await checkV2Ray();
  broadcast('log', { msg: `V2Ray:     ${v2rayAvailable ? '✓ available' : '✗ not found'}` });
  broadcast('log', { msg: `WireGuard: ${WG_AVAILABLE ? '✓ available' : '✗ not found'}` });
  const _adminGood = process.platform === 'win32' ? '✓ running as Administrator' : '✓ running as root';
  const _adminBad = process.platform === 'win32'
    ? '⚠ NOT admin — use SentinelAudit.vbs for WireGuard'
    : '⚠ NOT root — run with sudo for WireGuard';
  broadcast('log', { msg: `Admin:     ${IS_ADMIN ? _adminGood : _adminBad}` });

  // ── Transport intelligence cache ────────────────────────────────────────
  loadTransportCache();
  const cacheStats = getCacheStats();
  if (cacheStats.nodesCached > 0) {
    broadcast('log', { msg: `🧠 Transport cache: ${cacheStats.nodesCached} nodes learned` });
    for (const ts of cacheStats.transportStats.slice(0, 5)) {
      broadcast('log', { msg: `   ${ts.transport}: ${ts.rate} (${ts.successes}/${ts.attempts})` });
    }
  } else {
    broadcast('log', { msg: `🧠 Transport cache: empty — will learn as we go` });
  }

  const cfIp = await resolveCfHost();
  if (cfIp) broadcast('log', { msg: `Cloudflare CDN resolved: ${cfIp} (cached for tunnel tests)` });

  // ── Baseline speed ─────────────────────────────────────────────────────
  broadcast('log', { msg: '📡 Running baseline speed test (direct connection)...' });
  try {
    const baseline = await speedtestDirect();
    state.baselineMbps = baseline.mbps;
    broadcast('log', { msg: `Baseline speed: ${baseline.mbps} Mbps (${baseline.chunks} chunks, ${baseline.adaptive})` });
    broadcast('state', { state });
  } catch (e) {
    broadcast('log', { msg: `Baseline speed test failed: ${_sanitizeSnippet(e.message)}` });
  }

  // ── On-chain reporter (opt-in) ─────────────────────────────────────────
  _initOnchainReporter(account, client, state, broadcast);

  async function refreshBaseline() {
    try {
      const bl = await speedtestDirect();
      state.baselineMbps = bl.mbps;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      state.baselineHistory = [...state.baselineHistory, { mbps: bl.mbps, ts }].slice(-10);
      broadcast('state', { state });
    } catch { }
  }

  // ── Phase 1: Fetch node list ───────────────────────────────────────────
  let allNodes;
  if (Array.isArray(preloadedNodes) && preloadedNodes.length > 0) {
    broadcast('log', { msg: `🔒 Using frozen snapshot (${preloadedNodes.length} nodes).` });
    allNodes = preloadedNodes;
  } else {
    broadcast('log', { msg: '🔍 Fetching node list...' });
    allNodes = await Promise.race([
      getAllNodes(broadcast),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Node list fetch timeout (60s)')), 60_000)),
    ]);
  }
  const nodesToTest = MAX_NODES > 0 ? allNodes.slice(0, MAX_NODES) : allNodes;
  broadcast('log', { msg: `Fetched ${nodesToTest.length} nodes total.` });
  broadcast('state', { state });

  // ── Phase 2: Parallel online scan ──
  broadcast('log', { msg: `\n🔍 Phase 2: Scanning ${nodesToTest.length} nodes in parallel (30 concurrent)...` });
  const onlineNodes = await scanNodesParallel(nodesToTest, 30, broadcast, state);
  broadcast('log', { msg: `Scan complete: ${onlineNodes.length}/${nodesToTest.length} online.` });

  const viableNodes = onlineNodes.filter(({ node, status }) => {
    if (status.type === 'wireguard' && !WG_AVAILABLE) return false;
    if (status.type === 'v2ray' && !v2rayAvailable) return false;
    return (node.gigabyte_prices || []).some(p => p.denom === DENOM);
  });

  // Resume mode: filter already-tested
  if (resume) {
    const testedAddrs = new Set(results.map(r => r.address));
    const before = viableNodes.length;
    const filtered = viableNodes.filter(({ node }) => !testedAddrs.has(node.address));
    // Hoist the in-flight (interrupted) node to position 0 so resume picks
    // up exactly where Stop hit. scanNodesParallel returns nodes in
    // race-completion order, so without this hoist the interrupted node
    // ends up wherever its probe happened to finish.
    const headAddr = state.resumeHeadAddr;
    if (headAddr) {
      const hi = filtered.findIndex(({ node }) => node.address === headAddr);
      if (hi > 0) {
        const [head] = filtered.splice(hi, 1);
        filtered.unshift(head);
        broadcast('log', { msg: `Resume: starting with interrupted node ${headAddr.slice(0, 20)}…` });
      } else if (hi === 0) {
        broadcast('log', { msg: `Resume: starting with interrupted node ${headAddr.slice(0, 20)}…` });
      }
    }
    viableNodes.length = 0;
    viableNodes.push(...filtered);
    broadcast('log', { msg: `Resume: skipping ${before - viableNodes.length} already-tested, ${viableNodes.length} remaining.` });
  }

  state.totalNodes = (resume ? results.length : 0) + viableNodes.length;
  const estCostUdvpn = viableNodes.reduce(
    (sum, { node }) => sum + parseNodePriceUdvpn(node.gigabyte_prices) * GIGS, 0
  );
  const avgCostPerNode = viableNodes.length > 0 ? estCostUdvpn / viableNodes.length : 0;
  state.estimatedTotalCost = '0.0000 P2P';
  broadcast('log', { msg: `${viableNodes.length} testable nodes. ~${(avgCostPerNode / 1_000_000).toFixed(4)} P2P/node avg, ~${(estCostUdvpn / 1_000_000).toFixed(2)} P2P total est.` });
  broadcast('state', { state });

  if (!IS_ADMIN && WG_AVAILABLE) {
    broadcast('log', { msg: '⚠ NOT running as Administrator — WireGuard nodes will fail!' });
  }

  // ── Phase 3: Batched payment + sequential test ─────────────────────────
  const batches = [];
  for (let i = 0; i < viableNodes.length; i += BATCH_SIZE) {
    batches.push(viableNodes.slice(i, i + BATCH_SIZE));
  }
  broadcast('log', { msg: `\n💳 Phase 3: ${batches.length} payment batches × ${BATCH_SIZE} nodes.` });

  let _lastBalanceRefresh = Date.now();
  const BALANCE_REFRESH_INTERVAL = 5 * 60_000; // Refresh real balance every 5 minutes

  for (let b = 0; b < batches.length; b++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); break; }
    const batch = batches[b];

    // Periodic real balance refresh (prevents stale estimate drift)
    if (Date.now() - _lastBalanceRefresh > BALANCE_REFRESH_INTERVAL) {
      try {
        const freshBal = await client.getBalance(account.address, DENOM);
        const realBalance = parseInt(freshBal?.amount || '0', 10);
        state.balanceUdvpn = realBalance;
        state.spentUdvpn = 0; // Reset spent — real balance is the truth
        state.balance = `${(realBalance / 1_000_000).toFixed(4)} P2P`;
        _lastBalanceRefresh = Date.now();
      } catch { /* non-critical — estimate continues */ }
    }

    // VPN interference check before each batch
    const canProceed = await checkAndPauseIfInterference(broadcast, state);
    if (!canProceed) { broadcast('log', { msg: '⏹ Aborting — VPN interference not cleared.' }); break; }

    let batchSessionMap;
    if (state.testRun) {
      batchSessionMap = new Map();
    } else {
      try {
        broadcast('log', { msg: `\n💳 Batch ${b + 1}/${batches.length} (${batch.length} nodes) — paying...` });
        batchSessionMap = await submitBatchPayment(client, account, DENOM, GIGS, batch, state, broadcast);
      } catch (payErr) {
        // Insufficient funds from chain — pause instead of failing
        if (/insufficient funds|insufficient balance/i.test(payErr.message)) {
          broadcast('log', { msg: `💰 Batch payment failed: insufficient P2P. Pausing...` });
          state.status = 'paused_balance';
          state.pauseReason = `Insufficient P2P for batch payment`;
          broadcast('state', { state });
          let restored = false;
          while (!state.stopRequested) {
            await sleep(5 * 60_000);
            if (state.stopRequested) break;
            try {
              const freshBal = await client.getBalance(account.address, DENOM);
              const realBal = parseInt(freshBal?.amount || '0', 10);
              state.balanceUdvpn = realBal;
              state.spentUdvpn = 0;
              state.balance = `${(realBal / 1_000_000).toFixed(4)} P2P`;
              broadcast('log', { msg: `💰 Balance check: ${state.balance}` });
              if (realBal > 1_000_000) {
                broadcast('log', { msg: `💰 Balance restored! Retrying batch...` });
                state.status = 'running';
                state.pauseReason = null;
                broadcast('state', { state });
                restored = true;
                break;
              }
            } catch { }
          }
          if (!restored) break;
          // Retry the batch payment
          try {
            batchSessionMap = await submitBatchPayment(client, account, DENOM, GIGS, batch, state, broadcast);
          } catch (retryErr) {
            broadcast('log', { msg: `  Batch retry also failed: ${_sanitizeSnippet(retryErr.message)}` });
            batchSessionMap = new Map();
          }
        } else {
          broadcast('log', { msg: `  Batch payment FAILED: ${_sanitizeSnippet(payErr.message)}` });
          broadcast('log', { msg: `  Falling back to individual payments per node...` });
          batchSessionMap = new Map();
        }
      }

      const reusedAddrs = batchSessionMap._reusedAddrs || new Set();
      const newSessionAddrs = [...batchSessionMap.keys()].filter(a => !reusedAddrs.has(a));
      if (newSessionAddrs.length > 0) {
        broadcast('log', { msg: `  Polling chain for ${newSessionAddrs.length} new sessions...` });
        await waitForBatchSessions(newSessionAddrs, account.address, 20_000);
        broadcast('log', { msg: `  Sessions confirmed ✓` });
      }
    }

    // Test each node with zero-skip retry
    for (let j = 0; j < batch.length; j++) {
      if (state.stopRequested) break;
      const { node, status } = batch[j];
      const sessionId = batchSessionMap.get(node.address) || null;
      const nodeNum = b * BATCH_SIZE + j + 1;

      state.currentNode = node.address;
      // Pin the in-flight node so /api/resume hoists it back to position 0.
      // Cleared the moment we record a result for this node (success or fail).
      state.resumeHeadAddr = node.address;
      broadcast('state', { state });
      broadcast('log', { msg: `[${nodeNum}/${viableNodes.length}] Testing ${node.address.slice(0, 20)}…` });

      await refreshBaseline();

      // ─── Per-node log buffer (last 40 lines or 4 KB) ───────────────────
      // Intercept broadcast('log') during the test to capture log lines for
      // error_logs.log_snippet. The outer broadcast (SSE + file log) is
      // still called — we add capture on top.
      const _nodeLogLines = [];
      const _MAX_LOG_LINES = 40;
      const _MAX_LOG_BYTES = 4096;
      const _capturingBroadcast = (type, data) => {
        broadcast(type, data);
        if (type === 'log' && data?.msg) {
          _nodeLogLines.push(String(data.msg));
          if (_nodeLogLines.length > _MAX_LOG_LINES) _nodeLogLines.shift();
        }
      };

      let result, retried, error;
      ({ result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          sessionId, _capturingBroadcast, state
        ),
        _capturingBroadcast, state, node.address,
      ));

      // Build snippet: last 40 lines, trimmed to 4 KB from the tail
      const _rawSnippet = _nodeLogLines.join('\n');
      const _logSnippet = _rawSnippet.length > _MAX_LOG_BYTES
        ? _rawSnippet.slice(-_MAX_LOG_BYTES)
        : (_rawSnippet || null);

      if (result) {
        state.testedNodes++;
        if (result.slaApplicable && result.pass15mbps) state.passed15++;
        if (result.pass10mbps) state.passed10++;
        if (result.passBaseline) state.passedBaseline++;
        upsertResult(result); // success — no snippet needed
        state.resumeHeadAddr = null;
        saveResults();
        broadcast('result', { result, state });
        if (result.actualMbps != null) {
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          state.nodeSpeedHistory = [...state.nodeSpeedHistory, { mbps: result.actualMbps, addr: node.address.slice(0, 14), ts }].slice(-10);
          broadcast('state', { state });
        }
        const retryLabel = retried > 0 ? ` (${retried} retries)` : '';
        broadcast('log', { msg: `✓ [${nodeNum}/${viableNodes.length}] ${result.actualMbps != null ? result.actualMbps + ' Mbps' : 'N/A'} | baseline ${state.baselineMbps != null ? state.baselineMbps + ' Mbps' : '--'}${retryLabel}` });
      } else {
        const errMsg = error?.message || 'Unknown error';

        // ─── Stop requested — NOT a failure ────────────────────────────
        // When user pauses/stops, the current node should remain untested
        // so it's first in line on resume. Don't record, don't increment.
        // Stop requested — NOT a failure. The in-flight node's V2Ray was killed
        // by /api/stop, which surfaces as ECONNREFUSED/speedtest errors here.
        // Trust state.stopRequested over the error message — anything thrown
        // after the user clicked Stop is collateral, not a real node failure.
        if (isStopSignal(state, error)) {
          broadcast('log', { msg: `⏸ Node ${node.address.slice(0, 20)}… interrupted — will retry on resume` });
          break;
        }

        // ─── Insufficient balance — PAUSE, don't fail ──────────────────
        // Balance issues are wallet problems, not node problems. Pause the
        // audit and poll for balance top-up. The node stays untested (not failed).
        if (error?._pauseAudit || /INSUFFICIENT_BALANCE|insufficient funds/i.test(errMsg)) {
          broadcast('log', { msg: `💰 Insufficient P2P balance — pausing audit. Top up wallet and balance will be checked every 5 minutes.` });
          state.status = 'paused_balance';
          state.pauseReason = `Insufficient P2P balance (${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(2)} P2P remaining)`;
          broadcast('state', { state });

          // Poll for balance top-up every 5 minutes
          let balanceRestored = false;
          while (!state.stopRequested) {
            await sleep(5 * 60_000);
            if (state.stopRequested) break;
            try {
              const freshBal = await client.getBalance(account.address, DENOM);
              const realBalance = parseInt(freshBal?.amount || '0', 10);
              state.balanceUdvpn = realBalance;
              state.spentUdvpn = 0;
              state.balance = `${(realBalance / 1_000_000).toFixed(4)} P2P`;
              broadcast('log', { msg: `💰 Balance check: ${state.balance}` });
              if (realBalance > 1_000_000) { // > 1 P2P
                broadcast('log', { msg: `💰 Balance restored! Resuming audit...` });
                state.status = 'running';
                state.pauseReason = null;
                broadcast('state', { state });
                balanceRestored = true;
                break;
              }
            } catch (balErr) {
              broadcast('log', { msg: `💰 Balance check failed: ${_sanitizeSnippet(balErr.message)} — retrying in 5 min` });
            }
          }
          if (!balanceRestored) break; // stopRequested
          // Retry this same node — decrement j so the loop re-tests it
          j--;
          continue;
        }

        // FAIL result — zero-skip: explicit failure
        const failResult = buildFailResult(node, status, state, errMsg, error?.diag || {});
        state.failedNodes++;
        upsertResult(failResult, _logSnippet);
        state.resumeHeadAddr = null;
        saveResults();
        broadcast('result', { result: failResult, state });
        const retryLabel = retried > 0 ? ` (${retried} retries)` : '';
        const label = /timeout/i.test(errMsg) ? '⏱ Timeout' : /already exists/i.test(errMsg) ? '🚫 Node bug' : 'FAIL';
        broadcast('log', { msg: `${label} [${node.address.slice(0, 20)}…]: ${errMsg}${retryLabel}` });

        // ─── Internet-down detection ───────────────────────────────────
        // If this failure looks like a network issue, clean up tunnels FIRST
        // (WG can corrupt routing tables), then check if internet is really down.
        if (isInternetError(error) && !state.stopRequested) {
          // Clean up WireGuard/V2Ray before checking — tunnel may be corrupting routes
          try { await uninstallWgTunnel(); } catch { }
          emergencyCleanupSync();
          await sleep(1000); // Let routing tables settle
          const online = await checkInternet();
          if (!online) {
            // Mark this node for retest after internet returns
            if (!state._internetFailAddrs) state._internetFailAddrs = new Set();
            state._internetFailAddrs.add(node.address);
            const resumed = await waitForInternet(broadcast, state);
            if (!resumed) break;
          }
        }
      }

      // Cleanup
      try { await uninstallWgTunnel(); } catch { }
      await sleep(500);
      emergencyCleanupSync();
      if (NODE_DELAY > 0) await sleep(NODE_DELAY);
    }

    // ─── Auto-cancel sessions in this batch (post-test) ──────────────────────
    // When `autoCancelAfterTest` is on and we're not in TEST RUN, broadcast a
    // single MsgCancelSession TX for every session we just paid for. The chain
    // moves them into inactive_pending; the per-node refund (deposit minus
    // bytes consumed during the ~10s speedtest) is paid out by the chain after
    // the settlement window. This is the difference between locking the full
    // 1 GB deposit per node forever vs. recovering ~98% of it per audit cycle.
    if (autoCancelRT() && !state.testRun && batchSessionMap && batchSessionMap.size > 0) {
      const idsToCancel = [...batchSessionMap.values()];
      try {
        await submitBatchCancel(client, account, idsToCancel, broadcast);
      } catch (cancelErr) {
        broadcast('log', { msg: `  ⚠ Batch cancel raised: ${_sanitizeSnippet(cancelErr.message)}. Continuing.` });
      }
    }
  }

  emergencyCleanupSync();
  saveTransportCache();

  // ─── Auto-retest internet-failure nodes ─────────────────────────────────
  const internetFailAddrs = state._internetFailAddrs;
  if (internetFailAddrs && internetFailAddrs.size > 0 && !state.stopRequested) {
    broadcast('log', { msg: `\n🌐 Retesting ${internetFailAddrs.size} nodes that failed during internet outage...` });
    state.retestMode = true;
    clearPoisonedSessions();
    clearPaidNodes();
    const retestNodes = viableNodes.filter(n => internetFailAddrs.has(n.node.address));

    for (let ri = 0; ri < retestNodes.length; ri++) {
      if (state.stopRequested) break;
      const { node, status } = retestNodes[ri];
      state.currentNode = node.address;
      broadcast('state', { state });
      broadcast('log', { msg: `🌐 [${ri + 1}/${retestNodes.length}] Retesting ${node.address.slice(0, 20)}… (internet-failure recovery)` });

      const _irLogLines = [];
      const _irBroadcast = (type, data) => {
        broadcast(type, data);
        if (type === 'log' && data?.msg) {
          _irLogLines.push(String(data.msg));
          if (_irLogLines.length > 40) _irLogLines.shift();
        }
      };

      const { result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          null, _irBroadcast, state
        ),
        _irBroadcast, state, node.address,
      );
      const _irRaw = _irLogLines.join('\n');
      const _irSnippet = _irRaw.length > 4096 ? _irRaw.slice(-4096) : (_irRaw || null);

      if (isStopSignal(state, error)) {
        broadcast('log', { msg: `⏸ Internet-recovery retest interrupted — remaining nodes untouched` });
        break;
      }

      if (result) {
        state.failedNodes = Math.max(0, state.failedNodes - 1);
        state.testedNodes++;
        if (result.pass10mbps) state.passed10++;
        upsertResult(result);
        saveResults();
        broadcast('result', { result, state });
        broadcast('log', { msg: `  ✓ Internet-recovery retest PASS: ${result.actualMbps} Mbps` });
      } else {
        const errMsg = error?.message || 'Unknown';
        const failResult = buildFailResult(node, status, state, errMsg, error?.diag || {});
        upsertResult(failResult, _sanitizeSnippet(_irSnippet));
        saveResults();
        broadcast('result', { result: failResult, state });
        broadcast('log', { msg: `  ✗ Internet-recovery retest FAIL: ${errMsg.slice(0, 80)}` });
      }

      try { await uninstallWgTunnel(); } catch { }
      emergencyCleanupSync();
      if (NODE_DELAY > 0) await sleep(NODE_DELAY);
    }
    state.retestMode = false;
    state._internetFailAddrs = null;
  }

  // ─── Auto-retest failures with peers (Iron Rule) ──────────────────────────
  const failedWithPeers = results.filter(r => r.actualMbps == null && r.error && (r.peers ?? 0) > 0);
  if (failedWithPeers.length > 0 && !state.stopRequested) {
    broadcast('log', { msg: `🔄 Auto-retesting ${failedWithPeers.length} failures with peers > 0 (Iron Rule)...` });
    state.retestMode = true;
    clearPoisonedSessions();
    clearPaidNodes();
    const failAddrs = failedWithPeers.map(r => r.address);
    const retestNodes = viableNodes.filter(n => failAddrs.includes(n.node.address));

    for (let ri = 0; ri < retestNodes.length; ri++) {
      if (state.stopRequested) break;
      const { node, status } = retestNodes[ri];
      state.currentNode = node.address;
      broadcast('state', { state });
      broadcast('log', { msg: `🔄 [${ri + 1}/${retestNodes.length}] Retesting ${node.address.slice(0, 20)}…` });

      const _ironLogLines = [];
      const _ironBroadcast = (type, data) => {
        broadcast(type, data);
        if (type === 'log' && data?.msg) {
          _ironLogLines.push(String(data.msg));
          if (_ironLogLines.length > 40) _ironLogLines.shift();
        }
      };

      const { result, retried, error } = await testWithRetry(
        () => testNode(client, account, privkey, node,
          { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
          null, _ironBroadcast, state
        ),
        _ironBroadcast, state, node.address,
      );
      const _ironRaw = _ironLogLines.join('\n');
      const _ironSnippet = _ironRaw.length > 4096 ? _ironRaw.slice(-4096) : (_ironRaw || null);

      if (isStopSignal(state, error)) {
        broadcast('log', { msg: `⏸ Iron Rule retest interrupted — remaining nodes untouched` });
        break;
      }

      if (result) {
        state.failedNodes = Math.max(0, state.failedNodes - 1);
        state.testedNodes++;
        if (result.pass10mbps) state.passed10++;
        upsertResult(result);
        saveResults();
        broadcast('result', { result, state });
        broadcast('log', { msg: `  ✓ Retest PASS: ${result.actualMbps} Mbps` });
      } else {
        const errMsg = error?.message || 'Unknown';
        const failResult = buildFailResult(node, status, state, errMsg, error?.diag || {});
        upsertResult(failResult, _sanitizeSnippet(_ironSnippet));
        saveResults();
        broadcast('result', { result: failResult, state });
        broadcast('log', { msg: `  ✗ Retest FAIL: ${errMsg.slice(0, 80)}` });
      }

      try { await uninstallWgTunnel(); } catch { }
      emergencyCleanupSync();
      if (NODE_DELAY > 0) await sleep(NODE_DELAY);
    }
    state.retestMode = false;
  }

  const finalCache = getCacheStats();
  await _finalizeOnchainReporter();
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  broadcast('state', { state });
  const finalFailed = results.filter(r => r.actualMbps == null && r.error).length;
  broadcast('log', { msg: `✅ Audit complete. Tested ${state.testedNodes}, Failed ${finalFailed}. ${state.retryCount} retries total.` });
  broadcast('log', { msg: `🧠 Transport cache: ${finalCache.nodesCached} nodes learned for next scan.` });
}

// ─── Retest Previously-Failed Nodes ─────────────────────────────────────────
export async function runRetestSkips(skipAddrs, state, broadcast) {
  resetPipelineStop();
  refreshAuditSettings();
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.retryCount = 0;
  state.retestMode = true;
  state.retestTotal = skipAddrs.length;
  state.retestTested = 0;
  state.retestPassed = 0;
  state.retestFailed = 0;
  recomputeCounters(state);
  state.totalNodes = state.testedNodes + state.failedNodes; // show grand total
  clearPoisonedSessions();
  clearPaidNodes();
  invalidateSessionCache(); // Force fresh session lookups — prevents stale mappings
  broadcast('state', { state });

  // Create test log file
  const logTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(PROJECT_ROOT, 'results', `retest-${logTs}.log`);
  const logLine = (msg) => appendFileSync(logPath, msg + '\n', 'utf8');
  logLine(`Sentinel Node Tester — Retest Log`);
  logLine(`Started: ${state.startedAt}`);
  logLine(`Nodes to retest: ${skipAddrs.length}`);
  logLine(`${'='.repeat(80)}`);

  broadcast('log', { msg: `🔄 Retesting ${skipAddrs.length} previously-failed nodes...` });
  broadcast('log', { msg: `📝 Log file: results/retest-${logTs}.log` });

  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
  state.spentUdvpn = 0;
  broadcast('state', { state });

  const v2rayAvailable = await checkV2Ray();
  const cfIp = await resolveCfHost();
  if (cfIp) broadcast('log', { msg: `Cloudflare CDN resolved: ${cfIp}` });

  loadTransportCache();
  const cacheStats = getCacheStats();
  if (cacheStats.nodesCached > 0) {
    broadcast('log', { msg: `🧠 Transport cache: ${cacheStats.nodesCached} nodes learned` });
  }

  broadcast('log', { msg: '📡 Running baseline...' });
  try {
    const bl = await speedtestDirect();
    state.baselineMbps = bl.mbps;
    broadcast('log', { msg: `Baseline: ${bl.mbps} Mbps` });
  } catch (e) { broadcast('log', { msg: `Baseline failed: ${_sanitizeSnippet(e.message)}` }); }

  _initOnchainReporter(account, client, state, broadcast);

  broadcast('log', { msg: '🔍 Fetching node list...' });
  const allNodes = await getAllNodes(broadcast);

  const skipSet = new Set(skipAddrs);
  const toTest = allNodes.filter(n => skipSet.has(n.address));

  // Direct lookup for nodes not found in paginated list (pagination can miss nodes)
  // RPC-only per global rule; withFreshRpc rotates to a new RPC on failure.
  const foundAddrs = new Set(toTest.map(n => n.address));
  const missingAddrs = skipAddrs.filter(a => !foundAddrs.has(a));
  if (missingAddrs.length > 0) {
    broadcast('log', { msg: `⚠ ${missingAddrs.length} nodes not in paginated list — doing direct RPC lookup...` });
    for (const addr of missingAddrs) {
      try {
        const node = await withFreshRpc(
          (rpc) => rpcQueryNode(rpc, addr),
          `rpcQueryNode(${addr.slice(0, 20)}…)`,
        );
        if (node) {
          const rawAddrs = (node.remote_addrs || []).filter(Boolean);
          const rawAddr = rawAddrs[0] || '';
          toTest.push({
            address: node.address || addr,
            remoteUrl: rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`,
            remoteAddrs: rawAddrs.map(a => a.startsWith('http') ? a : `https://${a}`),
            gigabyte_prices: node.gigabyte_prices || [],
            hourly_prices: node.hourly_prices || [],
            planIds: [],
          });
          broadcast('log', { msg: `  ✓ Found ${addr.slice(0, 20)}… via RPC` });
        }
      } catch (e) {
        broadcast('log', { msg: `  ✗ ${addr.slice(0, 20)}… RPC lookup failed: ${_sanitizeSnippet(e.message?.slice(0, 50))}` });
      }
    }
  }
  broadcast('log', { msg: `Found ${toTest.length}/${skipAddrs.length} nodes to retest.` });

  state.retestTotal = toTest.length;
  state.retestTested = 0;
  state.retestPassed = 0;
  state.retestFailed = 0;
  broadcast('state', { state });

  logLine(`Nodes found on chain: ${toTest.length}/${skipAddrs.length}`);
  logLine(`Baseline: ${state.baselineMbps || '?'} Mbps`);
  logLine(`${'─'.repeat(80)}`);

  for (let i = 0; i < toTest.length; i++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); logLine('STOPPED by user'); break; }
    const node = toTest[i];
    const testNum = i + 1;
    state.currentNode = node.address;
    state.retestTested = testNum;
    broadcast('state', { state });
    broadcast('log', { msg: `[#${testNum}/${toTest.length}] Retesting ${node.address.slice(0, 20)}…` });
    logLine(`\n[#${testNum}/${toTest.length}] ${node.address}`);

    const _rrLogLines = [];
    const _rrBroadcast = (type, data) => {
      broadcast(type, data);
      if (type === 'log' && data?.msg) {
        _rrLogLines.push(String(data.msg));
        if (_rrLogLines.length > 40) _rrLogLines.shift();
      }
    };

    const { result, retried, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps },
        null, _rrBroadcast, state
      ),
      _rrBroadcast, state, node.address,
    );
    const _rrRaw = _rrLogLines.join('\n');
    const _rrSnippet = _rrRaw.length > 4096 ? _rrRaw.slice(-4096) : (_rrRaw || null);

    if (isStopSignal(state, error)) {
      broadcast('log', { msg: `⏸ Retest interrupted — remaining nodes untouched` });
      logLine(`  STOPPED by user (node not counted as failed)`);
      break;
    }

    if (result && result.actualMbps != null) {
      recomputeCounters(state);
      upsertResult(result);
      saveResults();
      broadcast('result', { result, state });
      state.retestPassed++;
      const sla = result.actualMbps >= 10 ? 'SLA:PASS' : 'SLA:FAIL';
      const googleTag = result.googleAccessible === true ? 'Google:YES' : result.googleAccessible === false ? 'Google:NO' : 'Google:?';
      broadcast('log', { msg: `  ✓ #${testNum} PASS: ${result.actualMbps} Mbps | ${result.type} | ${sla} | ${googleTag}` });
      logLine(`  PASS | ${result.actualMbps} Mbps | ${result.type} | ${result.moniker} | ${result.city}, ${result.country} | ${sla} | ${googleTag}`);
    } else {
      const errMsg = error?.message || result?.error || 'Unknown';
      const failResult = result || buildFailResult(node, null, state, errMsg, error?.diag || {});
      recomputeCounters(state);
      upsertResult(failResult, _sanitizeSnippet(_rrSnippet));
      saveResults();
      broadcast('result', { result: failResult, state });
      state.retestFailed++;
      broadcast('log', { msg: `  ✗ #${testNum} FAIL: ${errMsg.slice(0, 80)}` });
      logLine(`  FAIL | ${errMsg.slice(0, 120)}`);
      if (failResult.diag?.v2rayAttempts) {
        for (const a of failResult.diag.v2rayAttempts) {
          logLine(`    attempt: ${a.label} -> ${a.result} ${(a.error || '').slice(0, 80)}`);
        }
      }
    }

    try { await uninstallWgTunnel(); } catch { }
    emergencyCleanupSync();
    if (NODE_DELAY > 0) await sleep(NODE_DELAY);
  }

  emergencyCleanupSync();
  await _finalizeOnchainReporter();
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  state.retestMode = false;
  recomputeCounters(state);
  broadcast('state', { state });

  const summary = `✅ Retest complete. ${state.retestPassed} now working, ${state.retestFailed} still failing out of ${toTest.length} retested.`;
  broadcast('log', { msg: summary });
  logLine(`\n${'='.repeat(80)}`);
  logLine(summary);
  logLine(`Grand total: ${state.testedNodes} passed, ${state.failedNodes} failed out of ${state.testedNodes + state.failedNodes}`);
  logLine(`Success rate: ${((state.testedNodes / (state.testedNodes + state.failedNodes)) * 100).toFixed(1)}%`);
  logLine(`Completed: ${state.completedAt}`);
}

// ─── Plan Subscription Test ─────────────────────────────────────────────────
export async function runPlanTest(planId, state, broadcast) {
  resetPipelineStop();
  refreshAuditSettings();
  // Route isolation — see runSubPlanTest comment.
  state.testRun = false;
  state.runMode = 'subscription';
  state.runPlanId = String(planId);
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.totalNodes = 0;
  state.testedNodes = 0;
  state.failedNodes = 0;
  state.retryCount = 0;
  recomputeCounters(state);
  clearPoisonedSessions();
  clearPaidNodes();
  broadcast('state', { state });

  broadcast('log', { msg: `📋 Plan ${planId} — subscribing and testing connectivity...` });

  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
  state.spentUdvpn = 0;
  broadcast('state', { state });

  const v2rayAvailable = await checkV2Ray();

  // 1. Check existing subscription before paying
  const fee = { amount: [{ denom: DENOM, amount: '200000' }], gas: '800000' };
  let subscriptionId = null;

  const { hasActiveSubscription } = await import('../core/chain.js');
  const existingSub = await hasActiveSubscription(account.address, planId);
  if (existingSub.has) {
    subscriptionId = existingSub.subscriptionId;
    broadcast('log', { msg: `  ♻ Already subscribed — subscription ${subscriptionId} (FREE)` });
  } else {
    broadcast('log', { msg: `  Subscribing to plan ${planId}...` });
    const subMsg = {
      typeUrl: V3_SUB_TYPE,
      value: { from: account.address, id: BigInt(planId), denom: 'udvpn', renewalPricePolicy: 0 },
    };
  try {
    const subResult = await signAndBroadcastRetry(client, account.address, [subMsg], fee, broadcast);
    if (subResult.code !== 0) {
      throw new Error(`Subscribe tx failed code=${subResult.code}: ${subResult.rawLog}`);
    }
    state.spentUdvpn += 200000;
    for (const event of (subResult.events || [])) {
      if (/subscription/i.test(event.type)) {
        for (const attr of event.attributes) {
          const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
          const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
          if (k === 'subscription_id' || k === 'id') {
            const parsed = v.replace(/"/g, '');
            if (parsed && parseInt(parsed) > 0) subscriptionId = parsed;
          }
        }
      }
    }
    broadcast('log', { msg: `  ✓ Subscribed — subscription_id=${subscriptionId} tx=${subResult.transactionHash}` });
  } catch (err) {
    broadcast('log', { msg: `  ✗ Subscribe failed: ${_sanitizeSnippet(err.message)}` });
    state.status = 'error';
    state.errorMessage = `Plan subscribe failed: ${_sanitizeSnippet(err.message)}`;
    broadcast('state', { state });
    return;
  }
  } // close else block for hasActiveSubscription

  if (!subscriptionId) {
    state.status = 'error';
    state.errorMessage = 'No subscription_id in tx events';
    broadcast('state', { state });
    return;
  }

  // 2. Fetch plan nodes (RPC-only per global rule; withFreshRpc rotates on failure)
  broadcast('log', { msg: `  Fetching plan ${planId} nodes via RPC...` });
  let planNodes = [];
  let allPlanNodes = [];
  try {
    allPlanNodes = await withFreshRpc(
      (rpc) => rpcFetchAllNodesForPlanPaginated(rpc, planId, broadcast),
      `rpcFetchAllNodesForPlan(${planId})`,
    );
    broadcast('log', { msg: `  Fetched ${allPlanNodes.length} plan nodes via RPC (paginated)` });
  } catch (err) {
    state.status = 'error';
    state.errorMessage = `RPC plan-nodes fetch failed: ${err.message}`;
    broadcast('state', { state });
    return;
  }
  if (!allPlanNodes || allPlanNodes.length === 0) {
    state.status = 'done';
    state.errorMessage = `Plan ${planId} returned 0 nodes from RPC`;
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }
  let _droppedNoRemote = 0;
  planNodes = allPlanNodes
    .map(n => {
      const rawAddr = (n.remote_addrs || [])[0] || '';
      if (!rawAddr || typeof rawAddr !== 'string') { _droppedNoRemote++; return null; }
      const remoteUrl = rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`;
      if (remoteUrl === 'https://' || remoteUrl === 'http://') { _droppedNoRemote++; return null; }
      return {
        address: n.address,
        remoteUrl,
        gigabyte_prices: n.gigabyte_prices || [],
        planIds: [planId],
      };
    })
    .filter(Boolean);
  if (_droppedNoRemote) {
    broadcast('log', { msg: `  Dropped ${_droppedNoRemote} plan node(s) with empty/invalid remote_addrs` });
  }

  broadcast('log', { msg: `  Found ${planNodes.length} nodes in plan ${planId}` });
  if (planNodes.length === 0) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }

  // 3. Scan for online nodes
  broadcast('log', { msg: `  Scanning plan nodes for online status...` });
  const onlineNodes = await scanNodesParallel(planNodes, 20, broadcast, state);
  broadcast('log', { msg: `  ${onlineNodes.length}/${planNodes.length} plan nodes are online` });

  if (onlineNodes.length === 0) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }

  const shuffled = onlineNodes.sort(() => Math.random() - 0.5).slice(0, 5);
  state.totalNodes = shuffled.length;
  broadcast('state', { state });

  broadcast('log', { msg: `📡 Running baseline...` });
  try {
    const bl = await speedtestDirect();
    state.baselineMbps = bl.mbps;
    broadcast('log', { msg: `  Baseline: ${bl.mbps} Mbps` });
  } catch (e) { broadcast('log', { msg: `  Baseline failed: ${_sanitizeSnippet(e.message)}` }); }

  _initOnchainReporter(account, client, state, broadcast);

  let planPassed = 0, planFailed = 0;

  // 4. Test each node via subscription session
  for (let i = 0; i < shuffled.length; i++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); break; }
    const { node, status } = shuffled[i];
    state.currentNode = node.address;
    broadcast('state', { state });
    broadcast('log', { msg: `[${i + 1}/${shuffled.length}] Testing ${node.address.slice(0, 20)}… via plan ${planId}` });

    const _ptLogLines = [];
    const _ptBroadcast = (type, data) => {
      broadcast(type, data);
      if (type === 'log' && data?.msg) {
        _ptLogLines.push(String(data.msg));
        if (_ptLogLines.length > 40) _ptLogLines.shift();
      }
    };

    // Start session via subscription
    let sessionId = null;
    try {
      const sessMsg = {
        typeUrl: V3_SUB_SESSION_TYPE,
        value: { from: account.address, id: BigInt(subscriptionId), nodeAddress: node.address },
      };
      _ptBroadcast('log', { msg: `  Starting session on subscription ${subscriptionId}...` });
      const sessResult = await signAndBroadcastRetry(client, account.address, [sessMsg], fee, _ptBroadcast);
      if (sessResult.code !== 0) {
        throw new Error(`Session tx failed code=${sessResult.code}: ${sessResult.rawLog}`);
      }
      state.spentUdvpn += 200000;

      for (const event of (sessResult.events || [])) {
        if (/session/i.test(event.type)) {
          for (const attr of event.attributes) {
            const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
            const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
            if (k === 'session_id' || k === 'id') {
              const parsed = v.replace(/"/g, '');
              if (parsed && parseInt(parsed) > 0) sessionId = parsed;
            }
          }
        }
      }

      if (!sessionId) throw new Error('No session_id in tx events');
      _ptBroadcast('log', { msg: `  ✓ Session ${sessionId} via subscription — tx=${sessResult.transactionHash}` });
      await waitForSessionActive(node.address, account.address, 20_000);
    } catch (err) {
      _ptBroadcast('log', { msg: `  ✗ Session start failed: ${_sanitizeSnippet(err.message)}` });
      planFailed++;
      const _ptRawSess = _ptLogLines.join('\n');
      const _ptSnippetSess = _ptRawSess.length > 4096 ? _ptRawSess.slice(-4096) : (_ptRawSess || null);
      const errResult = buildFailResult(node, status, state, `plan-session: ${_sanitizeSnippet(err.message)}`, { planId, subscriptionId });
      errResult.inPlan = true;
      errResult.planIds = [planId];
      upsertResult(errResult, _sanitizeSnippet(_ptSnippetSess));
      saveResults();
      broadcast('result', { result: errResult, state });
      continue;
    }

    // Test with retry
    const { result, retried, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
        BigInt(sessionId), _ptBroadcast, state
      ),
      _ptBroadcast, state, node.address,
    );
    const _ptRaw = _ptLogLines.join('\n');
    const _ptSnippet = _ptRaw.length > 4096 ? _ptRaw.slice(-4096) : (_ptRaw || null);

    if (result) {
      state.testedNodes++;
      result.inPlan = true;
      result.planIds = [planId];
      result.diag = result.diag || {};
      result.diag.planId = planId;
      result.diag.subscriptionId = subscriptionId;
      result.diag.viaSubscription = true;
      if (result.slaApplicable && result.pass15mbps) state.passed15++;
      if (result.pass10mbps) state.passed10++;
      if (result.passBaseline) state.passedBaseline++;
      upsertResult(result);
      saveResults();
      broadcast('result', { result, state });
      if (result.actualMbps != null) {
        planPassed++;
        broadcast('log', { msg: `  ✓ Plan node OK: ${result.actualMbps} Mbps` });
      } else {
        planFailed++;
        broadcast('log', { msg: `  ✗ Plan node failed` });
      }
    } else if (isStopSignal(state, error)) {
      broadcast('log', { msg: `⏸ Plan test interrupted — remaining nodes untouched` });
      break;
    } else {
      state.failedNodes++;
      planFailed++;
      const errMsg = error?.message || 'Unknown error';
      const failResult = buildFailResult(node, status, state, `plan-test: ${errMsg}`, error?.diag || {});
      failResult.inPlan = true;
      failResult.planIds = [planId];
      upsertResult(failResult, _sanitizeSnippet(_ptSnippet));
      saveResults();
      broadcast('result', { result: failResult, state });
      broadcast('log', { msg: `  ✗ Test error: ${errMsg}` });
    }

    try { await uninstallWgTunnel(); } catch { }
    emergencyCleanupSync();
    if (NODE_DELAY > 0) await sleep(NODE_DELAY);
  }

  emergencyCleanupSync();
  await _finalizeOnchainReporter();
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  broadcast('state', { state });
  broadcast('log', { msg: `✅ Plan ${planId} test complete. ${planPassed} passed, ${planFailed} failed out of ${shuffled.length} tested.` });
}

// ─── Sub. Plan Test (fee-granted, mirrors Android/iOS consumer flow) ────────
/**
 * Test every active node in a plan the wallet is already subscribed to.
 * Every session TX is fee-granted by the plan owner — the wallet pays ZERO gas.
 *
 * Flow:
 *   1. Verify the wallet is subscribed to this plan (uses the provided subscriptionId)
 *   2. Verify the plan owner has an active fee grant for this wallet
 *   3. Fetch all active nodes in the plan
 *   4. For each node: start a session via subscription, fee-granted by plan owner
 *   5. Run the standard testNode speed/reachability flow
 *
 * This mirrors how Android/iOS consumer apps ship — the end user never holds
 * P2P, the plan operator covers all on-chain fees via a pre-granted feegrant.
 */
export async function runSubPlanTest(planId, subscriptionId, granterAddr, state, broadcast, opts = {}) {
  resetPipelineStop();
  // Route isolation — a sub-plan run is NEVER a test-run, regardless of what
  // a previous run left behind on `state`. Without this, a stale state.testRun
  // from a prior TEST_RUN sweep would short-circuit testNode() into TEST_RUN_SKIP
  // rows and the entire plan would return spoofed data. Pin runMode here too so
  // SSE consumers (admin / live) classify in-flight events correctly.
  state.testRun = false;
  state.runMode = 'subscription';
  state.runPlanId = String(planId);
  state.runSubscriptionId = String(subscriptionId);
  state.runGranter = String(granterAddr);
  const resume = !!opts.resume;
  state.status = 'running';
  // Preserve original startedAt across Stop/Resume so dashboard ETA / elapsed
  // mirror the original run. Only stamp fresh on a brand-new run.
  if (!resume || !state.startedAt) state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  if (!resume) {
    state.totalNodes = 0;
    state.testedNodes = 0;
    state.failedNodes = 0;
  }
  state.retryCount = 0;
  recomputeCounters(state);
  clearPoisonedSessions();
  clearPaidNodes();
  broadcast('state', { state });

  if (!granterAddr || typeof granterAddr !== 'string') {
    throw new Error('runSubPlanTest: granterAddr is required (got null/undefined)');
  }
  broadcast('log', { msg: `📋 Sub. Plan ${planId} — sub ${subscriptionId} — granter ${granterAddr.slice(0, 16)}…` });

  const { wallet, account, privkey } = await cachedWalletSetup(MNEMONIC);
  state.walletAddress = account.address;
  const client = await createFreshClient(wallet, broadcast);

  const balRes = await client.getBalance(account.address, DENOM);
  state.balanceUdvpn = parseInt(balRes?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
  state.spentUdvpn = 0;
  broadcast('state', { state });

  // Pre-broadcast fee grant verification — abort with structured error if missing/expired.
  // A revoked fee grant means EVERY session TX will fail; fail fast before spending any chain time.
  // Special case: when the operator IS the plan owner, no feegrant is required —
  // they pay their own gas natively.
  const { queryFeeGrant, queryFeeGrantRpcFirst, withFreshRpc: _withFreshRpc, broadcastWithFeeGrant, hasActiveSubscription, ensureLcd: _ensureLcd } = await import('../core/chain.js');
  const lcd = await _ensureLcd();
  const _selfGranter = granterAddr === account.address;
  if (_selfGranter) {
    broadcast('log', { msg: `  Mode: self-granter (wallet IS the plan owner — pays its own gas, no feegrant)` });
    broadcast('log', { msg: `  ✓ Self-granter path — no fee-grant verification needed` });
  } else {
    broadcast('log', { msg: `  Mode: fee-granted (wallet pays zero gas; plan owner pays all TXs)` });
    try {
      const allowance = await _withFreshRpc(
        (client) => queryFeeGrantRpcFirst(client, lcd, granterAddr, account.address),
        'feeGrantStartCheck',
      );
      if (!allowance) {
        const abortErr = {
          code: 'FEE_GRANT_MISSING_AT_START',
          granter: granterAddr,
          grantee: account.address,
          allowanceType: null,
          spendLimit: null,
          message: `Plan owner ${granterAddr.slice(0, 16)}… has no active fee grant for this wallet`,
        };
        state.status = 'error';
        state.errorMessage = abortErr.message;
        state.errorCode = abortErr.code;
        broadcast('state', { state });
        broadcast('log', { msg: `  ✗ FEE_GRANT_MISSING_AT_START — cannot continue (plan owner must grant first)` });
        return;
      }
      // Surface allowance details in log for operator debugging
      const allowanceType = allowance['@type'] || allowance.type_url || null;
      const spendLimit = allowance.spend_limit || allowance.allowance?.spend_limit || null;
      broadcast('log', { msg: `  ✓ Fee grant verified — type=${allowanceType || 'unknown'} limit=${JSON.stringify(spendLimit) || 'none'}` });
    } catch (err) {
      // If the query itself throws (network error), abort rather than silently proceeding —
      // we cannot know whether the grant exists, and every session TX would fail.
      const abortErr = {
        code: 'FEE_GRANT_MISSING_AT_START',
        granter: granterAddr,
        grantee: account.address,
        allowanceType: null,
        spendLimit: null,
        message: `Fee grant check threw: ${_sanitizeSnippet(err.message)}`,
      };
      state.status = 'error';
      state.errorMessage = abortErr.message;
      state.errorCode = abortErr.code;
      broadcast('state', { state });
      broadcast('log', { msg: `  ✗ FEE_GRANT_MISSING_AT_START — check threw error, aborting: ${_sanitizeSnippet(err.message)}` });
      return;
    }
  }

  // Verify subscription still active
  const subCheck = await hasActiveSubscription(account.address, planId);
  if (!subCheck.has) {
    state.status = 'error';
    state.errorMessage = `Wallet is no longer subscribed to plan ${planId}`;
    broadcast('state', { state });
    return;
  }
  // Allow subscriptionId from caller; fall back to whatever the chain reports.
  subscriptionId = subscriptionId || subCheck.subscriptionId;

  const v2rayAvailable = await checkV2Ray();

  // Fetch plan nodes (RPC-only per global rule; withFreshRpc rotates on failure)
  broadcast('log', { msg: `  Fetching plan ${planId} nodes via RPC...` });
  let planNodes = [];
  let allPlanNodes = [];
  try {
    allPlanNodes = await withFreshRpc(
      (rpc) => rpcFetchAllNodesForPlanPaginated(rpc, planId, broadcast),
      `rpcFetchAllNodesForPlan(${planId})`,
    );
    broadcast('log', { msg: `  Fetched ${allPlanNodes.length} plan nodes via RPC (paginated)` });
  } catch (err) {
    state.status = 'error';
    state.errorMessage = `RPC plan-nodes fetch failed: ${err.message}`;
    broadcast('state', { state });
    return;
  }
  if (!allPlanNodes || allPlanNodes.length === 0) {
    state.status = 'done';
    state.errorMessage = `Plan ${planId} returned 0 nodes from RPC`;
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }
  let _droppedNoRemote = 0;
  planNodes = allPlanNodes
    .map(n => {
      const rawAddr = (n.remote_addrs || [])[0] || '';
      if (!rawAddr || typeof rawAddr !== 'string') { _droppedNoRemote++; return null; }
      const remoteUrl = rawAddr.startsWith('http') ? rawAddr : `https://${rawAddr}`;
      if (remoteUrl === 'https://' || remoteUrl === 'http://') { _droppedNoRemote++; return null; }
      return {
        address: n.address,
        remoteUrl,
        gigabyte_prices: n.gigabyte_prices || [],
        planIds: [planId],
      };
    })
    .filter(Boolean);
  if (_droppedNoRemote) {
    broadcast('log', { msg: `  Dropped ${_droppedNoRemote} plan node(s) with empty/invalid remote_addrs` });
  }

  broadcast('log', { msg: `  Found ${planNodes.length} nodes in plan ${planId}` });
  if (planNodes.length === 0) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }

  broadcast('log', { msg: `  Scanning plan nodes for online status...` });
  const onlineNodesRaw = await scanNodesParallel(planNodes, 20, broadcast, state);
  broadcast('log', { msg: `  ${onlineNodesRaw.length}/${planNodes.length} plan nodes are online` });

  // Resume mode: filter already-tested addresses so the in-flight node (if any)
  // is first in line and previously-completed nodes are not re-paid for.
  let onlineNodes = onlineNodesRaw;
  let _alreadyTested = 0;
  if (resume) {
    const testedAddrs = new Set(results.map(r => r.address));
    const filtered = onlineNodesRaw.filter(({ node }) => !testedAddrs.has(node.address));
    _alreadyTested = onlineNodesRaw.length - filtered.length;
    // Hoist the in-flight (interrupted) node to position 0. Without this,
    // scanNodesParallel returns nodes in race-completion order so the
    // interrupted node lands wherever its probe happened to finish.
    const headAddr = state.resumeHeadAddr;
    if (headAddr) {
      const hi = filtered.findIndex(({ node }) => node.address === headAddr);
      if (hi > 0) {
        const [head] = filtered.splice(hi, 1);
        filtered.unshift(head);
        broadcast('log', { msg: `  Resume: starting with interrupted node ${headAddr.slice(0, 20)}…` });
      } else if (hi === 0) {
        broadcast('log', { msg: `  Resume: starting with interrupted node ${headAddr.slice(0, 20)}…` });
      }
    }
    onlineNodes = filtered;
    broadcast('log', { msg: `  Resume: skipping ${_alreadyTested} already-tested, ${onlineNodes.length} remaining.` });
  }

  if (onlineNodes.length === 0) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    broadcast('state', { state });
    return;
  }

  state.totalNodes = (resume ? results.length : 0) + onlineNodes.length;
  broadcast('state', { state });

  broadcast('log', { msg: `📡 Running baseline...` });
  try {
    const bl = await speedtestDirect();
    state.baselineMbps = bl.mbps;
    broadcast('log', { msg: `  Baseline: ${bl.mbps} Mbps` });
  } catch (e) { broadcast('log', { msg: `  Baseline failed: ${_sanitizeSnippet(e.message)}` }); }

  _initOnchainReporter(account, client, state, broadcast);

  let subPassed = 0, subFailed = 0;

  for (let i = 0; i < onlineNodes.length; i++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); break; }
    const { node, status } = onlineNodes[i];
    state.currentNode = node.address;
    state.resumeHeadAddr = node.address;
    broadcast('state', { state });
    broadcast('log', { msg: `[${i + 1}/${onlineNodes.length}] Testing ${node.address.slice(0, 20)}… via Sub. Plan ${planId}` });

    const _spLogLines = [];
    const _spBroadcast = (type, data) => {
      broadcast(type, data);
      if (type === 'log' && data?.msg) {
        _spLogLines.push(String(data.msg));
        if (_spLogLines.length > 40) _spLogLines.shift();
      }
    };

    let sessionId = null;
    try {
      const sessMsg = {
        typeUrl: V3_SUB_SESSION_TYPE,
        value: { from: account.address, id: BigInt(subscriptionId), nodeAddress: node.address },
      };
      let sessResult;
      if (_selfGranter) {
        _spBroadcast('log', { msg: `  Starting session (self-paid gas)` });
        const _spFee = { amount: [{ denom: DENOM, amount: '200000' }], gas: '800000' };
        sessResult = await signAndBroadcastRetry(client, account.address, [sessMsg], _spFee, _spBroadcast);
        if (sessResult.code !== 0) {
          throw new Error(`Session tx failed code=${sessResult.code}: ${sessResult.rawLog}`);
        }
        state.spentUdvpn += 200000;
      } else {
        _spBroadcast('log', { msg: `  Starting session (fee-granted by ${granterAddr.slice(0, 12)}…)` });
        sessResult = await broadcastWithFeeGrant(client, account.address, [sessMsg], granterAddr);
        if (sessResult.code !== 0) {
          throw new Error(`Session tx failed code=${sessResult.code}: ${sessResult.rawLog}`);
        }
        // Wallet pays zero — do NOT increment spentUdvpn on fee-granted TX
      }

      for (const event of (sessResult.events || [])) {
        if (/session/i.test(event.type)) {
          for (const attr of event.attributes) {
            const k = typeof attr.key === 'string' ? attr.key : Buffer.from(attr.key, 'base64').toString('utf8');
            const v = typeof attr.value === 'string' ? attr.value : Buffer.from(attr.value, 'base64').toString('utf8');
            if (k === 'session_id' || k === 'id') {
              const parsed = v.replace(/"/g, '');
              if (parsed && parseInt(parsed) > 0) sessionId = parsed;
            }
          }
        }
      }
      if (!sessionId) throw new Error('No session_id in tx events');
      const _payTag = _selfGranter ? 'self-paid' : 'fee-granted';
      _spBroadcast('log', { msg: `  ✓ Session ${sessionId} (${_payTag}) — tx=${sessResult.transactionHash}` });
      await waitForSessionActive(node.address, account.address, 20_000);
    } catch (err) {
      const _failTag = _selfGranter ? 'Self-paid' : 'Fee-granted';
      _spBroadcast('log', { msg: `  ✗ ${_failTag} session start failed: ${_sanitizeSnippet(err.message)}` });
      subFailed++;
      const _spRawSess = _spLogLines.join('\n');
      const _spSnippetSess = _spRawSess.length > 4096 ? _spRawSess.slice(-4096) : (_spRawSess || null);
      const errResult = buildFailResult(node, status, state, `sub-plan-session: ${_sanitizeSnippet(err.message)}`, { planId, subscriptionId, granter: granterAddr });
      errResult.inPlan = true;
      errResult.planIds = [planId];
      errResult.diag = errResult.diag || {};
      errResult.diag.viaSubscription = true;
      errResult.diag.feeGranted = !_selfGranter;
      errResult.diag.selfGranter = _selfGranter;
      errResult.diag.granter = granterAddr;
      upsertResult(errResult, _sanitizeSnippet(_spSnippetSess));
      state.resumeHeadAddr = null;
      saveResults();
      broadcast('result', { result: errResult, state });
      continue;
    }

    const { result, retried, error } = await testWithRetry(
      () => testNode(client, account, privkey, node,
        { testMb: TEST_MB, gigabytes: GIGS, denom: DENOM, v2rayAvailable, baselineMbps: state.baselineMbps, nodeStatus: status },
        BigInt(sessionId), _spBroadcast, state
      ),
      _spBroadcast, state, node.address,
    );
    const _spRaw = _spLogLines.join('\n');
    const _spSnippet = _spRaw.length > 4096 ? _spRaw.slice(-4096) : (_spRaw || null);

    if (result) {
      state.testedNodes++;
      result.inPlan = true;
      result.planIds = [planId];
      result.diag = result.diag || {};
      result.diag.planId = planId;
      result.diag.subscriptionId = subscriptionId;
      result.diag.viaSubscription = true;
      result.diag.feeGranted = !_selfGranter;
      result.diag.selfGranter = _selfGranter;
      result.diag.granter = granterAddr;
      if (result.slaApplicable && result.pass15mbps) state.passed15++;
      if (result.pass10mbps) state.passed10++;
      if (result.passBaseline) state.passedBaseline++;
      upsertResult(result);
      state.resumeHeadAddr = null;
      saveResults();
      broadcast('result', { result, state });
      if (result.actualMbps != null) {
        subPassed++;
        broadcast('log', { msg: `  ✓ Sub. Plan node OK: ${result.actualMbps} Mbps` });
      } else {
        subFailed++;
        broadcast('log', { msg: `  ✗ Sub. Plan node failed` });
      }
    } else if (isStopSignal(state, error)) {
      broadcast('log', { msg: `⏸ Sub. Plan test interrupted — remaining nodes untouched` });
      break;
    } else {
      state.failedNodes++;
      subFailed++;
      const errMsg = error?.message || 'Unknown error';
      const failResult = buildFailResult(node, status, state, `sub-plan-test: ${errMsg}`, error?.diag || {});
      failResult.inPlan = true;
      failResult.planIds = [planId];
      failResult.diag = failResult.diag || {};
      failResult.diag.viaSubscription = true;
      failResult.diag.feeGranted = !_selfGranter;
      failResult.diag.selfGranter = _selfGranter;
      failResult.diag.granter = granterAddr;
      upsertResult(failResult, _sanitizeSnippet(_spSnippet));
      state.resumeHeadAddr = null;
      saveResults();
      broadcast('result', { result: failResult, state });
      broadcast('log', { msg: `  ✗ Test error: ${errMsg}` });
    }

    try { await uninstallWgTunnel(); } catch { }
    emergencyCleanupSync();
    if (NODE_DELAY > 0) await sleep(NODE_DELAY);
  }

  emergencyCleanupSync();
  await _finalizeOnchainReporter();
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  broadcast('state', { state });
  broadcast('log', { msg: `✅ Sub. Plan ${planId} test complete. ${subPassed} passed, ${subFailed} failed out of ${onlineNodes.length} tested.` });
  if (_selfGranter) {
    const _spentP2P = (state.spentUdvpn / 1_000_000).toFixed(6);
    broadcast('log', { msg: `  Wallet paid: ${_spentP2P} P2P (self-granter — wallet IS the plan owner)` });
  } else {
    broadcast('log', { msg: `  Wallet paid: 0 P2P (all gas covered by granter ${granterAddr.slice(0, 16)}…)` });
  }
}
