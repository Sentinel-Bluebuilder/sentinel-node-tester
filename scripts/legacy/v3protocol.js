/**
 * Sentinel v3 Node Protocol
 *
 * The chain upgrade changed all node REST API endpoints.
 * v2: GET /status, POST /accounts/{addr}/sessions/{id}
 * v3: GET /       (info), POST / (handshake)
 *
 * The handshake request body is completely different in v3:
 * - data:      base64(JSON.stringify({public_key: "<base64_wg_pubkey>"}))
 * - id:        session ID (uint64 number)
 * - pub_key:   "secp256k1:<base64_cosmos_pubkey>"
 * - signature: base64(secp256k1_sign(SHA256(BigEndian8(id) + data_bytes)))
 *
 * Sources verified from:
 *   github.com/sentinel-official/dvpn-node development branch (Dec 2025, v8.3.1)
 *   github.com/sentinel-official/sentinel-go-sdk main branch
 */

import https from 'https';
import net from 'net';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { Secp256k1, sha256 } from '@cosmjs/crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { secp256k1 as nobleSecp } from '@noble/curves/secp256k1.js';
import path from 'path';
import os from 'os';
import { mkdirSync, writeFileSync } from 'fs';
import { execSync, execFileSync } from 'child_process';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Force axios to use the Node.js http adapter, NOT the fetch adapter.
// Undici throws opaque "fetch failed" errors with no errno/context.
axios.defaults.adapter = 'http';

// ─── Node Status (v3: GET /) ──────────────────────────────────────────────────

/**
 * Fetch node info from v3 node API.
 * Returns a normalised object compatible with the rest of the codebase.
 */
export async function nodeStatusV3(remoteUrl, agent) {
  const url = remoteUrl.replace(/\/+$/, '');
  const before = Date.now();
  const res = await axios.get(url + '/', { httpsAgent: agent || httpsAgent, timeout: 12_000 });
  const after = Date.now();
  const r = res.data?.result;
  if (!r) throw new Error('No result in node status response');

  // Detect server clock drift from the HTTP Date header.
  // VMess AEAD auth fails if |client_time - server_time| > 120 seconds.
  let clockDriftSec = null;
  const dateHeader = res.headers?.['date'];
  if (dateHeader) {
    const serverTime = new Date(dateHeader).getTime();
    if (!isNaN(serverTime)) {
      const localMidpoint = before + (after - before) / 2;
      clockDriftSec = Math.round((serverTime - localMidpoint) / 1000);
    }
  }

  // Normalise to match the shape the rest of server.js expects
  return {
    type: r.service_type === 'wireguard' ? 'wireguard' : 'v2ray',
    moniker: r.moniker || '',
    peers: r.peers || 0,
    bandwidth: {
      // downlink/uplink are bytes/s (string in v3)
      download: parseInt(r.downlink || '0', 10),
      upload: parseInt(r.uplink || '0', 10),
    },
    location: {
      city: r.location?.city || '',
      country: r.location?.country || '',
      country_code: r.location?.country_code || '',
      latitude: r.location?.latitude || 0,
      longitude: r.location?.longitude || 0,
    },
    qos: { max_peers: r.qos?.max_peers || null },
    clockDriftSec,
    gigabyte_prices: [],  // not in v3 status; fetched from LCD
    _raw: r,
  };
}

// ─── WireGuard Key Generation ─────────────────────────────────────────────────

/**
 * Generate a WireGuard-compatible Curve25519 key pair.
 * Returns { privateKey: Buffer(32), publicKey: Buffer(32) }
 */
export function generateWgKeyPair() {
  // Generate private key with WireGuard bit clamping
  const priv = Buffer.from(randomBytes(32));
  priv[0] &= 248;  // clear bottom 3 bits
  priv[31] &= 127;  // clear top bit
  priv[31] |= 64;   // set second-highest bit

  // Derive public key via X25519 (Curve25519 scalar base mult)
  const pub = Buffer.from(x25519.getPublicKey(priv));

  return { privateKey: priv, publicKey: pub };
}

// ─── v3 Handshake (POST /) ───────────────────────────────────────────────────

/**
 * Perform v3 node handshake.
 * @param {string}     remoteUrl     - Node's HTTPS base URL
 * @param {bigint}     sessionId     - Session ID (uint64)
 * @param {Buffer}     cosmosPrivKey - Raw secp256k1 private key bytes (32 bytes)
 * @param {Buffer}     wgPublicKey   - WireGuard public key (32 bytes)
 * @returns {{ assignedAddrs: string[], serverPubKey: string, serverEndpoints: string[] }}
 */
export async function initHandshakeV3(remoteUrl, sessionId, cosmosPrivKey, wgPublicKey, agent) {
  // 1. Build peer request data
  const peerRequest = { public_key: wgPublicKey.toString('base64') };
  const dataBytes = Buffer.from(JSON.stringify(peerRequest));

  // 2. Build message: BigEndian uint64 (8 bytes) ++ data
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64BE(BigInt(sessionId));
  const msg = Buffer.concat([idBuf, dataBytes]);

  // 3. Sign: SHA256(msg) → secp256k1 compact 64-byte sig (r+s, no recovery byte) → base64
  // IMPORTANT: Go's VerifySignature requires EXACTLY 64 bytes (len != 64 → false)
  const msgHash = sha256(msg);
  const sig = await Secp256k1.createSignature(msgHash, cosmosPrivKey);
  // toFixedLength() returns 65 bytes (r+s+recovery) — take only first 64 (r+s)
  const sigBytes = Buffer.from(sig.toFixedLength()).slice(0, 64);
  const signature = sigBytes.toString('base64');

  // 4. Encode Cosmos public key (compressed, 33 bytes): "secp256k1:<base64>"
  const compressedPubKey = nobleSecp.getPublicKey(cosmosPrivKey, true);  // true = compressed
  const pubKeyEncoded = 'secp256k1:' + Buffer.from(compressedPubKey).toString('base64');

  // 5. POST / with JSON body (Go []byte fields are base64 in JSON)
  const idNum = Number(sessionId);
  if (!Number.isSafeInteger(idNum)) throw new Error(`Session ID ${sessionId} exceeds safe integer range (max ${Number.MAX_SAFE_INTEGER})`);
  const body = {
    data: dataBytes.toString('base64'),
    id: idNum,
    pub_key: pubKeyEncoded,
    signature: signature,
  };

  const url = remoteUrl.replace(/\/+$/, '') + '/';
  let res;
  try {
    res = await axios.post(url, body, {
      httpsAgent: agent || httpsAgent,
      timeout: 45_000,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const errData = err.response?.data;
    const code = err.code || '';  // ECONNREFUSED, ETIMEDOUT, ENOTFOUND, etc.
    const status = err.response?.status;
    const detail = errData ? JSON.stringify(errData) : err.message;
    throw new Error(`Node handshake failed (HTTP ${status}${code ? ', ' + code : ''}): ${detail}`);
  }

  const result = res.data?.result;
  if (!result) {
    const errInfo = res.data?.error;
    throw new Error(`Node handshake error: ${JSON.stringify(errInfo || res.data)}`);
  }

  // 6. Parse AddPeerResponse from result.data (base64-encoded JSON bytes)
  const addPeerData = Buffer.from(result.data, 'base64').toString('utf8');
  const addPeerResp = JSON.parse(addPeerData);

  // result.addrs = node's WireGuard listening addresses (["IP:PORT", ...])
  // addPeerResp.addrs = our assigned IPs (["10.x.x.x/24", ...])
  // addPeerResp.metadata = [{port, public_key}, ...]

  const metadata = (addPeerResp.metadata || [])[0] || {};
  const serverPubKeyBase64 = metadata.public_key || '';
  const serverPort = parseInt(metadata.port, 10) || 51820;

  // Validate handshake response — garbage data from node → clear error instead of opaque WG failure
  if (!serverPubKeyBase64) throw new Error('Handshake failed: node returned empty WireGuard public key');
  if (serverPort < 1 || serverPort > 65535) throw new Error(`Handshake failed: invalid port ${serverPort} from node`);

  const assignedAddrs = addPeerResp.addrs || [];
  if (assignedAddrs.length === 0) throw new Error('Handshake failed: node returned no assigned addresses');

  // Node's WireGuard endpoint: use first entry of result.addrs
  // If it doesn't include a port, append the metadata port
  const rawEndpoint = (result.addrs || [])[0] || '';
  if (!rawEndpoint) throw new Error('Handshake failed: node returned no WireGuard endpoint addresses');
  const serverEndpoint = rawEndpoint.includes(':')
    ? rawEndpoint
    : `${rawEndpoint}:${serverPort}`;

  return {
    assignedAddrs,                              // our IPs e.g. ["10.8.0.2/24"]
    serverPubKey: serverPubKeyBase64,         // server WG pub key (base64)
    serverEndpoint,                             // "IP:PORT" for WireGuard Endpoint
    serverEndpoints: result.addrs || [],
    rawAddPeerResp: addPeerResp,
  };
}

// ─── Build & Write WireGuard Config ──────────────────────────────────────────

/**
 * Write a WireGuard .conf file from v3 handshake result.
 * @param {Buffer}   wgPrivKey      - Our WireGuard private key (32 bytes)
 * @param {string[]} assignedAddrs  - Our assigned IPs from node (e.g. ["10.8.0.2/24"])
 * @param {string}   serverPubKey   - Server WireGuard public key (base64)
 * @param {string}   serverEndpoint - "IP:PORT" for the WireGuard server
 * @param {string[]} [splitIPs]     - If provided, only route these IPs through tunnel (split tunneling).
 *                                    Prevents internet death if tunnel cleanup fails.
 *                                    Pass null/empty for full tunnel (0.0.0.0/0) — NOT recommended for testing.
 * @returns {string} Path to the written .conf file
 */
export function writeWgConfig(wgPrivKey, assignedAddrs, serverPubKey, serverEndpoint, splitIPs = null) {
  // Use a SYSTEM-readable path on Windows. The WireGuard service runs as SYSTEM
  // and often can't read configs from user temp dirs (C:\Users\X\AppData\Local\Temp).
  // C:\ProgramData is readable by all accounts including SYSTEM.
  const tmpDir = process.platform === 'win32'
    ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'sentinel-wg')
    : path.join(os.tmpdir(), 'sentinel-wg');
  mkdirSync(tmpDir, { recursive: true });

  // Restrict directory ACL so only current user + SYSTEM can access (ProgramData is world-readable by default)
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [tmpDir, '/inheritance:r', '/grant:r', `${process.env.USERNAME || 'BUILTIN\\Users'}:F`, '/grant:r', 'SYSTEM:F'], { stdio: 'pipe', timeout: 5000 });
    } catch {} // non-fatal — WG still works, just less secure on multi-user systems
  }

  const confPath = path.join(tmpDir, 'wgsent0.conf');
  const privKeyBase64 = wgPrivKey.toString('base64');
  const address = assignedAddrs.join(', ');

  // Split tunneling: only route speedtest target IPs through tunnel.
  // Full tunnel (0.0.0.0/0) captures ALL traffic — if tunnel dies, internet dies.
  const useSplit = splitIPs && splitIPs.length > 0;
  const allowedIPsStr = useSplit
    ? splitIPs.map(ip => ip.includes('/') ? ip : `${ip}/32`).join(', ')
    : '0.0.0.0/0, ::/0';

  const lines = [
    '[Interface]',
    `PrivateKey = ${privKeyBase64}`,
    `Address = ${address}`,
    `MTU = 1420`,
  ];
  // Only set DNS for full tunnel; split tunnel uses system DNS (safer)
  if (!useSplit) lines.push(`DNS = 208.67.222.222, 208.67.220.220`);
  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${serverPubKey}`,
    `Endpoint = ${serverEndpoint}`,
    `AllowedIPs = ${allowedIPsStr}`,
    `PersistentKeepalive = 30`,
    '',
  );

  const conf = lines.join('\n');

  writeFileSync(confPath, conf, { encoding: 'utf8', mode: 0o600 }); // restrict: owner-only read/write
  // On Windows, also restrict ACL so only current user + SYSTEM can read (ProgramData is world-readable)
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [confPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME || 'BUILTIN\\Users'}:F`, '/grant:r', 'SYSTEM:F'], { stdio: 'pipe', timeout: 5000 });
    } catch {} // non-fatal — WG still works, just less secure on multi-user systems
  }
  return confPath;
}

// ─── V2Ray Handshake ──────────────────────────────────────────────────────────
// V2Ray peer request format: { "uuid": [byte_array] }
// We generate a UUID client-side and send it as an integer byte array.

import { randomUUID } from 'crypto';

// ─── Protobuf Encoder for v3 Messages ────────────────────────────────────────
// Manual encoding — avoids needing proto-generated code for v3 types.
// Field tag = (field_number << 3) | wire_type  (0=varint, 2=length-delimited)

export function encodeVarint(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

export function protoString(fieldNum, str) {
  if (!str) return Buffer.alloc(0);
  const b = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 2n), encodeVarint(b.length), b]);
}

export function protoInt64(fieldNum, n) {
  if (n === null || n === undefined) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 0n), encodeVarint(n)]);
}

export function protoEmbedded(fieldNum, msgBytes) {
  if (!msgBytes || msgBytes.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 2n), encodeVarint(msgBytes.length), msgBytes]);
}

/**
 * Convert sdk.Dec string to scaled big.Int string (multiply by 10^18).
 * "0.003000000000000000" → "3000000000000000"
 * "40152030"             → "40152030000000000000000000"  (only for sdk.Dec fields)
 */
function decToScaledInt(decStr) {
  const s = String(decStr).trim();
  const dotIdx = s.indexOf('.');
  if (dotIdx === -1) {
    // Integer — multiply by 10^18
    return s + '0'.repeat(18);
  }
  const intPart = s.slice(0, dotIdx);
  const fracPart = s.slice(dotIdx + 1);
  // Pad or trim fractional part to exactly 18 digits
  const frac18 = (fracPart + '0'.repeat(18)).slice(0, 18);
  const combined = (intPart === '' || intPart === '0' ? '' : intPart) + frac18;
  // Remove leading zeros (but keep at least one digit)
  const trimmed = combined.replace(/^0+/, '') || '0';
  return trimmed;
}

/**
 * Encode sentinel.types.v1.Price { denom, base_value, quote_value }
 * base_value is sdk.Dec → encode as scaled big.Int string
 * quote_value is sdk.Int → encode as integer string
 */
function encodePrice({ denom, base_value, quote_value }) {
  const baseValEncoded = decToScaledInt(String(base_value));
  return Buffer.concat([
    protoString(1, denom),
    protoString(2, baseValEncoded),
    protoString(3, String(quote_value)),
  ]);
}

/**
 * Encode sentinel.node.v3.MsgStartSessionRequest
 * Replaces old nodeSubscribe + sessionStart (now one tx).
 *
 * Fields:
 *   1: from         (string) — account address
 *   2: node_address (string) — node's sentnode1... address
 *   3: gigabytes    (int64)
 *   4: hours        (int64, 0 if using gigabytes)
 *   5: max_price    (Price, optional) — max price user will pay per GB
 */
export function encodeMsgStartSession({ from, node_address, gigabytes = 1, hours = 0, max_price }) {
  return Uint8Array.from(Buffer.concat([
    protoString(1, from),
    protoString(2, node_address),
    protoInt64(3, gigabytes),
    hours ? protoInt64(4, hours) : Buffer.alloc(0),
    max_price ? protoEmbedded(5, encodePrice(max_price)) : Buffer.alloc(0),
  ]));
}

/**
 * MsgStartSubscriptionRequest (sentinel.subscription.v3):
 *   1: from   (string)
 *   2: id     (uint64, plan ID)
 *   3: denom  (string, e.g. "udvpn")
 *   4: renewal_price_policy (enum/int64, optional)
 */
export function encodeMsgStartSubscription({ from, id, denom = 'udvpn', renewalPricePolicy = 0 }) {
  const parts = [
    protoString(1, from),
    protoInt64(2, id),
    protoString(3, denom),
  ];
  if (renewalPricePolicy) parts.push(protoInt64(4, renewalPricePolicy));
  return Uint8Array.from(Buffer.concat(parts));
}

/**
 * MsgStartSessionRequest (sentinel.subscription.v3) — start session via subscription:
 *   1: from            (string)
 *   2: id              (uint64, subscription ID)
 *   3: node_address    (string)
 */
export function encodeMsgSubStartSession({ from, id, nodeAddress }) {
  return Uint8Array.from(Buffer.concat([
    protoString(1, from),
    protoInt64(2, id),
    protoString(3, nodeAddress),
  ]));
}

/**
 * Extract session ID from MsgStartSession tx result.
 * Checks ABCI events for sentinel.node.v3.EventCreateSession.session_id
 */
export function extractSessionId(txResult) {
  // Try ABCI events first
  for (const event of (txResult.events || [])) {
    if (/session/i.test(event.type)) {
      for (const attr of event.attributes) {
        const k = typeof attr.key === 'string' ? attr.key
          : Buffer.from(attr.key, 'base64').toString('utf8');
        const v = typeof attr.value === 'string' ? attr.value
          : Buffer.from(attr.value, 'base64').toString('utf8');
        if (k === 'session_id' || k === 'SessionID' || k === 'id') {
          const id = BigInt(v.replace(/"/g, ''));
          if (id > 0n) return id;
        }
      }
    }
  }
  // Try rawLog
  try {
    const logs = JSON.parse(txResult.rawLog || '[]');
    for (const log of (Array.isArray(logs) ? logs : [])) {
      for (const ev of (log.events || [])) {
        for (const attr of (ev.attributes || [])) {
          if (attr.key === 'session_id' || attr.key === 'id') {
            const id = BigInt(String(attr.value).replace(/"/g, ''));
            if (id > 0n) return id;
          }
        }
      }
    }
  } catch { }
  return null;
}

export function generateV2RayUUID() {
  return randomUUID();
}

/**
 * Wait until a TCP port is accepting connections (SOCKS5 readiness probe).
 * V2Ray takes variable time to bind its SOCKS5 inbound — a fixed sleep is unreliable.
 * Returns true when ready, false if timeout.
 * @param {number} port - Port to probe (e.g. SOCKS5 port)
 * @param {number} timeoutMs - Max wait time (default: 10000)
 * @param {number} intervalMs - Probe interval (default: 500)
 */
export async function waitForPort(port, timeoutMs = 10000, host = '127.0.0.1', intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const sock = net.createConnection({ host, port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
      sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Build a complete V2Ray client JSON config from the node's handshake metadata.
 *
 * The node returns a metadata blob like:
 *   {"metadata":[{"port":"55215","proxy_protocol":2,"transport_protocol":3,"transport_security":1},...]}
 *
 * We must convert this into a proper V2Ray config with inbounds + outbounds.
 *
 * proxy_protocol:    1=VLess  2=VMess
 * transport_protocol:1=domainsocket 2=gun 3=grpc 4=http 5=mkcp 6=quic 7=tcp 8=websocket
 * transport_security:0=unspecified  1=none  2=TLS  (per sentinel-go-sdk transport.go iota)
 *
 * @param {string}  serverHost    - Hostname of the node (e.g. "us04.quinz.top")
 * @param {string}  metadataJson  - JSON string returned from handshake (hs.config)
 * @param {string}  uuid          - UUID/UID we generated for the session
 * @param {number}  socksPort     - Local SOCKS5 port to listen on (default 1080)
 * @returns {object}              - Complete V2Ray config object (call JSON.stringify to write)
 */
export function buildV2RayClientConfig(serverHost, metadataJson, uuid, socksPort = 1080) {
  const parsed = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
  const entries = parsed.metadata || [];

  if (entries.length === 0) throw new Error('No metadata entries in V2Ray handshake response');

  // Detect v2-format metadata: old nodes return {port, protocol, ca, tls} instead of
  // v3's {port, proxy_protocol, transport_protocol, transport_security}.
  // Instead of rejecting, map v2 fields → v3 equivalents so these nodes can be tested.
  const hasV2Format = entries.some(e => e.ca !== undefined || (e.protocol !== undefined && e.proxy_protocol === undefined));
  if (hasV2Format) {
    for (const e of entries) {
      if (e.proxy_protocol !== undefined) continue; // already v3 format
      // Map v2 "protocol" → v3 "proxy_protocol": v2 protocol 1=VMess→v3 2, v2 protocol 2=VLess→v3 1
      if (e.protocol !== undefined && e.proxy_protocol === undefined) {
        e.proxy_protocol = e.protocol === 2 ? 1 : 2;
      }
      if (e.transport_protocol === undefined) e.transport_protocol = 7; // default tcp
      if (e.transport_security === undefined) {
        e.transport_security = (e.tls === 1 || e.tls === true) ? 2 : 1;
      }
    }
  }

  // Filter unsupported transports:
  //   - domainsocket (unix sockets — can't work remotely/on Windows)
  //   - grpc/tls (0% success rate from 400+ tests — always fails silently)
  const supported = entries.filter(e => e.transport_protocol !== 1);
  if (supported.length === 0) throw new Error('No usable transport entries');

  // grpc/tls now supported (serverName added to tlsSettings) — keep all transports.
  // Only deprioritize grpc/tls in sort order (see transportSecondary below).
  const viable = supported;

  // Transport names — MUST match sentinel-go-sdk transport.go String() output exactly.
  // CRITICAL: "gun" and "grpc" are DIFFERENT in V2Ray 5.x (gun = raw H2, grpc = gRPC lib).
  const networkMap = { 2: 'gun', 3: 'grpc', 4: 'http', 5: 'mkcp', 6: 'quic', 7: 'tcp', 8: 'websocket' };

  // Build ALL outbounds from ALL metadata entries — matches official SDK template.
  // Sort by transport reliability so the first outbound (used by default routing) is most likely to work.
  // Observed success rates from 780-node test (2026-03-09):
  //   tcp=100%, websocket=100%, http=100%, gun=100%, grpc/none=87% (70/81), mkcp=100% (5/5)
  //   quic=0% (0/4 — no active nodes to retest), grpc/tls=0% (serverName fix applied, needs retest)
  const transportPriority = { 7: 0, 8: 1, 4: 2, 2: 3, 5: 4 }; // tcp, ws, http, gun, kcp
  const transportSecondary = (tp, ts) => {
    if (tp === 3 && ts !== 2) return 5;  // grpc/none (87%)
    if (tp === 3 && ts === 2) return 8;  // grpc/tls (serverName fix applied, unverified)
    if (tp === 6 && ts === 2) return 9;  // quic/tls (config fixed, no active nodes)
    if (tp === 6 && ts !== 2) return 10; // quic/none (config fixed, no active nodes)
    return 7;
  };
  const sorted = [...viable].sort((a, b) => {
    const pa = transportPriority[a.transport_protocol] ?? transportSecondary(a.transport_protocol, a.transport_security);
    const pb = transportPriority[b.transport_protocol] ?? transportSecondary(b.transport_protocol, b.transport_security);
    return pa - pb;
  });

  const outbounds = sorted.filter(entry => {
    const p = parseInt(entry.port, 10);
    if (!p || p < 1 || p > 65535) return false; // skip entries with invalid/missing port
    return true;
  }).map(entry => {
    const port = parseInt(entry.port, 10);
    const protocol = entry.proxy_protocol === 1 ? 'vless' : 'vmess';
    const network = networkMap[entry.transport_protocol] || 'tcp';
    const security = entry.transport_security === 2 ? 'tls' : 'none';
    const tag = `${serverHost}_${port}_${protocol}_${network}_${security}`;

    // Match SDK template exactly: only network + security + optional tlsSettings
    const streamSettings = { network, security };
    if (security === 'tls') {
      // serverName required for grpc/tls — V2Ray gRPC lib needs SNI for TLS handshake.
      // Without it, TLS uses raw IP which fails cert validation even with allowInsecure.
      streamSettings.tlsSettings = { allowInsecure: true, serverName: serverHost };
    }
    // grpc and gun are the same transport — need explicit grpcSettings.
    // Empty serviceName uses V2Ray's default path (matches sentinel-go-sdk server config).
    if (network === 'grpc' || network === 'gun') {
      streamSettings.grpcSettings = { serviceName: '' };
    }
    // QUIC needs per-outbound quicSettings to override the global transport section.
    // Sentinel Go SDK server uses 'none' for QUIC header encryption — must match exactly.
    if (network === 'quic') {
      streamSettings.quicSettings = { security: 'none', key: '', header: { type: 'none' } };
    }

    let settings;
    if (protocol === 'vmess') {
      settings = { vnext: [{ address: serverHost, port, users: [{ id: uuid, alterId: 0 }] }] };
    } else {
      settings = { vnext: [{ address: serverHost, port, users: [{ id: uuid, encryption: 'none' }] }] };
    }

    return { tag, protocol, settings, streamSettings };
  });

  // Match the official sentinel-go-sdk client.json.tmpl structure exactly:
  //   - API inbound (dokodemo-door) for StatsService
  //   - SOCKS inbound with sniffing
  //   - ALL metadata entries as separate outbounds
  //   - Routing: API → api tag, proxy → first outbound (most reliable transport)
  //   - NEVER use balancer/observatory — causes session poisoning (see known-issues.md)
  //   - Policy with uplinkOnly/downlinkOnly = 0
  //   - Global transport section with QUIC security:'none' (chacha20 mismatch fixed in v22)
  // Random API port — avoids Windows TIME_WAIT collisions when v2ray is killed and respawned.
  // Port 2080 (fixed) caused cascading bind failures across sequential node tests.
  const apiPort = 10000 + Math.floor(Math.random() * 50000);

  return {
    api: {
      services: ['StatsService'],
      tag: 'api',
    },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: apiPort,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
        tag: 'api',
      },
      {
        listen: '127.0.0.1',
        port: socksPort,
        protocol: 'socks',
        settings: { ip: '127.0.0.1', udp: true },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
        tag: 'proxy',
      },
    ],
    log: { loglevel: 'info' },
    outbounds,
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { inboundTag: ['api'], outboundTag: 'api', type: 'field' },
        { inboundTag: ['proxy'], outboundTag: outbounds[0].tag, type: 'field' },
      ],
    },
    policy: {
      levels: { '0': { downlinkOnly: 0, uplinkOnly: 0 } },
      system: { statsOutboundDownlink: true, statsOutboundUplink: true },
    },
    stats: {},
    transport: {
      dsSettings: {},
      grpcSettings: {},
      gunSettings: {},
      httpSettings: {},
      kcpSettings: {},
      quicSettings: { security: 'none', key: '', header: { type: 'none' } },
      tcpSettings: {},
      wsSettings: {},
    },
  };
}

/**
 * Perform v3 V2Ray handshake.
 * Returns the V2Ray client config (JSON string in result.data).
 */
export async function initHandshakeV3V2Ray(remoteUrl, sessionId, cosmosPrivKey, uuid, agent) {
  const hex = uuid.replace(/-/g, '');
  const uuidBytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    uuidBytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  const peerRequest = { uuid: uuidBytes };
  const dataBytes = Buffer.from(JSON.stringify(peerRequest));

  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64BE(BigInt(sessionId));
  const msg = Buffer.concat([idBuf, dataBytes]);

  const msgHash = sha256(msg);
  const sig = await Secp256k1.createSignature(msgHash, cosmosPrivKey);
  const sigBytes = Buffer.from(sig.toFixedLength()).slice(0, 64);  // 64 bytes only (r+s)
  const signature = sigBytes.toString('base64');
  const compressedPubKey = nobleSecp.getPublicKey(cosmosPrivKey, true);
  const pubKeyEncoded = 'secp256k1:' + Buffer.from(compressedPubKey).toString('base64');

  const v2IdNum = Number(sessionId);
  if (!Number.isSafeInteger(v2IdNum)) throw new Error(`Session ID ${sessionId} exceeds safe integer range (max ${Number.MAX_SAFE_INTEGER})`);
  const body = {
    data: dataBytes.toString('base64'),
    id: v2IdNum,
    pub_key: pubKeyEncoded,
    signature: signature,
  };

  const url = remoteUrl.replace(/\/+$/, '') + '/';
  let res;
  try {
    res = await axios.post(url, body, {
      httpsAgent: agent || httpsAgent,
      timeout: 45_000,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const errData = err.response?.data;
    const code = err.code || '';
    const status = err.response?.status;
    const detail = errData ? JSON.stringify(errData) : err.message;
    throw new Error(`V2Ray handshake failed (HTTP ${status}${code ? ', ' + code : ''}): ${detail}`);
  }

  const result = res.data?.result;
  if (!result) {
    throw new Error(`V2Ray handshake error: ${JSON.stringify(res.data?.error || res.data)}`);
  }

  // result.data is base64-encoded V2Ray client config JSON
  const v2rayConfig = Buffer.from(result.data, 'base64').toString('utf8');

  return {
    config: v2rayConfig,
    serverEndpoints: result.addrs || [],
  };
}
