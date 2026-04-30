/**
 * On-chain node test report — encoder, decoder, broadcaster, querier.
 *
 * Purpose: commit the tester's per-node results to the Sentinel chain in compact
 * binary form so any consumer can ingest performance + concurrency data via
 * RPC tx_search. The tester wallet self-sends 1udvpn with the encoded payload
 * stuffed into the TX memo; consumers filter by sender + magic prefix.
 *
 * Wire format (all big-endian):
 *
 *   magic         5  ASCII "SNTR1"
 *   version       1  uint8 (currently 1)
 *   region        2  ASCII ISO-3166 country code (e.g. "US"); "  " if unknown
 *   baselineMbps  2  uint16 (0–65535 Mbps, of the tester's own connection)
 *   startedAt     4  uint32 unix seconds
 *   count         1  uint8 (1–50, records that follow)
 *   records       count × 28
 *
 * Per-record (28 bytes):
 *   addr          20 raw bech32 hash (sent1<addr> → fromBech32 data)
 *   flags          1 bit0 = ok (could connect & speed-test); reserved bits high
 *   mbpsTimes10    2 uint16 — actual measured Mbps × 10 (one decimal)
 *   peers          2 uint16 — concurrent users on the node at test time
 *   latencyMs      2 uint16 — handshake/probe latency in ms (0 if not measured)
 *   errCode        1 uint8 — see ERR_CODES
 *
 * Sentinel's chain enforces a 256-character TX memo limit (chain rejects with
 * code 12 "memo too large" otherwise). Base64 expands 3→4, so max raw payload
 * = floor(256/4)*3 = 192 bytes. Header (15) + 6 records (168) = 183 raw → 244
 * base64 chars. 7 records would be 211 raw → 284 base64 (over). Hence
 * MAX_RECORDS = 6.
 */

import { fromBech32, toBech32, toBase64, fromBase64 } from '@cosmjs/encoding';
import { decodeTxRaw } from '@cosmjs/proto-signing';
import { signAndBroadcastRetry } from './wallet.js';
import { getRpcClient, cleanupRpc, withFreshRpc } from './chain.js';

const MAGIC = 'SNTR1';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const VERSION = 1;
const HEADER_LEN = 15;
const RECORD_LEN = 28;
const MAX_RECORDS = 6;
const MEMO_CHAR_LIMIT = 256;
const MIN_RECORDS = 1;

export const ERR_CODES = Object.freeze({
  OK: 0,
  TIMEOUT: 1,
  TUNNEL_FAIL: 2,
  HANDSHAKE: 3,
  AUTH: 4,
  PAYMENT: 5,
  NO_ROUTE: 6,
  RPC_ERROR: 7,
  STATUS_DEAD: 8,
  OTHER: 255,
});

export const DEFAULT_HRP = 'sent';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveErrCode(result) {
  if (result.actualMbps != null) return ERR_CODES.OK;
  const code = String(result.errorCode || '').toUpperCase();
  const msg = String(result.error || '').toLowerCase();
  if (code === 'TIMEOUT' || /timeout|timed out/.test(msg)) return ERR_CODES.TIMEOUT;
  if (/handshake|address mismatch|409/.test(msg)) return ERR_CODES.HANDSHAKE;
  if (/tunnel|wireguard|wg-quick|v2ray|socks/.test(msg)) return ERR_CODES.TUNNEL_FAIL;
  if (/auth|forbidden|401|403/.test(msg)) return ERR_CODES.AUTH;
  if (/insufficient|payment|udvpn|pricing/.test(msg)) return ERR_CODES.PAYMENT;
  if (/no route|unreachable|connection refused|ehostunreach/.test(msg)) return ERR_CODES.NO_ROUTE;
  if (/rpc|broadcast|tx failed|sequence/.test(msg)) return ERR_CODES.RPC_ERROR;
  if (/inactive|status code 5\d\d|service dead|not listening/.test(msg)) return ERR_CODES.STATUS_DEAD;
  return ERR_CODES.OTHER;
}

function clampU16(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 0xffff) return 0xffff;
  return Math.round(n);
}

function clampU32(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 0xffffffff) return 0xffffffff;
  return Math.floor(n);
}

function regionToBytes(region) {
  const out = new Uint8Array(2);
  out[0] = 0x20; out[1] = 0x20; // default: ASCII space
  if (typeof region === 'string' && region.length >= 2) {
    out[0] = region.charCodeAt(0) & 0x7f;
    out[1] = region.charCodeAt(1) & 0x7f;
  }
  return out;
}

/**
 * Convert a per-node test result row (from upsertResult) → 28-byte record.
 * Returns null if the address is malformed (not bech32-decodable).
 */
export function resultToRecord(result) {
  let addrBytes;
  try {
    const decoded = fromBech32(result.address);
    if (decoded.data.length !== 20) return null;
    addrBytes = decoded.data;
  } catch {
    return null;
  }
  const buf = new Uint8Array(RECORD_LEN);
  buf.set(addrBytes, 0);
  const ok = result.actualMbps != null;
  buf[20] = ok ? 0x01 : 0x00;
  const mbps = ok ? clampU16(result.actualMbps * 10) : 0;
  buf[21] = (mbps >>> 8) & 0xff;
  buf[22] = mbps & 0xff;
  const peers = clampU16(result.peers);
  buf[23] = (peers >>> 8) & 0xff;
  buf[24] = peers & 0xff;
  const latency = clampU16(result.diag?.handshakeLatencyMs ?? result.googleLatencyMs);
  buf[25] = (latency >>> 8) & 0xff;
  buf[26] = latency & 0xff;
  buf[27] = deriveErrCode(result) & 0xff;
  return buf;
}

/**
 * Encode a batch of records + header into a single binary blob.
 * @param {object} ctx { region: string|null, baselineMbps: number|null, startedAt?: Date|number }
 * @param {Uint8Array[]} records (each 28 bytes — already produced by resultToRecord)
 */
export function encodeBatch(ctx, records) {
  if (!Array.isArray(records) || records.length < MIN_RECORDS) {
    throw new Error(`encodeBatch: need at least ${MIN_RECORDS} record`);
  }
  if (records.length > MAX_RECORDS) {
    throw new Error(`encodeBatch: max ${MAX_RECORDS} records per batch (got ${records.length})`);
  }
  const total = HEADER_LEN + records.length * RECORD_LEN;
  const out = new Uint8Array(total);
  out.set(MAGIC_BYTES, 0);
  out[5] = VERSION;
  out.set(regionToBytes(ctx.region), 6);
  const baseline = clampU16(ctx.baselineMbps);
  out[8] = (baseline >>> 8) & 0xff;
  out[9] = baseline & 0xff;
  const startedAtSec = clampU32(
    ctx.startedAt instanceof Date ? Math.floor(ctx.startedAt.getTime() / 1000)
    : typeof ctx.startedAt === 'number' ? Math.floor(ctx.startedAt / 1000)
    : Math.floor(Date.now() / 1000),
  );
  out[10] = (startedAtSec >>> 24) & 0xff;
  out[11] = (startedAtSec >>> 16) & 0xff;
  out[12] = (startedAtSec >>> 8) & 0xff;
  out[13] = startedAtSec & 0xff;
  out[14] = records.length & 0xff;
  let offset = HEADER_LEN;
  for (const rec of records) {
    if (!(rec instanceof Uint8Array) || rec.length !== RECORD_LEN) {
      throw new Error(`encodeBatch: each record must be a ${RECORD_LEN}-byte Uint8Array`);
    }
    out.set(rec, offset);
    offset += RECORD_LEN;
  }
  return out;
}

/**
 * Decode a base64-encoded memo back to { region, baselineMbps, startedAt, records[] }.
 * Returns null if the memo is not one of ours (missing/invalid magic).
 */
export function decodeMemo(memoBase64, hrp = DEFAULT_HRP) {
  if (typeof memoBase64 !== 'string' || memoBase64.length === 0) return null;
  let bytes;
  try { bytes = fromBase64(memoBase64); }
  catch { return null; }
  return decodeBytes(bytes, hrp);
}

export function decodeBytes(bytes, hrp = DEFAULT_HRP) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LEN) return null;
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) return null;
  }
  const version = bytes[5];
  if (version !== VERSION) return null;
  const region = String.fromCharCode(bytes[6], bytes[7]).trim() || null;
  const baselineMbps = (bytes[8] << 8) | bytes[9];
  const startedAt = ((bytes[10] << 24) | (bytes[11] << 16) | (bytes[12] << 8) | bytes[13]) >>> 0;
  const count = bytes[14];
  const expectedLen = HEADER_LEN + count * RECORD_LEN;
  if (bytes.length < expectedLen) return null;
  const records = [];
  for (let i = 0; i < count; i++) {
    const off = HEADER_LEN + i * RECORD_LEN;
    const addrBytes = bytes.slice(off, off + 20);
    const flags = bytes[off + 20];
    const mbps = ((bytes[off + 21] << 8) | bytes[off + 22]) / 10;
    const peers = (bytes[off + 23] << 8) | bytes[off + 24];
    const latencyMs = (bytes[off + 25] << 8) | bytes[off + 26];
    const errCode = bytes[off + 27];
    records.push({
      address: toBech32(hrp, addrBytes),
      ok: (flags & 0x01) === 0x01,
      mbps: (flags & 0x01) ? mbps : null,
      peers,
      latencyMs: latencyMs || null,
      errCode,
    });
  }
  return {
    version,
    region,
    baselineMbps,
    startedAt,
    startedAtIso: new Date(startedAt * 1000).toISOString(),
    count,
    records,
  };
}

// ─── Broadcaster ─────────────────────────────────────────────────────────────

/**
 * Self-send 1udvpn with the encoded batch in the memo.
 * Returns { txhash, height, memoBytes }. Throws on unrecoverable failure.
 *
 * @param {SigningStargateClient} client
 * @param {string} signerAddress
 * @param {Uint8Array} encodedBatch (output of encodeBatch)
 * @param {(type:string,data:any)=>void} broadcast (logger)
 */
export async function commitBatch(client, signerAddress, encodedBatch, broadcast) {
  const memo = toBase64(encodedBatch);
  if (memo.length > MEMO_CHAR_LIMIT) {
    throw new Error(`Encoded memo ${memo.length} chars exceeds Sentinel chain limit ${MEMO_CHAR_LIMIT}; reduce MAX_RECORDS`);
  }
  const sendMsg = {
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: {
      fromAddress: signerAddress,
      toAddress: signerAddress,
      amount: [{ denom: 'udvpn', amount: '1' }],
    },
  };
  const fee = { amount: [{ denom: 'udvpn', amount: '200000' }], gas: '200000' };
  const result = await signAndBroadcastRetry(client, signerAddress, [sendMsg], fee, broadcast, 2, { memo });
  if (result.code !== 0) {
    throw new Error(`On-chain report TX failed code=${result.code}: ${result.rawLog}`);
  }
  return {
    txhash: result.transactionHash,
    height: result.height,
    memoBytes: encodedBatch.length,
    base64Bytes: memo.length,
  };
}

// ─── Querier (RPC tx_search) ─────────────────────────────────────────────────

/**
 * Query past on-chain reports posted by a given tester wallet.
 * Returns an array of { txhash, height, time, payload } where payload is the
 * decoded batch (see decodeMemo).
 *
 * Filters are applied chain-side via tx_search:
 *   message.sender='<wallet>' AND tx.height>=fromHeight
 *
 * @param {string} senderAddress
 * @param {object} opts { fromHeight?: number, limit?: number }
 */
export async function queryReports(senderAddress, opts = {}) {
  const { fromHeight = 0, limit = 50 } = opts;
  // Filter to self-sends only — every report is a MsgSend from wallet→wallet
  // with the SNTR1 memo. message.sender alone returns every TX the wallet ever
  // signed (subscriptions, payments, etc.) which is huge for active wallets
  // and makes tx_search time out. transfer.recipient narrows to self-sends.
  const queryParts = [
    `message.sender='${senderAddress}'`,
    `transfer.recipient='${senderAddress}'`,
  ];
  if (fromHeight > 0) queryParts.push(`tx.height>=${fromHeight}`);
  const query = queryParts.join(' AND ');
  // Single-page txSearch — txSearchAll walks every match (slow / times out for
  // wallets with many TXs). The UI only needs the most recent `limit` rows.
  const perPage = Math.min(Math.max(limit, 1), 100);
  const res = await withFreshRpc(async (rpc) => {
    if (!rpc?.tmClient) throw new Error('RPC tmClient unavailable');
    return rpc.tmClient.txSearch({ query, page: 1, per_page: perPage, order_by: 'desc' });
  }, 'queryReports', { timeoutMs: 20000 });
  const out = [];
  for (const tx of res.txs || []) {
    const memo = extractMemo(tx);
    if (!memo) continue;
    const payload = decodeMemo(memo);
    if (!payload) continue;
    out.push({
      txhash: tx.hash ? Buffer.from(tx.hash).toString('hex').toUpperCase() : null,
      height: tx.height,
      payload,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function extractMemo(tx) {
  try {
    const decoded = decodeTxRaw(tx.tx);
    return decoded?.body?.memo || null;
  } catch (e) {
    console.warn('[onchain-report] decodeTxRaw failed:', e.message);
    return null;
  }
}

// ─── Constants exported for tests / introspection ────────────────────────────
export const SCHEMA = Object.freeze({
  MAGIC, VERSION, HEADER_LEN, RECORD_LEN, MAX_RECORDS, MIN_RECORDS,
});
