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
export const RPC = process.env.RPC || 'https://rpc.sentinel.co:443';
export const DENOM = process.env.DENOM || 'udvpn';
export const GAS_PRICE = process.env.GAS_PRICE || '0.2udvpn';
export const GIGS = Math.max(1, parseInt(process.env.GIGABYTES_PER_NODE || '1', 10));
export const TEST_MB = parseInt(process.env.TEST_MB || '10', 10);
export const MAX_NODES = parseInt(process.env.MAX_NODES || '0', 10);
export const NODE_DELAY = parseInt(process.env.NODE_DELAY_MS || '5000', 10);
export const LOW_BALANCE_WARN = 500_000; // 0.5 DVPN
export const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── DNS Configuration ──────────────────────────────────────────────────────
// Presets: default (OpenDNS), hns (Handshake HDNS), cloudflare, google, custom
export const DNS_PRESETS = {
  default:    ['208.67.222.222', '208.67.220.220'],
  hns:        ['103.196.38.38', '103.196.38.39'],
  cloudflare: ['1.1.1.1', '1.0.0.1'],
  google:     ['8.8.8.8', '8.8.4.4'],
};
export let ACTIVE_DNS = (process.env.DNS_SERVERS || '').split(',').map(s => s.trim()).filter(Boolean);
if (ACTIVE_DNS.length === 0) ACTIVE_DNS = DNS_PRESETS.default;
export function setActiveDns(servers) { ACTIVE_DNS = servers; }

// ─── Protocol Message Types ──────────────────────────────────────────────────
export const V3_MSG_TYPE = '/sentinel.node.v3.MsgStartSessionRequest';
export const V3_SUB_TYPE = '/sentinel.subscription.v3.MsgStartSubscriptionRequest';
export const V3_SUB_SESSION_TYPE = '/sentinel.subscription.v3.MsgStartSessionRequest';

// ─── RPC Endpoints (ordered by reliability) ──────────────────────────────────
export const RPC_ENDPOINTS = [
  RPC,
  'https://sentinel-rpc.polkachu.com',
  'https://rpc.sentinel.quokkastake.io',
  'https://sentinel-rpc.publicnode.com:443',
];

// ─── LCD Endpoints (ordered by reliability) ──────────────────────────────────
export const LCD_ENDPOINTS = [
  'https://sentinel-api.polkachu.com',
  'https://api.sentinel.quokkastake.io',
  'https://sentinel-rest.publicnode.com',
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
