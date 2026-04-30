/**
 * Sentinel Node Tester — Wallet & Client Management
 * Adapter: uses SDK for wallet derivation, client creation, and broadcasting.
 * Keeps audit-specific: memoized wallet setup, managed client with RPC rotation.
 */

import { createHash } from 'crypto';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { assertIsDeliverTxSuccess } from '@cosmjs/stargate';

import {
  createWallet as sdkCreateWallet,
  privKeyFromMnemonic as sdkPrivKey,
  createClient as sdkCreateClient,
  buildRegistry,
  broadcast as sdkBroadcast,
  createSafeBroadcaster,
  clearWalletCache,
  RPC_ENDPOINTS as SDK_RPC_ENDPOINTS,
  SDK_VERSION,
} from 'blue-js-sdk';
import { RPC_ENDPOINTS as LOCAL_RPC_ENDPOINTS, GAS_PRICE as GAS_PRICE_STR } from './constants.js';

// Use SDK RPC endpoints (5 endpoints), fall back to local constants
const RPC_LIST = SDK_RPC_ENDPOINTS.map(e => e.url);

// ─── Wallet derivation cache (audit-specific: avoids re-deriving for 1000-node scans) ─
const _walletCache = new Map();

export async function cachedWalletSetup(mnemonic) {
  const key = createHash('sha256').update(mnemonic).digest('hex').substring(0, 16);
  if (_walletCache.has(key)) return _walletCache.get(key);
  const [wallet, privkey] = await Promise.all([
    DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'sent' }),
    privKeyFromMnemonic(mnemonic),
  ]);
  const [account] = await wallet.getAccounts();
  const result = { wallet, account, privkey };
  _walletCache.set(key, result);
  return result;
}

/** Derive raw secp256k1 private key (32 bytes) from mnemonic — delegates to SDK */
export async function privKeyFromMnemonic(mnemonic) {
  return sdkPrivKey(mnemonic);
}

// ─── Managed client with RPC rotation ──────────────────────────────────────
let _activeRpcIdx = 0;
let _managedClient = null;
let _managedWallet = null;

/** Build the SDK's full registry (22 message types) */
export function buildV3Registry() {
  return buildRegistry();
}

/** Create a fresh SigningStargateClient, rotating through RPC endpoints on failure */
export async function createFreshClient(wallet, broadcast) {
  for (let i = 0; i < RPC_LIST.length; i++) {
    const idx = (_activeRpcIdx + i) % RPC_LIST.length;
    const rpc = RPC_LIST[idx];
    try {
      const c = await sdkCreateClient(rpc, wallet);
      _activeRpcIdx = idx;
      _managedClient = c;
      _managedWallet = wallet;
      if (i > 0 && broadcast) broadcast('log', { msg: `  🔄 Switched to RPC: ${rpc}` });
      return c;
    } catch { /* try next */ }
  }
  throw new Error('All RPC endpoints unreachable');
}

/** Get current client, or reconnect if stale */
export async function getOrReconnectClient() {
  if (_managedClient) return _managedClient;
  if (!_managedWallet) throw new Error('No wallet configured — call createFreshClient first');
  return createFreshClient(_managedWallet);
}

/** Force reconnect (call after persistent errors) */
export async function forceReconnect() {
  if (_managedClient) { try { _managedClient.disconnect(); } catch { } }
  _managedClient = null;
  clearWalletCache();
  _activeRpcIdx = (_activeRpcIdx + 1) % RPC_LIST.length;
  return getOrReconnectClient();
}

// ─── Wallet broadcast mutex ────────────────────────────────────────────────
// Cosmos accounts have a single sequence counter. If two broadcasts from this
// wallet are in flight simultaneously (e.g. an SNTR1 self-send + a session
// start), they grab the same sequence → "expected N+1, got N". Serialize all
// signAndBroadcast calls behind this chained promise so only one TX is in
// flight at a time per process. Exported so the fee-grant broadcaster in
// core/chain.js can share the SAME mutex — separate mutexes still race.
let _broadcastChain = Promise.resolve();
export function broadcastSerialized(fn) {
  const next = _broadcastChain.then(fn, fn);
  _broadcastChain = next.catch(() => {});
  return next;
}
const _broadcastSerialized = broadcastSerialized;

// ─── signAndBroadcast with retry + reconnect ────────────────────────────────
export async function signAndBroadcastRetry(client, address, messages, fee, broadcast, maxRetries = 3, opts = {}) {
  // Fee validation (M-6 pattern from SDK)
  if (!fee || typeof fee !== 'object' || !fee.gas) {
    fee = { amount: [{ denom: 'udvpn', amount: '200000' }], gas: '800000' };
  }
  const memo = typeof opts.memo === 'string' ? opts.memo : '';
  return _broadcastSerialized(async () => {
    let activeClient = client;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await activeClient.signAndBroadcast(address, messages, fee, memo);
        if (activeClient !== client) _managedClient = activeClient;
        return result;
      } catch (err) {
        const isRetryable = /sequence mismatch/i.test(err.message)
          || /wrong number of signers/i.test(err.message)
          || /Query failed/i.test(err.message);
        if (attempt < maxRetries && isRetryable) {
          const label = /sequence/i.test(err.message) ? 'Sequence mismatch' : 'RPC/chain error';
          if (broadcast) broadcast('log', { msg: `  ⚡ ${label} — retrying with fresh RPC (${attempt + 1}/${maxRetries})...` });
          if (/Query failed|wrong number of signers/i.test(err.message)) {
            try { activeClient = await forceReconnect(); }
            catch (e) { if (broadcast) broadcast('log', { msg: `  ⚠ Reconnect failed: ${e.message}` }); }
          }
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  });
}

export { assertIsDeliverTxSuccess, createSafeBroadcaster, SDK_VERSION };
