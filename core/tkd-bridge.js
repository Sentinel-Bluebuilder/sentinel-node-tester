/**
 * TKD Alex Official SDK Bridge — wraps @sentinel-official/sentinel-js-sdk
 * and maps output to the same shapes as Blue JS SDK functions.
 *
 * Used when activeSDK === 'tkd' to test the official Sentinel JS SDK's
 * FULL pipeline: node status, handshake, V2Ray/WG config, session creation.
 *
 * Usage pattern copied from official example:
 *   https://github.com/sentinel-official/sentinel-js-sdk/blob/main/examples/node/main.ts
 */

import {
  SigningSentinelClient,
  SentinelClient,
  nodeInfo as tkdNodeInfoRaw,
  handshake as tkdHandshakeRaw,
  privKeyFromMnemonic as tkdPrivKey,
  V2Ray as TkdV2Ray,
  Wireguard as TkdWireguard,
  nodeStartSession,
} from '@sentinel-official/sentinel-js-sdk';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { GasPrice, assertIsDeliverTxSuccess } from '@cosmjs/stargate';
import Long from 'long';
import axios from 'axios';
import https from 'https';
import { MNEMONIC, RPC_ENDPOINTS as TKD_RPC_ENDPOINTS } from './constants.js';

// ─── Shared HTTPS agent (TLS TOFU — same as Blue JS SDK) ─────────────────
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Availability Check ────────────────────────────────────────────────────
export const TKD_AVAILABLE = true;

// ─── RPC Endpoints (verified 2026-05-02, see core/constants.js) ─────────────
// TKD_RPC_ENDPOINTS is just a renamed import of the canonical RPC_ENDPOINTS so
// any future endpoint refresh only lands in one file.

// ─── Cached instances ──────────────────────────────────────────────────────
let _queryClient = null;
let _signingClient = null;
let _activeRpcIdx = 0;
let _cachedPrivKey = null;

async function getQueryClient() {
  if (_queryClient) return _queryClient;
  for (let i = 0; i < TKD_RPC_ENDPOINTS.length; i++) {
    const idx = (_activeRpcIdx + i) % TKD_RPC_ENDPOINTS.length;
    try {
      _queryClient = await SentinelClient.connect(TKD_RPC_ENDPOINTS[idx]);
      _activeRpcIdx = idx;
      return _queryClient;
    } catch { /* try next */ }
  }
  throw new Error('TKD SDK: All RPC endpoints unreachable');
}

export async function getTkdSigningClient(mnemonic) {
  if (_signingClient) return _signingClient;
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'sent' });
  const gasPrice = GasPrice.fromString('0.2udvpn');
  for (let i = 0; i < TKD_RPC_ENDPOINTS.length; i++) {
    const idx = (_activeRpcIdx + i) % TKD_RPC_ENDPOINTS.length;
    try {
      _signingClient = await SigningSentinelClient.connectWithSigner(TKD_RPC_ENDPOINTS[idx], wallet, { gasPrice });
      _activeRpcIdx = idx;
      return _signingClient;
    } catch { /* try next */ }
  }
  throw new Error('TKD SDK: All RPC endpoints unreachable for signing');
}

export function tkdReconnect() {
  if (_queryClient) { try { _queryClient.disconnect(); } catch { } }
  if (_signingClient) { try { _signingClient.disconnect(); } catch { } }
  _queryClient = null;
  _signingClient = null;
  _activeRpcIdx = (_activeRpcIdx + 1) % TKD_RPC_ENDPOINTS.length;
}

async function getTkdPrivKey() {
  if (_cachedPrivKey) return _cachedPrivKey;
  _cachedPrivKey = await tkdPrivKey({ mnemonic: MNEMONIC });
  return _cachedPrivKey;
}

// ─── Handshake Error Wrapper ──────────────────────────────────────────────
// TKD SDK's handshake() has ZERO error handling — axios throws on non-2xx
// and the raw error loses the response body. Blue JS SDK has chain-lag retry,
// 409-as-success, database error detection, and detailed error messages.
// This wrapper adds equivalent error handling around TKD's raw handshake.

/**
 * Wrap TKD handshake() with Blue-JS-equivalent error handling.
 * - 409 "session already exists" → treat as success (extract result from error response)
 * - "does not exist" / 404+code5 → chain lag → retry once after 10s
 * - 500 with sqlite errors → NODE_DATABASE_CORRUPT
 * - All other errors → rethrow with response body in message
 *
 * @param {Long} sessionId
 * @param {object} data - peer data (e.g. {uuid: [...]} or {public_key: "..."})
 * @param {Uint8Array} privKey
 * @param {string} url
 * @returns {Promise<{data: string, addrs: string[]}>} handshake result
 */
async function tkdHandshakeWithRetry(sessionId, data, privKey, url) {
  const doHandshake = async () => {
    try {
      return await tkdHandshakeRaw(sessionId, data, privKey, url);
    } catch (err) {
      const status = err.response?.status;
      const errData = err.response?.data;
      const bodyStr = typeof errData === 'string' ? errData : JSON.stringify(errData || '');

      // 409 "session already exists" — node already has our session + peer data.
      // Extract the config from the error response instead of wasting tokens.
      if (status === 409 && errData?.result?.data) {
        return errData.result;
      }

      // Detect corrupted node database (HTTP 500 with sqlite errors)
      if (status === 500 && (bodyStr.includes('no such table') || bodyStr.includes('database is locked') || bodyStr.includes('disk I/O error'))) {
        throw new Error(`Node database corrupt: ${bodyStr.substring(0, 200)}`);
      }

      // Detect chain lag — session not yet visible on node
      const isChainLag = bodyStr.includes('does not exist') ||
        (status === 404 && errData?.code === 5);
      if (isChainLag) {
        return { _chainLag: true, detail: bodyStr.substring(0, 200) };
      }

      // For any HTTP error, include the response body in the error message
      // so we can diagnose node-side issues (signature verification failures, etc.)
      if (status) {
        const detail = bodyStr.substring(0, 300);
        throw new Error(`TKD handshake HTTP ${status}: ${detail}`);
      }

      // Non-HTTP error (timeout, network, etc.) — rethrow as-is
      throw err;
    }
  };

  let result = await doHandshake();

  // Chain-lag retry — wait 10s then try once more
  if (result?._chainLag) {
    console.log('[TKD] Session not yet visible on node — waiting 10s for chain propagation...');
    await new Promise(r => setTimeout(r, 10_000));
    result = await doHandshake();
    if (result?._chainLag) {
      throw new Error(`TKD handshake failed: session does not exist on node after retry (chain lag). Detail: ${result.detail}`);
    }
  }

  return result;
}

// ─── Node Status (TKD SDK — uses tkd's nodeInfo()) ────────────────────────

/**
 * Query node status via TKD SDK's nodeInfo().
 * Returns same shape as Blue JS nodeStatusV3().
 *
 * IMPORTANT: Also measures clock drift from the node's HTTP Date header.
 * VMess AEAD auth fails when |client_time - server_time| > 120s.
 * Without drift detection, buildV2RayClientConfig always uses alterId=0 (AEAD)
 * which breaks on drifted nodes. Blue JS detects this; TKD must too.
 */
export async function tkdNodeStatus(remoteUrl) {
  const url = remoteUrl.startsWith('http') ? remoteUrl : `https://${remoteUrl}`;

  // Make our OWN HTTP GET to capture the Date header for clock drift detection.
  // TKD's nodeInfo() returns only response.data.result — no headers.
  const before = Date.now();
  const res = await axios.get(url, { httpsAgent, timeout: 15_000 });
  const after = Date.now();
  const info = res.data?.result || {};

  // Clock drift detection — matches Blue JS nodeStatusV3() exactly.
  let clockDriftSec = null;
  const dateHeader = res.headers?.['date'];
  if (dateHeader) {
    const serverTime = new Date(dateHeader).getTime();
    if (!isNaN(serverTime)) {
      const localMidpoint = before + (after - before) / 2;
      clockDriftSec = Math.round((serverTime - localMidpoint) / 1000);
    }
  }

  const type = info.service_type === 1 || info.service_type === 'wireguard' ? 'wireguard' : 'v2ray';

  return {
    type,
    moniker: info.moniker || '',
    peers: info.peers || 0,
    maxPeers: null,
    bandwidth: {
      download: parseFloat(info.downlink) || 0,
      upload: parseFloat(info.uplink) || 0,
    },
    location: {
      city: info.location?.city || '',
      country: info.location?.country || '',
      country_code: info.location?.country_code || '',
      latitude: info.location?.latitude || 0,
      longitude: info.location?.longitude || 0,
    },
    qos: { max_peers: null },
    clockDriftSec,
    gigabyte_prices: [],
  };
}

// ─── Handshake — WireGuard (TKD SDK) ──────────────────────────────────────

/**
 * Perform WireGuard handshake via TKD SDK.
 * Follows exact pattern from official example:
 *   const wg = new Wireguard()
 *   const result = await handshake(sessionId, { public_key: wg.publicKey }, privkey, remoteAddr)
 *   const handshakeData = JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'))
 *   await wg.parseConfig(handshakeData, result.addrs)
 *
 * Returns same shape as Blue JS initHandshakeV3().
 */
export async function tkdHandshakeWG(remoteUrl, sessionId) {
  const url = remoteUrl.startsWith('http') ? remoteUrl : `https://${remoteUrl}`;
  const privKey = await getTkdPrivKey();

  const wg = new TkdWireguard();
  // constructor already calls genKeys() and sets publicKey/privateKey

  // handshake(sessionId, data_object, privateKey, remoteUrl)
  // data is a PLAIN OBJECT — handshake() does JSON.stringify internally
  // Use tkdHandshakeWithRetry for chain-lag retry, 409 handling, and error diagnostics.
  // Also wrap with 90s timeout — TKD's axios call has NO timeout by default.
  const handshakePromise = tkdHandshakeWithRetry(
    Long.fromString(String(sessionId)),
    { public_key: wg.publicKey },
    privKey,
    url,
  );
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TKD WG handshake timeout (90s) for ${url}`)), 90_000),
  );
  const result = await Promise.race([handshakePromise, timeoutPromise]);

  // result.data is base64 — decode then parse
  const handshakeData = JSON.parse(
    Buffer.from(result.data, 'base64').toString('utf8'),
  );

  // ─── Extract endpoint the SAME WAY as Blue JS (not TKD's parseConfig) ───
  // TKD's Wireguard.parseConfig() has a bug: it takes result.addrs[0] (which
  // is already "IP:PORT", e.g. "171.22.172.175:8585") and blindly appends
  // `:${metadata.port}`, producing an invalid double-port endpoint like
  // "171.22.172.175:8585:51820". This causes ETIMEDOUT on WireGuard connect.
  //
  // Blue JS correctly checks if the address already contains a port and only
  // appends metadata.port when it doesn't. We replicate that logic here.
  const metadata = (handshakeData.metadata || [])[0] || {};
  const serverPubKeyBase64 = metadata.public_key || '';
  const serverPort = parseInt(metadata.port, 10) || 51820;
  const assignedAddrs = handshakeData.addrs || [];

  // Node's WireGuard endpoint: use first entry of result.addrs
  // result.addrs contains the node's external addresses like ["IP:PORT", ...]
  const rawEndpoint = (result.addrs || [])[0] || '';
  const serverEndpoint = rawEndpoint.includes(':')
    ? rawEndpoint                          // already has port — use as-is
    : `${rawEndpoint}:${serverPort}`;      // bare IP — append metadata port

  return {
    assignedAddrs,
    serverPubKey: serverPubKeyBase64,
    serverEndpoint,
    serverEndpoints: result.addrs || [],
    clientPrivateKey: wg.privateKey || null,
  };
}

// ─── Handshake — V2Ray (TKD SDK) ──────────────────────────────────────────

/**
 * Perform V2Ray handshake via TKD SDK.
 * Uses TKD's signed handshake protocol, but returns output in the EXACT same
 * format as Blue JS's initHandshakeV3V2Ray():
 *   { config: rawJsonString, uuid: uuidString, serverEndpoints: string[] }
 *
 * config is the RAW base64-decoded JSON string from the node — NOT re-serialized.
 * This matches what buildV2RayClientConfig() expects.
 *
 * Key differences from old implementation:
 *   - Returns raw decoded string (not parse+re-serialize — avoids subtle JSON diffs)
 *   - Includes serverEndpoints from result.addrs (not empty array)
 *   - Wraps with timeout matching Blue JS (90s)
 *   - Skips v2.parseConfig() — we use Blue JS's buildV2RayClientConfig, not TKD's
 */
export async function tkdHandshakeV2Ray(remoteUrl, sessionId) {
  const url = remoteUrl.startsWith('http') ? remoteUrl : `https://${remoteUrl}`;
  const privKey = await getTkdPrivKey();

  // Generate UUID the same way TKD does — randomUUID() string + byte array
  const v2 = new TkdV2Ray();
  const uuidBytes = v2.getKey(); // returns number[] (byte array)

  // Use tkdHandshakeWithRetry for chain-lag retry, 409 handling, and error diagnostics.
  // Also wrap with 90s timeout — TKD's axios call has NO timeout by default.
  const handshakePromise = tkdHandshakeWithRetry(
    Long.fromString(String(sessionId)),
    { uuid: uuidBytes },
    privKey,
    url,
  );
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`TKD V2Ray handshake timeout (90s) for ${url}`)), 90_000),
  );
  const result = await Promise.race([handshakePromise, timeoutPromise]);

  // result.data is base64-encoded V2Ray config JSON from the node.
  // Return the RAW decoded string — exactly like Blue JS initHandshakeV3V2Ray().
  // Do NOT parse and re-serialize: that loses field ordering and can strip extra
  // fields the node returns. buildV2RayClientConfig does its own JSON.parse.
  const config = Buffer.from(result.data, 'base64').toString('utf8');

  return {
    config,
    uuid: v2.uuid,
    serverEndpoints: result.addrs || [],
  };
}

// ─── Session Start (TKD SDK) ──────────────────────────────────────────────

export async function tkdStartSession(mnemonic, nodeAddress, gigabytes, maxPrice) {
  const client = await getTkdSigningClient(mnemonic);
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();

  const args = {
    from: account.address,
    nodeAddress,
    gigabytes: Long.fromNumber(gigabytes),
    maxPrice,
  };

  const msg = nodeStartSession(args);
  const txResult = await client.signAndBroadcast(account.address, [msg], 'auto', 'sentinel-js-sdk');
  assertIsDeliverTxSuccess(txResult);
  return txResult;
}

// ─── Node Queries (TKD SDK — via RPC) ─────────────────────────────────────

export async function tkdQueryNodes() {
  const client = await getQueryClient();
  const result = await client.sentinelQuery.node.nodes(
    1,
    { limit: BigInt(5000), offset: BigInt(0), countTotal: true, reverse: false, key: new Uint8Array() },
  );
  return (result.nodes || []).map(n => {
    const addrs = Array.isArray(n.remoteAddrs) ? n.remoteAddrs : [];
    // v3 chain returns remoteAddrs as array of "host:port" strings — normalize
    // to URL form so downstream code can use remoteUrl uniformly.
    const firstAddr = addrs[0] || '';
    const remoteUrl = firstAddr
      ? (firstAddr.startsWith('http') ? firstAddr : `http://${firstAddr}`)
      : '';
    return {
      address: n.address,
      remoteUrl,
      remoteAddrs: addrs,
      gigabyte_prices: (n.gigabytePrices || []).map(p => ({
        denom: p.denom,
        base_value: p.baseValue || '0',
        quote_value: p.quoteValue || p.amount || '0',
      })),
      hourly_prices: (n.hourlyPrices || []).map(p => ({
        denom: p.denom,
        base_value: p.baseValue || '0',
        quote_value: p.quoteValue || p.amount || '0',
      })),
      status: n.status ?? 1,
      planIds: [],
      _source: 'tkd-rpc',
    };
  });
}

export async function tkdQuerySessions(walletAddress) {
  const client = await getQueryClient();
  const result = await client.sentinelQuery.session.sessionsForAccount(
    walletAddress,
    { limit: BigInt(200), offset: BigInt(0), countTotal: false, reverse: false, key: new Uint8Array() },
  );
  return result.sessions || [];
}

// ─── SDK Info ──────────────────────────────────────────────────────────────

export const TKD_SDK_VERSION = '2.0.4';
export const TKD_SDK_LABEL = 'TKD JS (Official)';
