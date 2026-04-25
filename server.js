/**
 * Sentinel dVPN Network Audit — Server
 * Thin Express server: API routes, SSE, imports from modular architecture.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { adminOnly, attachAdminFlag, safeEq, setAdminSessionValidator } from './core/auth.js';
import { rateLimit, sseLimit } from './core/rate-limit.js';

import { MNEMONIC, DENOM, GAS_PRICE, PORT, LCD_ENDPOINTS, PROJECT_ROOT, DNS_PRESETS, ACTIVE_DNS, setActiveDns } from './core/constants.js';
import { cachedWalletSetup, createFreshClient } from './core/wallet.js';
import { ensureLcd, getActiveLcd, cleanupRpc, getAllNodes } from './core/chain.js';
import { nodeStatusV3 } from './protocol/v3protocol.js';
import { createState, runAudit, runRetestSkips, runPlanTest, runSubPlanTest, getResults, saveResults, setActiveRunDir, setActiveDbRunId } from './audit/pipeline.js';
import {
  insertRun, updateRunOnFinish,
  insertResult, insertErrorLog,
  searchNodes, getNodeDetail, getNodeErrors, getCountryList,
  getActiveRun, getLastCompletedRun, getBandwidthHistory,
  searchErrors, getNetworkStats,
  listBatches, getBatchResults, getActiveBatch, getLastBatch,
  insertBatch, updateBatchOnFinish, insertBatchResult,
  getDb,
} from './core/db.js';
import * as continuous from './audit/continuous.js';
import { getInstalledVersions, verifyAllSdks, verifySdk } from './core/sdk-verify.js';
// Platform-aware WireGuard import — Windows has full implementation, others get stubs
let emergencyCleanupSync, watchdogCheck, WG_AVAILABLE, IS_ADMIN;
if (process.platform === 'win32') {
  ({ emergencyCleanupSync, watchdogCheck, WG_AVAILABLE, IS_ADMIN } = await import('./platforms/windows/wireguard.js'));
} else {
  emergencyCleanupSync = () => {};
  watchdogCheck = () => {};
  WG_AVAILABLE = false;
  IS_ADMIN = process.getuid?.() === 0 || false;
}
import { loadTransportCache, getCacheStats } from './core/transport-cache.js';

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + (process.env.PATH || '');

// ─── Env sanity check ───────────────────────────────────────────────────────
const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// M-05: use ephemeral per-process secret when ADMIN_TOKEN is absent; forbids
// forged signed cookies even in single-user/dev mode.
import crypto from 'node:crypto';
const COOKIE_SECRET = ADMIN_TOKEN || crypto.randomBytes(32).toString('hex');

// ─── Admin session store (H-02) ─────────────────────────────────────────────
// Map<sessionId, expiryMs>. Session ID is stored in the signed cookie instead
// of the raw ADMIN_TOKEN so cookie theft cannot recover the backend token.
// In-memory only: admin logouts drop entries; process restart invalidates all sessions.
const ADMIN_SESSIONS = new Map();
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createAdminSession() {
  const id = crypto.randomBytes(32).toString('hex');
  ADMIN_SESSIONS.set(id, Date.now() + ADMIN_SESSION_TTL_MS);
  return id;
}

export function isValidAdminSession(id) {
  if (!id || typeof id !== 'string') return false;
  const exp = ADMIN_SESSIONS.get(id);
  if (!exp) return false;
  if (exp < Date.now()) { ADMIN_SESSIONS.delete(id); return false; }
  return true;
}

export function revokeAdminSession(id) {
  if (id) ADMIN_SESSIONS.delete(id);
}

// Periodic cleanup of expired sessions — 1-hour interval
setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of ADMIN_SESSIONS) {
    if (exp < now) ADMIN_SESSIONS.delete(id);
  }
}, 60 * 60 * 1000).unref();

// Inject the validator into the auth middleware. Must run before any admin request.
setAdminSessionValidator(isValidAdminSession);

if (PUBLIC_MODE && !ADMIN_TOKEN) {
  console.error('');
  console.error('ERROR: PUBLIC_MODE=true requires ADMIN_TOKEN to be set.');
  console.error('  Without ADMIN_TOKEN, the admin surface has no protection.');
  console.error('  Generate one:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('  Then add ADMIN_TOKEN=<value> to your .env file.');
  console.error('');
  process.exit(1);
}

if (!MNEMONIC || !MNEMONIC.trim()) {
  console.warn('');
  console.warn('⚠  MNEMONIC is not set.');
  console.warn('   The server will start, but any test that signs a TX will fail.');
  console.warn('   Fix: copy .env.example to .env and set MNEMONIC to a 12-word Cosmos phrase.');
  console.warn('');
}

// ─── WireGuard Safety: cleanup on ANY exit ──────────────────────────────────
emergencyCleanupSync();

function onProcessExit() { cleanupRpc(); emergencyCleanupSync(); }
process.on('exit', onProcessExit);

// Graceful shutdown: stop the continuous loop before exit so it can't keep
// writing `runs` rows after the HTTP listener closes. Best-effort only; the
// hard exit fires after 2s regardless so Ctrl-C is still snappy.
function gracefulShutdown(signal, exitCode) {
  console.log(`[server] ${signal} received — stopping continuous loop`);
  try { continuous.stop(); } catch {}
  onProcessExit();
  setTimeout(() => process.exit(exitCode), 2_000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT', 130));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 143));
process.on('uncaughtException', (err) => {
  const msg = err?.stack || err?.message || String(err);
  console.error(`[uncaughtException] ${msg}`);
  emergencyCleanupSync();
});
process.on('unhandledRejection', (reason) => {
  console.error(`[unhandledRejection] ${String(reason)}`);
  emergencyCleanupSync();
});

// Watchdog: every 5s, check if a tunnel has been up too long
setInterval(() => {
  if (watchdogCheck()) {
    broadcast('log', { msg: '⚠ WATCHDOG: Force-killed stale WireGuard tunnel' });
  }
}, 5_000);

// ─── SSE ────────────────────────────────────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const LOG_BUFFER_MAX = 100;
const logBuffer = [];

// ─── State Snapshot (persists volatile fields across restarts) ───────────────
const STATE_SNAPSHOT_FILE = path.join(__dirname, 'results', '.state-snapshot.json');
let _lastSnapshotTs = 0;

function saveStateSnapshot() {
  // Throttle: save at most every 5 seconds to avoid disk thrashing
  const now = Date.now();
  if (now - _lastSnapshotTs < 5_000) return;
  _lastSnapshotTs = now;
  try {
    _wfs(STATE_SNAPSHOT_FILE, JSON.stringify({
      baselineHistory: state.baselineHistory,
      nodeSpeedHistory: state.nodeSpeedHistory,
      spentUdvpn: state.spentUdvpn,
      balanceUdvpn: state.balanceUdvpn,
      balance: state.balance,
      estimatedTotalCost: state.estimatedTotalCost,
      startedAt: state.startedAt,
      baselineMbps: state.baselineMbps,
      totalNodes: state.totalNodes,
      status: state.status,
    }), 'utf8');
  } catch { }
}

function broadcast(type, data = {}) {
  if (type === 'log' && data.msg) {
    logBuffer.push(data.msg);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  }
  if (type === 'state' || type === 'result') saveStateSnapshot();
  // NOTE: spread `data` FIRST so a payload field named `type` (e.g. the node's
  // service-type like 'wireguard') cannot clobber the SSE event type. The
  // event type is the dispatch key — clients switch on d.type — so it must win.
  emitter.emit('update', { ...data, type });
}

// ─── Continuous Loop SSE forwarding ─────────────────────────────────────────
// Forward loop and batch events from the continuous runner into the broadcast bus.
{
  const LOOP_EVENTS = [
    'loop:started', 'loop:stopping', 'loop:stopped', 'loop:error',
    'iteration:start', 'iteration:end',
  ];
  for (const evt of LOOP_EVENTS) {
    continuous.on(evt, (data) => broadcast(evt, data || {}));
  }

  const BATCH_EVENTS = ['batch:start', 'batch:node:result', 'batch:end', 'batch:gap'];
  for (const evt of BATCH_EVENTS) {
    continuous.on(evt, (data) => broadcast(evt, data || {}));
  }
}

// ─── State ──────────────────────────────────────────────────────────────────
const state = createState();
state.broadcastLive = false;

// Persist SDK choice to disk so it survives restarts
const SDK_PREF_FILE = path.join(__dirname, 'results', '.sdk-preference');
try { state.activeSDK = _rfs(SDK_PREF_FILE, 'utf8').trim() || 'js'; } catch { state.activeSDK = 'js'; }

// ─── Restore log buffer from most recent audit log (survives server restart) ─
try {
  const logDir = path.join(__dirname, 'results');
  const logFiles = _rd(logDir).filter(f => /^(audit|retest)-.*\.log$/.test(f)).sort().reverse();
  if (logFiles.length > 0) {
    const lastLog = _rfs(path.join(logDir, logFiles[0]), 'utf8');
    const lines = lastLog.split('\n').filter(l => l.trim());
    const tail = lines.slice(-LOG_BUFFER_MAX);
    logBuffer.push(...tail);
  }
} catch { }

// ─── Test Run Management ─────────────────────────────────────────────────────
import { readFileSync as _rfs, writeFileSync as _wfs, mkdirSync as _mkd, existsSync as _ex, readdirSync as _rd, copyFileSync as _cp } from 'fs';

const RUNS_DIR = path.join(__dirname, 'results', 'runs');
const RUNS_INDEX = path.join(RUNS_DIR, 'index.json');
if (!_ex(RUNS_DIR)) _mkd(RUNS_DIR, { recursive: true });

function loadRunsIndex() {
  if (!_ex(RUNS_INDEX)) return { runs: [], activeRun: null };
  return JSON.parse(_rfs(RUNS_INDEX, 'utf8'));
}

function saveRunsIndex(index) {
  _wfs(RUNS_INDEX, JSON.stringify(index, null, 2), 'utf8');
}

function getNextRunNumber() {
  const index = loadRunsIndex();
  return (index.runs.length > 0 ? Math.max(...index.runs.map(r => r.number)) : 0) + 1;
}

function saveCurrentRun(label) {
  const results = getResults();
  if (results.length === 0) return null;
  const num = getNextRunNumber();
  const runDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  _mkd(runDir, { recursive: true });

  // Save results
  _wfs(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');

  // Save summary
  const passed = results.filter(r => r.actualMbps != null);
  const failed = results.filter(r => r.actualMbps == null);
  const pass10 = passed.filter(r => r.actualMbps >= 10);
  const summary = [
    `Test #${num} — ${label || 'Full Audit'}`,
    `Date: ${new Date().toISOString()}`,
    `${'='.repeat(60)}`,
    `Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`,
    `Success Rate: ${(passed.length / results.length * 100).toFixed(1)}%`,
    `Pass 10 Mbps SLA: ${pass10.length} (${(pass10.length / passed.length * 100).toFixed(1)}%)`,
    ``,
    `── Passed Nodes (${passed.length}) ──`,
    ...passed.map(r => `  ${r.address.slice(0, 25)}... | ${r.actualMbps} Mbps | ${r.type} | ${r.moniker} | ${r.city}, ${r.country} | Google: ${r.googleAccessible === true ? 'YES' : r.googleAccessible === false ? 'NO' : '?'}`),
    ``,
    `── Failed Nodes (${failed.length}) ──`,
    ...failed.map(r => `  ${r.address.slice(0, 25)}... | ${r.type} | ${r.moniker} | ${r.city}, ${r.country} | peers=${r.peers ?? '?'} | ${(r.error || '').slice(0, 80)}`),
  ].join('\n');
  _wfs(path.join(runDir, 'summary.txt'), summary, 'utf8');

  // Copy failures log
  const failLog = path.join(__dirname, 'results', 'failures.jsonl');
  if (_ex(failLog)) _cp(failLog, path.join(runDir, 'failures.jsonl'));

  // Update index
  const index = loadRunsIndex();
  index.runs.push({
    number: num,
    label: label || 'Full Audit',
    date: new Date().toISOString(),
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    pass10: pass10.length,
    sdk: state.activeSDK,
  });
  index.activeRun = num;
  saveRunsIndex(index);

  // ─── SQLite: mark the run as finished ────────────────────────────────────
  if (state.activeDbRunId) {
    try {
      updateRunOnFinish(state.activeDbRunId, {
        finished_at: Date.now(),
        node_count:  results.length,
        pass_count:  passed.length,
      });
    } catch (dbErr) {
      console.error(`[db] updateRunOnFinish failed: ${dbErr.message}`);
    }
  }

  return num;
}

function loadRun(num) {
  const runDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  const resultsPath = path.join(runDir, 'results.json');
  if (!_ex(resultsPath)) return null;
  return JSON.parse(_rfs(resultsPath, 'utf8'));
}

// ─── Rehydrate state from results.json on startup ───────────────────────────
function rehydrateState(results) {
  state.testedNodes = results.filter(r => r.actualMbps != null).length;
  state.failedNodes = results.filter(r => r.actualMbps == null && !r.skipped && r.errorCode !== 'TEST_RUN_SKIP').length;
  state.skippedNodes = results.filter(r => r.skipped || r.errorCode === 'TEST_RUN_SKIP').length;
  // Do NOT set totalNodes here — it must come from snapshot (last known chain total).
  // results.length = how many we tested, NOT how many exist on chain.
  state.passed10 = results.filter(r => r.actualMbps != null && r.actualMbps >= 10).length;
  state.passed15 = results.filter(r => r.actualMbps != null && r.actualMbps >= 15).length;
  state.passedBaseline = results.filter(r => {
    const thresh = r.dynamicThreshold != null ? r.dynamicThreshold : (r.baselineAtTest != null ? r.baselineAtTest * 0.5 : null);
    return thresh != null && r.actualMbps >= thresh;
  }).length;
}

{
  const results = getResults();
  if (results.length > 0) {
    rehydrateState(results);
    state.status = 'idle';

    // Restore volatile state (history, balance, baseline) from snapshot
    try {
      const snap = JSON.parse(_rfs(STATE_SNAPSHOT_FILE, 'utf8'));
      if (snap.baselineHistory?.length) state.baselineHistory = snap.baselineHistory;
      if (snap.nodeSpeedHistory?.length) state.nodeSpeedHistory = snap.nodeSpeedHistory;
      // Don't restore spentUdvpn from snapshot — it accumulates across restarts
      // and causes negative balance display. Balance is queried fresh from chain on audit start.
      // Only restore for display purposes, capped to prevent negative.
      if (snap.balanceUdvpn) state.balanceUdvpn = snap.balanceUdvpn;
      if (snap.spentUdvpn) state.spentUdvpn = Math.min(snap.spentUdvpn, state.balanceUdvpn);
      const remaining = Math.max(0, state.balanceUdvpn - state.spentUdvpn);
      state.balance = `${(remaining / 1_000_000).toFixed(4)} P2P`;
      if (snap.estimatedTotalCost) state.estimatedTotalCost = snap.estimatedTotalCost;
      if (snap.startedAt) state.startedAt = snap.startedAt;
      if (snap.baselineMbps) state.baselineMbps = snap.baselineMbps;
      if (snap.totalNodes) state.totalNodes = snap.totalNodes;
      console.log(`State snapshot restored: baseline=${snap.baselineHistory?.length || 0} readings, speeds=${snap.nodeSpeedHistory?.length || 0} nodes, total=${state.totalNodes}`);
    } catch { }

    // Resume the active test — DON'T create a new one on restart
    const index = loadRunsIndex();
    if (index.runs.length === 0) {
      // First ever boot — save as Test #1
      const num = saveCurrentRun('Initial Audit');
      console.log(`Saved existing data as Test #${num}`);
    }
    // Always resume the last active test number
    state.activeRunNumber = index.activeRun || (index.runs.length > 0 ? index.runs[index.runs.length - 1].number : 1);

    console.log(`Resuming Test #${state.activeRunNumber} | ${results.length} results: ${state.testedNodes} passed, ${state.failedNodes} failed | SDK: ${state.activeSDK}`);
  }
}

// ─── Express ────────────────────────────────────────────────────────────────
const app = express();
// Trust exactly one proxy hop so that req.ip is populated from X-Forwarded-For
// only when a real reverse proxy (nginx, Caddy, etc.) sits in front.
// Without this, req.ip is always the direct socket address — which is what
// clientIp() in core/rate-limit.js now uses exclusively (F-02).
app.set('trust proxy', 1);
app.use(express.json());
// cookie-parser with HMAC signing so admin_token cookie cannot be forged
app.use(cookieParser(COOKIE_SECRET));
// Serve static assets (logo, fonts etc.) but do NOT auto-serve index files.
// Routes below explicitly control which HTML file each path gets.
app.use(express.static(__dirname, { index: false }));

// ─── Security headers (all responses) ───────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // M-01: clickjacking defence covers admin routes (public CSP has frame-ancestors).
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ─── CSP helper (public HTML responses only) ─────────────────────────────────
const PUBLIC_CSP = [
  "default-src 'self'",
  // flagcdn.com serves ISO 3166 country flag PNGs. Needed because Windows
  // Chrome/Edge don't render regional-indicator emoji as flag glyphs — they
  // fall back to letter tiles ("US", "DE") which users reported as "distorted".
  "img-src 'self' data: https://flagcdn.com",
  // sentinel.css @imports Noto Sans Mono from jsDelivr (Plan Manager canon).
  // Europa Bold is self-hosted from /fonts/, so no external font-src needed.
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function setPublicCsp(res) {
  res.setHeader('Content-Security-Policy', PUBLIC_CSP);
}

// ─── Rate-limit tiers ────────────────────────────────────────────────────────
// "public-read": 120 req / 60 s for all read-only public API endpoints.
const rlPublicRead = rateLimit({ windowMs: 60_000, max: 120, bucket: 'public-read' });
// "public-sse": max 5 concurrent SSE connections per IP.
const rlPublicSse = sseLimit({ maxPerIp: 5, bucket: 'public-sse' });


// ─── Public routes: no auth, read-only ──────────────────────────────────────

// Root: serve public dashboard when PUBLIC_MODE=true, otherwise admin.html (or redirect to login)
app.get('/', attachAdminFlag, (req, res) => {
  if (PUBLIC_MODE) {
    setPublicCsp(res);
    return res.sendFile(path.join(__dirname, 'public.html'));
  }
  // PUBLIC_MODE=false: no auth check needed for local/single-user setups
  if (!ADMIN_TOKEN || req.admin) {
    return res.sendFile(path.join(__dirname, 'admin.html'));
  }
  res.redirect(ADMIN_PATH + '/login');
});

// Per-node detail page (public, read-only SPA served on any /node/:addr path)
app.get('/node/:addr', attachAdminFlag, (req, res) => {
  setPublicCsp(res);
  res.sendFile(path.join(__dirname, 'node.html'));
});

// Public live-testing view — shareable URL, zero action buttons
app.get('/live', attachAdminFlag, (req, res) => {
  setPublicCsp(res);
  res.sendFile(path.join(__dirname, 'live.html'));
});

// Public about page — static, no action buttons
app.get('/about', attachAdminFlag, (req, res) => {
  setPublicCsp(res);
  res.sendFile(path.join(__dirname, 'about.html'));
});

// ─── Public API: read-only, no wallet or chain writes ────────────────────────
// NOTE: these handlers MUST NOT import from audit/, core/wallet.js, or chain write paths.
// A grep-based assertion in test/security.test.js enforces this invariant on every build.

/**
 * GET /api/public/nodes
 * Query params: q, country, service, sort, window, limit, offset
 * Returns one row per node with pass_count, pass_rate, pass_bar.
 */
app.get('/api/public/nodes', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const q       = req.query.q       || null;
    const country = req.query.country || null;
    const service = req.query.service || null;
    const sort    = req.query.sort    || 'tested_desc';
    const win     = Math.min(parseInt(req.query.window || '25', 10), 100);
    const limit   = Math.min(parseInt(req.query.limit  || '50',  10), 500);
    const offset  = parseInt(req.query.offset || '0', 10);
    const runId   = req.query.runId ? parseInt(req.query.runId, 10) : null;

    const nodes = searchNodes({ q, country, service, sort, window: win, limit, offset, runId });

    res.json({ total: nodes.length, offset, limit, window: win, results: nodes });
  } catch (err) {
    console.error('[api/public/nodes]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/node/:addr?historyLimit=N
 * Returns { node, history, errors } for a single node.
 */
app.get('/api/public/node/:addr', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const addr   = req.params.addr;
    const hLimit = parseInt(req.query.historyLimit || '100', 10);
    const detail = getNodeDetail(addr, { historyLimit: hLimit });
    if (!detail.node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    res.json(detail);
  } catch (err) {
    console.error('[api/public/node]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/node/:addr/errors?limit=N&stage=X
 * Returns error_log rows for a node, optionally filtered by stage.
 */
app.get('/api/public/node/:addr/errors', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const addr   = req.params.addr;
    const limit  = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
    const stage  = req.query.stage || null;
    const errors = getNodeErrors(addr, { limit, stage });
    res.json({ node_addr: addr, total: errors.length, errors });
  } catch (err) {
    console.error('[api/public/node/errors]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/errors?q=&stage=&limit=&offset=
 * Cross-node error search. Returns recent failures across ALL nodes.
 * q matches node_addr, moniker, or error_message (LIKE, case-insensitive).
 * stage filters error_logs.stage exactly.
 * limit default 100 cap 500; offset default 0. Ordered by captured_at DESC.
 */
app.get('/api/public/errors', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const q      = req.query.q     || null;
    const stage  = req.query.stage || null;
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0,   0);
    const { total, items } = searchErrors({ q, stage, limit, offset });
    res.json({ total, items });
  } catch (err) {
    console.error('[api/public/errors]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/countries
 * Returns distinct countries with node counts.
 */
app.get('/api/public/countries', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const countries = getCountryList();
    res.json({ total: countries.length, countries });
  } catch (err) {
    console.error('[api/public/countries]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/runs/current — current in-progress batch (+ per-node
 * results so far) so /live can hydrate on refresh without waiting for SSE.
 * Returns 404 when nothing is mid-flight.
 */
app.get('/api/public/runs/current', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const data = state.broadcastLive ? getActiveBatch() : getLastBatch();
    if (!data) return res.status(404).json({ error: 'No active run' });
    const { batch, nodes } = data;
    res.json({
      id: batch.id,
      started_at: batch.started_at,
      finished_at: batch.finished_at,
      snapshot_size: batch.snapshot_size,
      passed: batch.passed,
      failed: batch.failed,
      mode: batch.mode,
      nodes,
    });
  } catch (err) {
    console.error('[api/public/runs/current]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/runs/last — most recent completed run, or 404.
 */
app.get('/api/public/runs/last', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    // Prefer the last completed batch (has nodes) so /live can hydrate fully
    // on refresh without waiting for SSE. Fall back to legacy run row only
    // when no batch has ever been recorded.
    const last = getLastBatch();
    if (last) {
      const { batch, nodes } = last;
      return res.json({
        id: batch.id,
        started_at: batch.started_at,
        finished_at: batch.finished_at,
        snapshot_size: batch.snapshot_size,
        passed: batch.passed,
        failed: batch.failed,
        mode: batch.mode,
        nodes,
      });
    }
    const run = getLastCompletedRun();
    if (!run) return res.status(404).json({ error: 'No completed runs' });
    res.json(run);
  } catch (err) {
    console.error('[api/public/runs/last]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/node/:addr/bandwidth?limit=N — bandwidth chart data.
 */
app.get('/api/public/node/:addr/bandwidth', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const addr = req.params.addr;
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const history = getBandwidthHistory(addr, { limit });
    res.json({ node_addr: addr, total: history.length, history });
  } catch (err) {
    console.error('[api/public/node/bandwidth]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/public/runs', attachAdminFlag, rlPublicRead, (req, res) => {
  const index = loadRunsIndex();
  const safe = (index.runs || []).map(r => ({
    number: r.number,
    label: r.label,
    date: r.date,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    pass10: r.pass10,
  }));
  res.json({ runs: safe, total: safe.length });
});

app.get('/api/public/stats', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    // Use DB aggregate instead of iterating the in-memory results array (F-13).
    const { totalNodes, passingPct, medianMbps, lastRunAt } = getNetworkStats();
    res.json({
      totalNodes,
      passingPct,
      medianMbps,
      lastRunAt,
      status: continuous.status().running ? 'running' : 'idle',
    });
  } catch (err) {
    console.error('[api/public/stats]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/batches?limit=N
 * Returns the last N batches (default 50, max 100), newest first.
 * Each batch has: id, started_at, finished_at, snapshot_size, passed, failed, mode.
 */
app.get('/api/public/batches', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 100);
    const batches = listBatches({ limit });
    res.json({ total: batches.length, batches });
  } catch (err) {
    console.error('[api/public/batches]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/batch/:id?limit=N&offset=N
 * Returns the batch header + public-safe node results for one batch.
 * Strips wallet, SDK, OS, diag fields — only:
 *   node_address, type, moniker, country, city, actual_mbps,
 *   peers, max_peers, error, error_code, tested_at
 */
app.get('/api/public/batch/:id', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const batchId = parseInt(req.params.id, 10);
    if (!batchId || batchId < 1) return res.status(400).json({ error: 'Invalid batch id' });
    const limit  = Math.min(parseInt(req.query.limit  || '500', 10) || 500, 1000);
    const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0,   0);
    const { batch, results } = getBatchResults(batchId, { limit, offset });
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const { snapshot_addresses: _addrs, ...batchPublic } = batch;
    res.json({ batch: batchPublic, results, total: results.length });
  } catch (err) {
    console.error('[api/public/batch]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Admin login / logout ─────────────────────────────────────────────────────
app.get(ADMIN_PATH + '/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sentinel Audit — Admin Login</title>
  <link rel="stylesheet" href="/sentinel.css">
  <style>
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .login-card { max-width: 380px; width: 100%; padding: 40px 36px; }
    .login-title { font-family: var(--font-display); font-size: 20px; font-weight: 700; letter-spacing: 2px; margin: 0 0 6px; color: var(--text); }
    .login-sub { font-size: 12px; color: var(--text-dim); margin: 0 0 28px; }
    .login-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); display: block; margin-bottom: 6px; }
    .login-input { width: 100%; margin-bottom: 20px; }
  </style>
</head>
<body class="boot-pending">
  <script>document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'; document.addEventListener('DOMContentLoaded', () => document.body.classList.remove('boot-pending'));</script>
  <div class="card login-card">
    <h1 class="login-title">SENTINEL AUDIT</h1>
    <p class="login-sub">Admin access required</p>
    <form method="POST" action="${ADMIN_PATH}/login">
      <label class="login-label" for="token">Admin Token</label>
      <input class="login-input" type="password" id="token" name="token" placeholder="Enter admin token" autocomplete="current-password" required>
      <button class="btn-primary btn-block" type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`);
});

app.post(ADMIN_PATH + '/login', rateLimit({ windowMs: 60_000, max: 10, bucket: 'login' }), (req, res) => {
  const { token } = req.body || {};
  if (token && ADMIN_TOKEN && safeEq(token, ADMIN_TOKEN)) {
    // H-02: store opaque session ID in the cookie, not the raw ADMIN_TOKEN.
    // Cookie theft (XSS, stolen jar) no longer recovers the backend token.
    const sessionId = createAdminSession();
    res.cookie('admin_session', sessionId, {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.INSECURE_COOKIE !== 'true',
      maxAge: ADMIN_SESSION_TTL_MS,
    });
    // Clear any legacy admin_token cookie from earlier deploys
    res.clearCookie('admin_token');
    return res.redirect(ADMIN_PATH);
  }
  res.status(401).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login failed</title>
<link rel="stylesheet" href="/sentinel.css">
<style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.fail{max-width:380px;width:100%;text-align:center}.fail a{color:var(--accent);text-decoration:none;font-weight:600}.fail a:hover{color:var(--accent-bright)}</style>
</head><body class="boot-pending">
<script>document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'; document.addEventListener('DOMContentLoaded', () => document.body.classList.remove('boot-pending'));</script>
<div class="fail">
  <div class="callout-error" style="margin-bottom:16px">Invalid token</div>
  <a href="${ADMIN_PATH}/login">Try again</a>
</div></body></html>`);
});

app.post(ADMIN_PATH + '/logout', (req, res) => {
  if (req.headers['x-admin-request'] !== '1') {
    return res.status(403).json({ error: 'Forbidden', hint: 'Include X-Admin-Request: 1 header' });
  }
  const sid = req.signedCookies?.admin_session;
  if (sid) revokeAdminSession(sid);
  res.clearCookie('admin_session');
  res.clearCookie('admin_token'); // legacy
  res.redirect(PUBLIC_MODE ? '/' : ADMIN_PATH + '/login');
});

// ─── Admin dashboard ──────────────────────────────────────────────────────────
app.get(ADMIN_PATH, adminOnly, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Fast stats-only (no results payload) — admin only (includes wallet balance)
app.get('/api/stats', adminOnly, (req, res) => {
  res.json({ state });
});

// ─── SDK version + GitHub parity endpoints ──────────────────────────────────

/** Installed SDK versions — instant, no network. */
app.get('/api/sdk-versions', adminOnly, async (req, res) => {
  try {
    const { readFileSync } = await import('fs');
    const versions = getInstalledVersions(__dirname);
    const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    res.json({ tester: { version: pkg.version, name: pkg.name }, sdks: versions });
  } catch (err) {
    console.error('[api/sdk-versions]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Cached verification state (avoid re-downloading on every UI poll). */
let _sdkVerifyCache = { ts: 0, data: null };
const SDK_VERIFY_TTL_MS = 5 * 60 * 1000;

/** Verify every SDK matches its GitHub tag. Slow (~5s) — downloads tarballs. */
app.get('/api/sdk-verify', adminOnly, async (req, res) => {
  const now = Date.now();
  const forceRefresh = req.query.refresh === '1';
  if (!forceRefresh && _sdkVerifyCache.data && (now - _sdkVerifyCache.ts) < SDK_VERIFY_TTL_MS) {
    res.setHeader('x-cache', 'hit');
    return res.json(_sdkVerifyCache.data);
  }
  try {
    const results = await verifyAllSdks(__dirname);
    _sdkVerifyCache = { ts: now, data: results };
    res.setHeader('x-cache', 'miss');
    res.json(results);
  } catch (err) {
    console.error('[api/sdk-verify]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Verify one SDK by key. ?key=blue-js or ?key=tkd-js */
app.get('/api/sdk-verify/:key', adminOnly, async (req, res) => {
  try {
    const result = await verifySdk(req.params.key, __dirname);
    res.json(result);
  } catch (err) {
    console.error('[api/sdk-verify]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Full state + results
app.get('/api/state', adminOnly, (req, res) => {
  const results = getResults();
  res.json({ state, results });
});

app.get('/api/results', adminOnly, (req, res) => {
  const results = getResults();
  const page = parseInt(req.query.page || '1', 10);
  const limit = parseInt(req.query.limit || '100', 10);
  const start = (page - 1) * limit;
  res.json({ total: results.length, page, results: results.slice(start, start + limit) });
});

// ─── Public SSE stream ──────────────────────────────────────────────────────
// Broadcasts the same events but strips any operator-only fields.
const PUBLIC_EVENT_WHITELIST = new Set([
  'loop:started',
  'loop:stopping',
  'loop:stopped',
  'loop:error',
  'iteration:start',
  'iteration:end',
  // Batch-model events (each full node-sweep is one batch)
  'batch:start',
  'batch:node:result',
  'batch:end',
  'batch:gap',
]);
function sanitizeForPublic(evt) {
  const safe = { type: evt.type };
  if (evt.iteration != null)   safe.iteration   = evt.iteration;
  if (evt.mode != null)        safe.mode        = evt.mode;
  if (evt.passed != null)      safe.passed      = evt.passed;
  if (evt.failed != null)      safe.failed      = evt.failed;
  if (evt.durationMs != null)  safe.durationMs  = evt.durationMs;
  if (evt.error != null)       safe.error       = String(evt.error).slice(0, 200);
  // batch:* event fields — only public-safe node-level data
  if (evt.batchId != null)      safe.batchId      = evt.batchId;
  if (evt.snapshotSize != null) safe.snapshotSize = evt.snapshotSize;
  if (evt.startedAt != null)    safe.startedAt    = evt.startedAt;
  if (evt.gapMs != null)        safe.gapMs        = evt.gapMs;
  if (evt.nextBatchAt != null)  safe.nextBatchAt  = evt.nextBatchAt;
  // batch:node:result public-safe fields.
  // The payload's `type` field (service type: 'wireguard' / 'v2ray' / 1 / 2)
  // would collide with the SSE dispatch `type`, so forward it as `serviceType`.
  if (evt.address != null)    safe.address    = evt.address;
  if (evt.serviceType != null) safe.serviceType = evt.serviceType;
  if (evt.countryCode != null) safe.countryCode = evt.countryCode;
  if (evt.city != null)       safe.city       = evt.city;
  if (evt.actualMbps != null) safe.actualMbps = evt.actualMbps;
  if (evt.peers != null)      safe.peers      = evt.peers;
  if (evt.maxPeers != null)   safe.maxPeers   = evt.maxPeers;
  if (evt.errorCode != null)  safe.errorCode  = evt.errorCode;
  if (evt.testedAt != null)   safe.testedAt   = evt.testedAt;
  if (evt.msg != null)        safe.msg        = String(evt.msg).slice(0, 400);
  if (evt.baselineMbps != null) safe.baselineMbps = evt.baselineMbps;
  if (evt.skipped === true)   safe.skipped    = true;
  if (evt.inPlan === true)    safe.inPlan     = true;
  if (evt.next_in_ms != null) safe.next_in_ms = evt.next_in_ms;
  return safe;
}

const SSE_PING_MS = 20_000; // 20-second heartbeat keeps proxies from dropping the connection

app.get('/api/public/events', attachAdminFlag, rlPublicSse, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  // H-01: strip operator-internal fields (planId, minDelayMs, subscriptionId, etc.) from public init
  const s = continuous.status();
  // Attach the currently-running batch id (if any) so /live can pick up mid-batch on reconnect.
  let activeBatchId = null;
  let activeSnapshotSize = null;
  let activeBatchMode = null;
  try {
    const ab = getActiveBatch();
    if (ab) {
      activeBatchId = ab.batch.id;
      activeSnapshotSize = ab.batch.snapshot_size;
      activeBatchMode = ab.batch.mode;
    }
  } catch (_) {}
  send({
    type: 'init',
    status: { running: s.running, iteration: s.iteration, mode: s.mode, startedAt: s.startedAt, uptime: s.uptime },
    batchId: activeBatchId,
    snapshotSize: activeSnapshotSize,
    batchMode: activeBatchMode,
  });
  const handler = (data) => {
    if (!state.broadcastLive) return;
    if (!PUBLIC_EVENT_WHITELIST.has(data.type)) return;
    send(sanitizeForPublic(data));
  };
  emitter.on('update', handler);
  // 20s heartbeat comment-line — keeps the TCP connection alive through proxies
  const pingInterval = setInterval(() => { try { res.write(':\n\n'); } catch (_) {} }, SSE_PING_MS);
  req.on('close', () => {
    emitter.off('update', handler);
    clearInterval(pingInterval);
  });
});

/**
 * GET /api/public/test/status
 * Read-only loop status snapshot. No wallet / plan IDs.
 */
app.get('/api/public/test/status', attachAdminFlag, rlPublicRead, (req, res) => {
  const s = continuous.status();
  res.json({
    running:   s.running,
    iteration: s.iteration,
    mode:      s.mode,
    startedAt: s.startedAt,
    uptime:    s.uptime,
    lastError: s.lastError ? String(s.lastError).slice(0, 200) : null,
    allowPublicStart: process.env.ALLOW_PUBLIC_TEST === 'true',
  });
});

// Rate-limit: one public start per IP per minute. Entries older than the
// window are useless; sweep them every 5 min so the Map can't grow unbounded
// under internet exposure.
const _publicStartLast = new Map();
const _RATE_WINDOW_MS = 60_000;
function publicStartRateOk(ip) {
  const now = Date.now();
  const prev = _publicStartLast.get(ip) || 0;
  if (now - prev < _RATE_WINDOW_MS) return false;
  _publicStartLast.set(ip, now);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - _RATE_WINDOW_MS;
  for (const [ip, ts] of _publicStartLast) {
    if (ts < cutoff) _publicStartLast.delete(ip);
  }
}, 5 * 60_000).unref();

/**
 * POST /api/public/test/start
 * Gated by ALLOW_PUBLIC_TEST=true. Body: { mode: 'p2p' | 'subscription' }.
 * Subscription mode requires ADMIN to have pre-configured a plan — public body
 * cannot supply planId or wallet. If not configured, start is rejected.
 */
app.post('/api/public/test/start', attachAdminFlag, async (req, res) => {
  if (process.env.ALLOW_PUBLIC_TEST !== 'true') {
    return res.status(403).json({ error: 'Public test start disabled' });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (!publicStartRateOk(ip)) {
    return res.status(429).json({ error: 'Rate limit: one start per minute per IP' });
  }
  if (state.status === 'running' || state.status === 'paused') {
    return res.status(409).json({ error: 'A regular audit is running — try again later.' });
  }
  const mode = (req.body?.mode === 'subscription') ? 'subscription' : 'p2p';
  const planId = mode === 'subscription' ? process.env.PUBLIC_TEST_PLAN_ID : undefined;
  const subscriptionId = mode === 'subscription' ? process.env.PUBLIC_TEST_SUB_ID : undefined;
  const subscriptionGranter = mode === 'subscription' ? process.env.PUBLIC_TEST_SUB_GRANTER : undefined;
  if (mode === 'subscription' && !planId) {
    return res.status(400).json({ error: 'Subscription mode not configured on this server' });
  }
  const result = await continuous.start({ mode, planId, subscriptionId, subscriptionGranter });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, mode, iteration: result.iteration });
});

/**
 * POST /api/public/test/stop
 * Also gated by ALLOW_PUBLIC_TEST.
 */
app.post('/api/public/test/stop', attachAdminFlag, (req, res) => {
  if (process.env.ALLOW_PUBLIC_TEST !== 'true') {
    return res.status(403).json({ error: 'Public test stop disabled' });
  }
  const result = continuous.stop();
  res.json(result);
});

// ─── Broadcast Live toggle ───────────────────────────────────────────────────
app.post('/api/broadcast', adminOnly, (req, res) => {
  state.broadcastLive = !state.broadcastLive;
  res.json({ broadcastLive: state.broadcastLive });
});

app.get('/api/broadcast', (req, res) => {
  res.json({ broadcastLive: state.broadcastLive });
});

const rlAdminSse = sseLimit({ maxPerIp: 10, bucket: 'admin-sse' });
app.get('/api/events', adminOnly, rlAdminSse, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const results = getResults();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const { walletAddress, balance, balanceUdvpn, spentUdvpn, ...stateForSse } = state;
  send({ type: 'init', state: stateForSse, results, logs: logBuffer.slice() });
  const ADMIN_BLOCK = /^(loop:|iteration:|batch:)/;
  const handler = (data) => {
    if (data && typeof data.type === 'string' && ADMIN_BLOCK.test(data.type)) return;
    send(data);
  };
  emitter.on('update', handler);
  // 20s heartbeat comment-line — keeps the TCP connection alive through proxies
  const pingInterval = setInterval(() => { try { res.write(':\n\n'); } catch (_) {} }, SSE_PING_MS);
  req.on('close', () => {
    emitter.off('update', handler);
    clearInterval(pingInterval);
  });
});

// ─── Audit Control Routes ───────────────────────────────────────────────────

// Shared helper: save current run (if any), clear results, allocate new run number + dir.
function startFreshRun(label, { mode = 'p2p', plan_id = null } = {}) {
  const prevResults = getResults();
  if (prevResults.length > 0) {
    const runDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
    try { _mkd(runDir, { recursive: true }); } catch { }
    _wfs(path.join(runDir, 'results.json'), JSON.stringify(prevResults, null, 2), 'utf8');
    try { _cp(path.join(__dirname, 'results', 'failures.jsonl'), path.join(runDir, 'failures.jsonl')); } catch { }
    const idx = loadRunsIndex();
    const existingRun = idx.runs.find(r => r.number === state.activeRunNumber);
    if (!existingRun) {
      idx.runs.push({
        number: state.activeRunNumber,
        label: `Auto-save before ${label}`,
        date: new Date().toISOString(),
        total: prevResults.length,
        passed: prevResults.filter(r => r.actualMbps != null).length,
        failed: prevResults.filter(r => r.actualMbps == null).length,
        pass10: prevResults.filter(r => r.pass10mbps).length,
        sdk: state.activeSDK || 'js',
      });
      saveRunsIndex(idx);
    }
    broadcast('log', { msg: `💾 Saved Test #${state.activeRunNumber} (${prevResults.length} results) before starting ${label}` });
  }

  // Reset in-memory results so the new run starts from zero
  prevResults.length = 0;

  const newNum = getNextRunNumber();
  state.activeRunNumber = newNum;
  state.stopRequested = false;
  state.testedNodes = 0;
  state.failedNodes = 0;
  state.skippedNodes = 0;
  state.passed15 = 0;
  state.passed10 = 0;
  state.passedBaseline = 0;
  state.totalNodes = 0;
  state.retryCount = 0;
  state.estimatedTotalCost = '0 P2P';
  state.spentUdvpn = 0;

  try { _wfs(STATE_SNAPSHOT_FILE, '{}', 'utf8'); } catch { }

  const newRunDir = path.join(RUNS_DIR, `test-${String(newNum).padStart(3, '0')}`);
  try { _mkd(newRunDir, { recursive: true }); } catch { }
  setActiveRunDir(newRunDir);

  const idx2 = loadRunsIndex();
  idx2.activeRun = newNum;
  saveRunsIndex(idx2);

  // ─── SQLite: open a new run record ───────────────────────────────────────
  try {
    const dbRunId = insertRun({
      started_at:     Date.now(),
      mode,
      plan_id:        plan_id || null,
      wallet_address: state.walletAddress || null,
      tester_sdk:     state.activeSDK || 'js',
      tester_os:      process.platform,
    });
    setActiveDbRunId(dbRunId);
    state.activeDbRunId = Number(dbRunId);
  } catch (dbErr) {
    console.error(`[db] insertRun failed: ${dbErr.message}`);
  }

  return { newNum, newRunDir };
}

// Start NEW test (saves current, clears, starts fresh).
app.post('/api/start', adminOnly, async (req, res) => {
  const dryRun = !!(req.body?.dryRun || req.query.dryRun);

  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (continuous.status().running) {
    if (!req.body?.takeover) {
      return res.status(409).json({ error: 'PUBLIC_RUN_ACTIVE', message: 'A public run is active. Pause it and start an audit?' });
    }
    const pr = continuous.pause();
    if (!pr.ok) return res.status(500).json({ error: 'pause failed: ' + pr.error });
    for (let i = 0; i < 100; i++) {
      if (!continuous.status().running) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!dryRun && !MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });

  const runMode = dryRun ? 'dry' : 'p2p';
  const { newNum } = startFreshRun(`Test #${getNextRunNumber()}`, { mode: runMode });

  const SDK_LABELS = { js: 'Blue JS', csharp: 'Blue C#', tkd: 'TKD JS' };
  const label = `${SDK_LABELS[state.activeSDK] || state.activeSDK} SDK, ${process.platform === 'win32' ? 'Windows' : process.platform}`;
  broadcast('log', { msg: `🚀 Starting Test #${newNum} (${label})${dryRun ? ' [TEST RUN]' : ''}` });
  res.json({ ok: true, testNumber: newNum, dryRun });
  runAudit(false, state, broadcast, null, { dryRun }).then(() => {
    saveCurrentRun(`Test #${newNum}`);
    broadcast('log', { msg: `💾 Test #${newNum} complete and saved` });
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

// Resume CURRENT test from where it left off (skips already-tested nodes).
app.post('/api/resume', adminOnly, async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (continuous.status().running) {
    if (!req.body?.takeover) {
      return res.status(409).json({ error: 'PUBLIC_RUN_ACTIVE', message: 'A public run is active. Pause it and start an audit?' });
    }
    const pr = continuous.pause();
    if (!pr.ok) return res.status(500).json({ error: 'pause failed: ' + pr.error });
    for (let i = 0; i < 100; i++) {
      if (!continuous.status().running) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const results = getResults();
  if (results.length === 0) return res.json({ error: 'No results to resume from. Use Start to begin a new test.' });
  state.stopRequested = false;
  // Ensure run directory exists and is active for continuous saves
  const resumeRunDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
  try { _mkd(resumeRunDir, { recursive: true }); } catch { }
  setActiveRunDir(resumeRunDir);

  broadcast('log', { msg: `▶ Resuming Test #${state.activeRunNumber} from node ${results.length + 1} (${results.length} already tested, SDK: ${state.activeSDK.toUpperCase()})` });
  res.json({ ok: true, testNumber: state.activeRunNumber, resumeFrom: results.length });
  runAudit(true, state, broadcast).then(() => {
    saveCurrentRun(`Test #${state.activeRunNumber}`);
    broadcast('log', { msg: `💾 Test #${state.activeRunNumber} saved` });
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

app.post('/api/stop', adminOnly, (req, res) => {
  state.stopRequested = true;
  res.json({ ok: true });
});

// DEPRECATED 2026-04-25: Economy mode removed. Endpoint kept as 410 Gone for any old client.
app.post('/api/economy', adminOnly, (req, res) => {
  res.status(410).json({ error: 'ECONOMY_MODE_DEPRECATED' });
});

app.post('/api/retest-skips', adminOnly, async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const results = getResults();
  const skipAddrs = results.filter(r => r.actualMbps == null && /unreachable/i.test(r.error || '')).map(r => r.address);
  if (skipAddrs.length === 0) return res.json({ error: 'No unreachable failures to retest' });
  state.stopRequested = false;
  res.json({ ok: true, retesting: skipAddrs.length });
  runRetestSkips(skipAddrs, state, broadcast).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

app.post('/api/retest-fails', adminOnly, async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const results = getResults();
  const specific = req.body?.addresses;
  const failAddrs = specific && specific.length > 0
    ? specific
    : results.filter(r => r.error && r.actualMbps == null
        && !r.error.includes('insufficient funds')
        && !r.error.includes('domainsocket')
      ).map(r => r.address);
  if (failAddrs.length === 0) return res.json({ error: 'No failures to retest' });
  state.stopRequested = false;
  res.json({ ok: true, retesting: failAddrs.length, addresses: failAddrs });
  runRetestSkips(failAddrs, state, broadcast).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

// DEPRECATED: Plan testing is WIP — hidden from dashboard, endpoint still functional for API callers
app.post('/api/test-plan', adminOnly, async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  state.stopRequested = false;
  res.json({ ok: true, planId });
  runPlanTest(parseInt(planId), state, broadcast).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

app.get('/api/plans', adminOnly, async (req, res) => {
  try {
    const { discoverPlans } = await import('./core/chain.js');
    const plans = await discoverPlans(null, { maxId: 100 });
    plans.sort((a, b) => b.subscribers - a.subscribers);
    res.json({ plans });
  } catch (err) {
    console.error('[api/plans]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/subscriptions', adminOnly, async (req, res) => {
  try {
    const { querySubscriptions } = await import('./core/chain.js');
    const subs = await querySubscriptions(state.walletAddress);
    res.json({ subscriptions: subs });
  } catch (err) {
    console.error('[api/subscriptions]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Sub. Plan mode: enriched subs with plan owner + fee-grant status + node count
app.get('/api/sub-plans', adminOnly, async (req, res) => {
  try {
    const addr = req.query.address || state.walletAddress;
    if (!addr) return res.json({ plans: [], walletAddress: null });
    const { querySubscriberPlansEnriched } = await import('./core/chain.js');
    const plans = await querySubscriberPlansEnriched(addr);
    res.json({ plans, walletAddress: addr });
  } catch (err) {
    console.error('[api/sub-plans]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Sub. Plan mode: run fee-granted plan test — starts as a fresh run with clean counters.
app.post('/api/test-sub-plan', adminOnly, async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });
  const { planId, subscriptionId, granter } = req.body || {};
  if (!planId) return res.status(400).json({ error: 'planId required' });
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' });
  if (!granter) return res.status(400).json({ error: 'granter (sent1...) required' });

  const { newNum } = startFreshRun(`Sub. Plan ${planId}`, { mode: 'subscription', plan_id: String(planId) });
  broadcast('state', { state, results: getResults() });
  broadcast('log', { msg: `🚀 Starting Test #${newNum} — Sub. Plan ${planId} (fee-granted, wallet pays zero gas)` });
  res.json({ ok: true, testNumber: newNum, planId, subscriptionId, granter });

  runSubPlanTest(String(planId), String(subscriptionId), String(granter), state, broadcast).then(() => {
    saveCurrentRun(`Test #${newNum} — Sub. Plan ${planId}`);
    broadcast('log', { msg: `💾 Test #${newNum} complete and saved` });
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

app.post('/api/clear', adminOnly, (req, res) => {
  const results = getResults();
  results.length = 0;
  state.testedNodes = state.failedNodes = state.skippedNodes = state.passed15 = state.passed10 = state.passedBaseline = 0;
  state.retryCount = 0;
  state.baselineHistory = [];
  state.nodeSpeedHistory = [];
  saveResults();
  broadcast('state', { state, results });
  res.json({ ok: true });
});

/**
 * GET /api/admin/plans
 * Lists available Sentinel plans (delegates to discoverPlans in chain.js).
 * Optional query param: ?maxId=200
 */
app.get('/api/admin/plans', adminOnly, async (req, res) => {
  try {
    const { discoverPlans } = await import('./core/chain.js');
    const maxId = req.query.maxId ? parseInt(req.query.maxId, 10) : 100;
    const plans = await discoverPlans(null, { maxId });
    plans.sort((a, b) => b.subscribers - a.subscribers);
    res.json({ plans });
  } catch (err) {
    console.error('[api/admin/plans]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Failure Analysis API ────────────────────────────────────────────────────
app.get('/api/failure-analysis', adminOnly, (req, res) => {
  const results = getResults();
  const failed = results.filter(r => r.actualMbps == null);
  const analysis = {
    total: results.length,
    passed: results.filter(r => r.actualMbps != null).length,
    failed: failed.length,
    successRate: results.length > 0 ? ((results.filter(r => r.actualMbps != null).length / results.length) * 100).toFixed(1) + '%' : '0%',
    categories: {},
    retestable: [],
    dead: [],
  };

  for (const r of failed) {
    const err = r.error || '';
    let cat, retestable = false, reason;

    if (/already exists/i.test(err)) {
      cat = '409_SESSION_EXISTS'; retestable = true; reason = 'Indexing race — retry with delay';
    } else if (/invalid status inactive|Code: 105/i.test(err)) {
      cat = 'CODE_105_INACTIVE'; retestable = true; reason = 'LCD stale — may have reactivated';
    } else if (/invalid price|code: 106/i.test(err)) {
      cat = 'INVALID_PRICE'; retestable = true; reason = 'Chain rejects price — retry without max_price';
    } else if (/V2Ray service dead|TCP port.*not reachable/i.test(err)) {
      cat = 'TCP_PORT_DEAD'; retestable = false; reason = 'V2Ray proxy down on node';
    } else if (/timed out/i.test(err)) {
      cat = 'NODE_TIMEOUT'; retestable = true; reason = 'Node slow or overloaded — retry later';
    } else if (/address mismatch/i.test(err)) {
      cat = 'ADDRESS_MISMATCH'; retestable = false; reason = 'Node config wrong';
    } else if (/ABCI query failed/i.test(err)) {
      cat = 'NODE_RPC_BROKEN'; retestable = true; reason = 'RPC congestion — may be transient';
    } else if (/timeout of (45|90)000ms/i.test(err)) {
      cat = 'HANDSHAKE_TIMEOUT'; retestable = true; reason = 'Node overloaded — retry later';
    } else if (/duplicate payment/i.test(err)) {
      cat = 'DUPLICATE_PAYMENT'; retestable = true; reason = 'Code bug fixed — should pass now';
    } else if (/SOCKS5.*no internet/i.test(err)) {
      cat = 'SOCKS5_NO_CONNECTIVITY'; retestable = true; reason = 'Tunnel routing dead — intermittent';
    } else if (/database corrupt/i.test(err)) {
      cat = 'NODE_DB_CORRUPT'; retestable = false; reason = 'Node DB broken';
    } else if (/insufficient/i.test(err)) {
      cat = 'INSUFFICIENT_FUNDS'; retestable = false; reason = 'Need more P2P';
    } else {
      cat = 'OTHER'; retestable = true; reason = 'Unknown — worth retrying';
    }

    if (!analysis.categories[cat]) analysis.categories[cat] = { count: 0, retestable, reason, nodes: [] };
    analysis.categories[cat].count++;
    analysis.categories[cat].nodes.push({
      address: r.address, moniker: r.moniker, country: r.country,
      city: r.city, peers: r.peers, type: r.type,
      error: (r.error || '').slice(0, 100),
    });

    if (retestable && r.peers > 0) analysis.retestable.push(r.address);
    else analysis.dead.push(r.address);
  }

  res.json(analysis);
});

// ─── Chain node list (admin-only) ───────────────────────────────────────────
app.get('/api/chain/nodes', adminOnly, async (req, res) => {
  try {
    await ensureLcd();
    const all = await getAllNodes(null);
    res.json({ total: all.length, results: all });
  } catch (err) {
    console.error('[api/chain/nodes]', err);
    res.status(500).json({ error: 'chain fetch failed' });
  }
});

// ─── Live node status (admin-only) ───────────────────────────────────────────
// Proxies nodeStatusV3 against the node's own remoteUrl for the admin UI.
app.get('/api/chain/node-status', adminOnly, async (req, res) => {
  const remoteUrl = String(req.query.remoteUrl || '').trim();
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
    return res.status(400).json({ error: 'remoteUrl query param required' });
  }
  try {
    const s = await nodeStatusV3(remoteUrl);
    res.json({
      address: s.address || '',
      moniker: s.moniker || '',
      type: s.type || '',
      peers: s.peers ?? null,
      maxPeers: s.qos?.max_peers ?? null,
      city: s.location?.city || '',
      country: s.location?.country || '',
      countryCode: s.location?.country_code || '',
      downloadBps: s.bandwidth?.download ?? null,
      uploadBps: s.bandwidth?.upload ?? null,
    });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'node status failed' });
  }
});

// ─── Rescan: re-fetch node list from chain to verify current total ───────────
app.post('/api/rescan', adminOnly, async (req, res) => {
  try {
    broadcast('log', { msg: '🔍 Rescanning chain for current node count...' });
    await ensureLcd();
    const allNodes = await getAllNodes(broadcast);
    const testedAddrs = new Set(getResults().map(r => r.address));
    const remaining = allNodes.filter(n => !testedAddrs.has(n.address)).length;
    state.totalNodes = testedAddrs.size + remaining;
    broadcast('state', { state });
    broadcast('log', { msg: `Rescan: ${allNodes.length} nodes on chain, ${testedAddrs.size} tested, ${remaining} remaining` });
    res.json({ total: allNodes.length, tested: testedAddrs.size, remaining });
  } catch (err) {
    console.error('[api/rescan]', err);
    broadcast('log', { msg: 'Rescan failed (see server logs)' });
    res.json({ error: 'Internal error' });
  }
});

// ─── Transport Intelligence Cache API ────────────────────────────────────────
app.get('/api/transport-cache', adminOnly, (req, res) => {
  loadTransportCache();
  res.json(getCacheStats());
});

// Auto-retest: analyze failures, retest all retestable nodes in one shot
app.post('/api/auto-retest', adminOnly, async (req, res) => {
  if (state.status === 'running' || state.status === 'paused') return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'MNEMONIC not set in .env' });

  const force = req.body?.force === true;
  const results = getResults();
  // Iron Rule: peers > 0 = our fault. Also include peers: null (unknown) for retest.
  const failed = results.filter(r => r.actualMbps == null && r.error);
  const retestable = force ? failed : failed.filter(r => {
    const err = r.error || '';
    if (/No udvpn pricing/i.test(err)) return false;
    return true;
  });

  if (retestable.length === 0) return res.json({ error: 'No retestable failures found' });

  state.stopRequested = false;
  res.json({ ok: true, retesting: retestable.length, addresses: retestable.map(r => r.address) });

  const { runRetestSkips } = await import('./audit/pipeline.js');
  runRetestSkips(retestable.map(r => r.address), state, broadcast).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    broadcast('state', { state });
  });
});

// ─── Test Run Management API ────────────────────────────────────────────────
app.get('/api/runs', adminOnly, (req, res) => {
  const index = loadRunsIndex();
  res.json({ runs: index.runs, activeRun: state.activeRunNumber });
});

app.post('/api/runs/save', adminOnly, (req, res) => {
  const label = req.body?.label || '';
  const num = saveCurrentRun(label);
  if (num) {
    state.activeRunNumber = num;
    broadcast('log', { msg: `💾 Saved as Test #${num}` });
    res.json({ ok: true, number: num });
  } else {
    res.json({ error: 'No results to save' });
  }
});

app.get('/api/runs/:num', adminOnly, (req, res) => {
  const num = parseInt(req.params.num);
  const data = loadRun(num);
  if (!data) return res.status(404).json({ error: `Test #${num} not found` });
  const passed = data.filter(r => r.actualMbps != null);
  const failed = data.filter(r => r.actualMbps == null);
  res.json({
    number: num,
    total: data.length,
    passed: passed.length,
    failed: failed.length,
    pass10: passed.filter(r => r.actualMbps >= 10).length,
    results: data,
  });
});

app.post('/api/runs/load/:num', adminOnly, (req, res) => {
  const num = parseInt(req.params.num);
  const data = loadRun(num);
  if (!data) return res.status(404).json({ error: `Test #${num} not found` });

  // Replace current results with loaded run
  const results = getResults();
  results.length = 0;
  results.push(...data);
  saveResults();
  rehydrateState(data);
  state.activeRunNumber = num;
  state.status = 'idle';
  broadcast('state', { state, results: data });
  broadcast('log', { msg: `📂 Loaded Test #${num} (${data.length} results)` });
  res.json({ ok: true, number: num, total: data.length });
});

// ─── SDK Toggle ─────────────────────────────────────────────────────────────
app.post('/api/sdk', adminOnly, (req, res) => {
  const { sdk } = req.body;
  const SDK_LABELS = { js: 'Blue JS', csharp: 'Blue C#', tkd: 'TKD JS (Official)' };
  if (SDK_LABELS[sdk]) {
    const changed = state.activeSDK !== sdk;
    state.activeSDK = sdk;
    try { _wfs(SDK_PREF_FILE, sdk, 'utf8'); } catch {}
    if (changed) {
      broadcast('state', { state });
      broadcast('log', { msg: `SDK switched to ${SDK_LABELS[sdk]}` });
    }
    res.json({ ok: true, sdk });
  } else {
    res.status(400).json({ error: 'Invalid SDK. Use "js", "csharp", or "tkd"' });
  }
});

app.get('/api/sdk', adminOnly, (req, res) => {
  res.json({ sdk: state.activeSDK });
});

// ─── Health Check (prelaunch validation for AI/automation) ─────────────────
app.get('/api/health', adminOnly, async (req, res) => {
  const { checkV2Ray } = process.platform === 'win32'
    ? await import('./platforms/windows/v2ray.js')
    : { checkV2Ray: async () => { try { const { execSync } = await import('child_process'); execSync('which v2ray', { stdio: 'pipe' }); return true; } catch { return false; } } };
  const v2ray = await checkV2Ray();
  const issues = [];
  if (!MNEMONIC) issues.push('MNEMONIC not set in .env — copy .env.example to .env and add your wallet mnemonic');
  if (!IS_ADMIN && WG_AVAILABLE) issues.push('Not running as Administrator — WireGuard nodes will fail. Use SentinelAudit.vbs (Windows) or sudo (macOS/Linux)');
  if (!v2ray) issues.push('V2Ray binary not found — download from https://github.com/v2fly/v2ray-core/releases and place in bin/');
  if (!WG_AVAILABLE && process.platform === 'win32') issues.push('WireGuard not installed — install from https://www.wireguard.com/install/');
  res.json({
    status: issues.length === 0 ? 'ready' : 'issues',
    platform: process.platform,
    admin: IS_ADMIN,
    mnemonic: MNEMONIC ? 'set' : 'missing',
    wireguard: WG_AVAILABLE,
    v2ray,
    sdk: state.activeSDK,
    balance: state.balance || 'unknown',
    issues,
  });
});

// ─── Cross-SDK Comparison Data ─────────────────────────────────────────────
app.get('/api/cross-sdk', adminOnly, (req, res) => {
  // Build a map of nodeAddress → { sdk: { passed, speed, error, run, date } } from all saved runs
  const map = {};
  const idx = loadRunsIndex();
  for (const run of (idx.runs || [])) {
    const runDir = path.join(RUNS_DIR, `test-${String(run.number).padStart(3, '0')}`);
    const rFile = path.join(runDir, 'results.json');
    if (!existsSync(rFile)) continue;
    let results;
    try { results = JSON.parse(_rfs(rFile, 'utf8')); } catch { continue; }
    const sdk = run.sdk || 'js';
    const runDate = run.date || '';
    const runNum = run.number;
    for (const r of results) {
      if (!r.address) continue;
      if (!map[r.address]) map[r.address] = {};
      const passed = r.actualMbps != null && r.actualMbps > 0;
      if (!map[r.address][sdk] || (passed && !map[r.address][sdk].passed)) {
        map[r.address][sdk] = { passed, speed: r.actualMbps, error: r.error?.slice(0, 60) || null, run: runNum, date: runDate };
      }
    }
  }
  // Also include current live results
  const currentResults = getResults();
  const currentSdk = state.activeSDK || 'js';
  const now = new Date().toISOString();
  for (const r of currentResults) {
    if (!r.address) continue;
    if (!map[r.address]) map[r.address] = {};
    const passed = r.actualMbps != null && r.actualMbps > 0;
    if (!map[r.address][currentSdk] || (passed && !map[r.address][currentSdk].passed)) {
      map[r.address][currentSdk] = { passed, speed: r.actualMbps, error: r.error?.slice(0, 60) || null, run: state.activeRunNumber, date: now };
    }
  }
  res.json(map);
});

// ─── DNS Configuration ──────────────────────────────────────────────────────
app.get('/api/dns', adminOnly, (req, res) => {
  res.json({ servers: ACTIVE_DNS, presets: Object.keys(DNS_PRESETS) });
});

app.post('/api/dns', adminOnly, (req, res) => {
  const { preset, servers } = req.body || {};
  if (preset && DNS_PRESETS[preset]) {
    setActiveDns([...DNS_PRESETS[preset]]);
    broadcast('log', { msg: `🔧 DNS changed to ${preset}: ${DNS_PRESETS[preset].join(', ')}` });
    return res.json({ ok: true, servers: DNS_PRESETS[preset], preset });
  }
  if (servers && Array.isArray(servers) && servers.length > 0) {
    setActiveDns(servers);
    broadcast('log', { msg: `🔧 DNS changed to custom: ${servers.join(', ')}` });
    return res.json({ ok: true, servers });
  }
  res.status(400).json({ error: 'Provide preset (default|hns|cloudflare|google) or servers array' });
});

// ─── Dictator Mode ──────────────────────────────────────────────────────────
app.get('/dictator', adminOnly, (req, res) => res.sendFile(path.join(__dirname, 'dictator.html')));

app.get('/api/dictator', adminOnly, (req, res) => {
  const results = getResults();
  const countryMap = {};
  for (const r of results) {
    const country = r.country || 'Unknown';
    if (!countryMap[country]) {
      countryMap[country] = {
        country,
        total: 0,
        tested: 0,
        googleYes: 0,
        googleNo: 0,
        googleUnknown: 0,
        googleLatencySum: 0,
        googleLatencyCount: 0,
        nodes: [],
      };
    }
    const c = countryMap[country];
    c.total++;
    if (r.actualMbps != null) c.tested++;
    if (r.googleAccessible === true) {
      c.googleYes++;
      if (r.googleLatencyMs != null) {
        c.googleLatencySum += r.googleLatencyMs;
        c.googleLatencyCount++;
      }
    } else if (r.googleAccessible === false) {
      c.googleNo++;
    } else {
      c.googleUnknown++;
    }
    c.nodes.push({
      address: r.address,
      moniker: r.moniker,
      city: r.city,
      googleAccessible: r.googleAccessible,
      googleLatencyMs: r.googleLatencyMs,
      actualMbps: r.actualMbps,
      type: r.type,
      error: r.error || null,
    });
  }
  const countries = Object.values(countryMap)
    .map(c => ({
      country: c.country,
      total: c.total,
      tested: c.tested,
      googleYes: c.googleYes,
      googleNo: c.googleNo,
      googleUnknown: c.googleUnknown,
      avgGoogleLatencyMs: c.googleLatencyCount > 0
        ? Math.round(c.googleLatencySum / c.googleLatencyCount)
        : null,
      nodes: c.nodes,
    }))
    .sort((a, b) => a.country.localeCompare(b.country));
  res.json({ sdk: state.activeSDK, countries, generatedAt: new Date().toISOString() });
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Server Startup ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nSentinel Node Audit Dashboard → http://localhost:${PORT}`);
  console.log(`Dictator Mode → http://localhost:${PORT}/dictator\n`);
  if (!IS_ADMIN) {
    console.warn('⚠  NOT running as Administrator — WireGuard tests will be skipped.');
  } else {
    console.log('✓  Running as Administrator — WireGuard tunnels will work without UAC.\n');
  }

  if (!MNEMONIC) {
    console.log('┌──────────────────────────────────────────────────────────────┐');
    console.log('│  No MNEMONIC configured — dashboard is view-only.           │');
    console.log('│                                                              │');
    console.log('│  To run audits:                                              │');
    console.log('│    1. Copy .env.example to .env                              │');
    console.log('│    2. Add your Sentinel wallet mnemonic                      │');
    console.log('│    3. Restart the server                                     │');
    console.log('└──────────────────────────────────────────────────────────────┘');
  }

  // Close any orphaned batch / run rows from a previous boot so a /live or
  // admin refresh doesn't hydrate from a phantom run that never got its
  // batch:end / loop:stopped event.
  try {
    const { getDb } = await import('./core/db.js');
    const db = getDb();
    const orphans = db.prepare(
      `SELECT id FROM batches WHERE finished_at IS NULL`,
    ).all();
    for (const o of orphans) {
      const { results } = getBatchResults(o.id, { limit: 100000 });
      let passed = 0, failed = 0;
      for (const r of results) {
        if (r.actual_mbps != null && r.actual_mbps > 0 && !r.error) passed++;
        else failed++;
      }
      updateBatchOnFinish(o.id, { finished_at: Date.now(), passed, failed });
    }
    if (orphans.length > 0) {
      console.log(`✓  Closed ${orphans.length} orphaned batch(es) from previous boot.`);
    }
    const orphanRuns = db.prepare(
      `SELECT id FROM runs WHERE finished_at IS NULL`,
    ).all();
    for (const r of orphanRuns) {
      const stat = db.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN actual_mbps > 0 AND error_message IS NULL THEN 1 ELSE 0 END) AS p FROM results WHERE run_id = ?`,
      ).get(r.id);
      updateRunOnFinish(r.id, {
        finished_at: Date.now(),
        node_count: stat?.n || 0,
        pass_count: stat?.p || 0,
      });
    }
    if (orphanRuns.length > 0) {
      console.log(`✓  Closed ${orphanRuns.length} orphaned run(s) in results table.`);
    }
  } catch (err) {
    console.error('Orphan-batch cleanup error:', err.message);
  }

  // ─── Auto-resume continuous loop from last-persisted config ───────────────
  // If the loop was running when the server was stopped/killed, pick it up
  // again on boot so a perpetual public test survives restarts.
  if (MNEMONIC) {
    try {
      const r = await continuous.resumeFromPersisted();
      if (r.resumed) {
        console.log(`✓  Auto-resumed continuous loop in mode "${r.mode}" from persisted config.`);
      } else if (r.reason && r.reason !== 'no-config-or-stopped') {
        console.warn(`⚠  Auto-resume attempted but failed: ${r.reason}`);
      }
    } catch (err) {
      console.error('Auto-resume error:', err.message);
    }
  }

  if (MNEMONIC) {
    try {
      const w = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
      const [acc] = await w.getAccounts();
      state.walletAddress = acc.address;
      const tmpClient = await SigningStargateClient.connectWithSigner(
        'https://rpc.sentinel.co:443', w,
        { gasPrice: GasPrice.fromString(GAS_PRICE) },
      );
      const bal = await tmpClient.getBalance(acc.address, DENOM);
      state.balanceUdvpn = parseInt(bal?.amount || '0', 10);
      state.spentUdvpn = 0; // Real chain balance is the truth — reset estimate
      state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P`;
      state.estimatedTotalCost = '0 P2P';
      tmpClient.disconnect();
      console.log(`Wallet: ${acc.address} | Balance: ${state.balance}`);
      // Broadcast fresh balance to any SSE clients that connected before chain query finished
      broadcast('state', { state });
    } catch (err) {
      console.error('Failed to fetch initial balance:', err.message);
    }
  }

  // ─── Periodic balance refresh (runs even when idle) ────────────────────────
  if (MNEMONIC) {
    setInterval(async () => {
      // Skip refresh during active audit — pipeline handles its own refresh
      if (state.status === 'running' || state.status === 'paused_balance') return;
      try {
        const w = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
        const [acc] = await w.getAccounts();
        const tmpClient = await SigningStargateClient.connectWithSigner(
          'https://rpc.sentinel.co:443', w,
          { gasPrice: GasPrice.fromString(GAS_PRICE) },
        );
        const bal = await tmpClient.getBalance(acc.address, DENOM);
        const fresh = parseInt(bal?.amount || '0', 10);
        tmpClient.disconnect();
        if (fresh !== state.balanceUdvpn) {
          state.balanceUdvpn = fresh;
          state.spentUdvpn = 0;
          state.balance = `${(fresh / 1_000_000).toFixed(4)} P2P`;
          broadcast('state', { state });
        }
      } catch { /* non-critical */ }
    }, 2 * 60_000); // Every 2 minutes
  }
});
