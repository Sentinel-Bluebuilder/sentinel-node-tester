/**
 * Sentinel Node Tester — Constants & Configuration
 * Central source of truth for all config, endpoints, and protocol constants.
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── Environment Config ──────────────────────────────────────────────────────
export const MNEMONIC = process.env.MNEMONIC;
// Default RPC: busurnode (verified 2026-05-02, ~125ms). rpc.sentinel.co is
// excluded — it has been stuck ~22k blocks behind tip while still reporting
// catching_up=false, returning stale ABCI state (e.g. zero balance for
// funded addresses). Override via env if you maintain a private node.
export const RPC = process.env.RPC || 'https://rpc-sentinel.busurnode.com';
export const DENOM = process.env.DENOM || 'udvpn';
export const GAS_PRICE = process.env.GAS_PRICE || '0.2udvpn';
export const GIGS = Math.max(1, parseInt(process.env.GIGABYTES_PER_NODE || '1', 10));
export const TEST_MB = parseInt(process.env.TEST_MB || '10', 10);
export const MAX_NODES = parseInt(process.env.MAX_NODES || '0', 10);
export const NODE_DELAY = parseInt(process.env.NODE_DELAY_MS || '5000', 10);
export const LOW_BALANCE_WARN = 500_000; // 0.5 P2P
export const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── DNS Configuration ──────────────────────────────────────────────────────
// Default: HNS (Handshake) — decentralized DNS, 0.01% error rate across 9,298 tests.
// SDK uses key `handshake`; tester uses `hns` historically — both keys resolve to the same servers.
const _hns = ['198.51.100.1', '198.51.100.1'];
export const DNS_PRESETS = {
  hns:        _hns,
  handshake:  _hns,
  google:     ['8.8.8.8', '8.8.4.4'],
  cloudflare: ['1.1.1.1', '1.0.0.1'],
  quad9:      ['9.9.9.9', '149.112.112.112'],
  opendns:    ['208.67.222.222', '208.67.220.220'],
};
export let ACTIVE_DNS = (process.env.DNS_SERVERS || '').split(',').map(s => s.trim()).filter(Boolean);
if (ACTIVE_DNS.length === 0) ACTIVE_DNS = DNS_PRESETS.hns;
export function setActiveDns(servers) { ACTIVE_DNS = servers; }

// ─── Protocol Message Types (from SDK — single source of truth) ─────────────
import { MSG_TYPES } from 'blue-js-sdk';
export { MSG_TYPES };
export const V3_MSG_TYPE = MSG_TYPES.START_SESSION;
export const V3_SUB_TYPE = MSG_TYPES.START_SUBSCRIPTION;
export const V3_SUB_SESSION_TYPE = MSG_TYPES.SUB_START_SESSION;

// ─── RPC Endpoints (verified 2026-05-02, sorted by latency) ─────────────────
// Audited end-to-end: connect + /status + ABCI bank balance against a known
// funded address (see scripts/audit-rpc-endpoints.mjs). rpc.sentinel.co is kept
// last as a stale-fallback only — it reports catching_up=false while serving
// state ~22k blocks behind tip.
export const RPC_ENDPOINTS = [
  RPC,                                          // env-overridable primary (default busurnode)
  'https://sentinel-rpc.publicnode.com',        // ~459ms
  'https://rpc.trinitystake.io',                // ~470ms
  'https://rpc.sentinel.validatus.com',         // ~643ms
  'https://sentinel-rpc.polkachu.com',          // ~666ms
  'https://rpc.dvpn.roomit.xyz',                // ~920ms
  'https://rpc.sentinel.quokkastake.io',        // ~923ms
  'https://rpc.sentinel.suchnode.net',          // ~962ms
  'https://rpc-sentinel.chainvibes.com',        // ~1035ms
  'https://rpc.sentineldao.com',                // ~2323ms
  'https://rpc.mathnodes.com',                  // ~2380ms
  'https://rpc.sentinel.chaintools.tech',       // ~3935ms
  'https://rpc.sentinel.co:443',                // stale-fallback only
];

// ─── LCD Endpoints (verified 2026-05-02, parity with blue-js-sdk@2.7.1) ─────
// lcd.sentinel.co kept last for the same reason as rpc.sentinel.co.
export const LCD_ENDPOINTS = [
  'https://lcd-sentinel.busurnode.com',
  'https://sentinel-rest.publicnode.com',
  'https://api.sentinel.suchnode.net',
  'https://sentinel-api.polkachu.com',
  'https://api.dvpn.roomit.xyz',
  'https://api.sentinel.quokkastake.io',
  'https://api.sentinel.chaintools.tech',
  'https://api-sentinel.chainvibes.com',
  'https://api.sentinel.validatus.com',
  'https://lcd.sentinel.co',
];

// ─── Batch Payment ───────────────────────────────────────────────────────────
export const BATCH_SIZE = 5;

// ─── Cache TTLs ──────────────────────────────────────────────────────────────
export const NODE_CACHE_TTL = 5 * 60_000;       // 5 min
export const SESSION_MAP_TTL = 120_000;          // 2 min

// ─── Paths ───────────────────────────────────────────────────────────────────
export const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');
export const RESULTS_FILE = path.join(RESULTS_DIR, 'results.json');
export const CREDS_FILE = path.join(RESULTS_DIR, 'session-credentials.json');
export const FAILURE_LOG = path.join(RESULTS_DIR, 'failures.jsonl');
export const TRANSACTIONS_LOG = path.join(RESULTS_DIR, 'transactions.jsonl');

// ─── Platform ────────────────────────────────────────────────────────────────
export const PLATFORM = process.platform; // 'win32', 'darwin', 'linux'
