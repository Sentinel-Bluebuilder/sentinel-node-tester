/**
 * On-chain node test report — encoder, decoder, broadcaster, querier.
 *
 * Purpose: commit the tester's per-node results to the Sentinel chain in a
 * compact human-readable form so any consumer can ingest performance +
 * concurrency data via RPC tx_search WITHOUT a binary decoder. The tester
 * wallet self-sends 1udvpn with the encoded payload stuffed into the TX memo;
 * consumers filter by sender + magic prefix.
 *
 * Wire format (v2 — CSV, plain ASCII, since 2026-04-30):
 *
 *   Line 1 (header):
 *     SNTR1|v2|<region>|b=<baselineMbps>|t=<unixSeconds>
 *       region          2-char ISO country (e.g. "US"); "--" if unknown
 *       baselineMbps    tester's own measured Mbps, one decimal
 *       unixSeconds     run start time
 *
 *   Lines 2..N (one per node):
 *     <addr>|<ok>|<mbps>|<peers>|<lat>
 *       addr            full bech32 (`sent1…`)
 *       ok              1 = working node, 0 = failed
 *       mbps            measured Mbps (one decimal); empty if ok=0
 *       peers           concurrent users on the node at test time
 *       lat             handshake latency in ms; empty if not measured
 *
 *   Lines are joined by '\n'. Total memo MUST be ≤ MEMO_CHAR_LIMIT (256 chars,
 *   the Sentinel chain's hard cap). The packer (`packBatch`) greedily fits
 *   records until adding one more would overflow; `MAX_RECORDS` (6) is the
 *   upper bound on records considered per batch.
 *
 * v1 (legacy binary, base64) is still decoded by `decodeMemo` so historical
 * TXs continue to render in the history popup.
 */

import { fromBase64, toBase64, toBech32 } from '@cosmjs/encoding';
import { decodeTxRaw } from '@cosmjs/proto-signing';
import { signAndBroadcastRetry } from './wallet.js';
import { withFreshRpc } from './chain.js';

const MAGIC = 'SNTR1';
const VERSION = 2;
const MAX_RECORDS = 6;
const MIN_RECORDS = 1;
const MEMO_CHAR_LIMIT = 256;
const SEP = '|';
const NL = '\n';

export const ERR_CODES = Object.freeze({
  OK: 0, TIMEOUT: 1, TUNNEL_FAIL: 2, HANDSHAKE: 3, AUTH: 4,
  PAYMENT: 5, NO_ROUTE: 6, RPC_ERROR: 7, STATUS_DEAD: 8, OTHER: 255,
});

export const DEFAULT_HRP = 'sent';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampU16(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 0xffff) return 0xffff;
  return Math.round(n);
}

function fmtMbps(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  return (Math.round(n * 10) / 10).toFixed(1);
}

function fmtRegion(region) {
  if (typeof region !== 'string' || region.length < 2) return '--';
  const r = region.slice(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(r)) return '--';
  return r;
}

/**
 * Convert a per-node test result row → record object.
 * Returns null if the address looks malformed.
 */
export function resultToRecord(result) {
  const addr = result?.address;
  // Sentinel nodes use the `sentnode1…` bech32 HRP (NOT `sent1…` like wallets).
  // The early prefix check used `sent1` which silently filtered every record.
  if (typeof addr !== 'string' || !addr.startsWith('sentnode1') || addr.length < 30) return null;
  const ok = result.actualMbps != null;
  return {
    address: addr,
    ok: ok ? 1 : 0,
    mbps: ok ? Number(result.actualMbps) : null,
    peers: clampU16(result.peers),
    lat: clampU16(result.diag?.handshakeLatencyMs ?? result.diag?.googleLatencyMs ?? result.googleLatencyMs ?? 0),
  };
}

function buildHeader(ctx) {
  const region = fmtRegion(ctx.region);
  const baseline = fmtMbps(Number(ctx.baselineMbps) || 0);
  const startedAtSec = ctx.startedAt instanceof Date
    ? Math.floor(ctx.startedAt.getTime() / 1000)
    : typeof ctx.startedAt === 'number'
      ? Math.floor(ctx.startedAt / 1000)
      : Math.floor(Date.now() / 1000);
  return `${MAGIC}${SEP}v${VERSION}${SEP}${region}${SEP}b=${baseline}${SEP}t=${startedAtSec}`;
}

function buildRecordLine(rec) {
  const addr = String(rec.address);
  const ok = rec.ok ? '1' : '0';
  const mbps = rec.ok && Number.isFinite(rec.mbps) ? fmtMbps(rec.mbps) : '';
  const peers = String(clampU16(rec.peers));
  const lat = rec.lat ? String(clampU16(rec.lat)) : '';
  return `${addr}${SEP}${ok}${SEP}${mbps}${SEP}${peers}${SEP}${lat}`;
}

/**
 * Greedy packer — returns up to MAX_RECORDS lines whose total memo
 * (header + lines + newlines) stays ≤ MEMO_CHAR_LIMIT.
 * @returns {{ memo: string, packed: number }} packed = how many records consumed
 */
export function packBatch(ctx, records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('packBatch: need at least one record');
  }
  const header = buildHeader(ctx);
  const lines = [header];
  let total = header.length;
  let packed = 0;
  const limit = Math.min(records.length, MAX_RECORDS);
  for (let i = 0; i < limit; i++) {
    const line = buildRecordLine(records[i]);
    const next = total + 1 /* \n */ + line.length;
    if (next > MEMO_CHAR_LIMIT) break;
    lines.push(line);
    total = next;
    packed++;
  }
  if (packed === 0) {
    // A single record didn't fit — shouldn't happen for normal bech32 addrs,
    // but guard anyway. Return a header-only memo so the caller can drop it.
    throw new Error(`packBatch: first record overflows memo (header=${header.length} chars, limit=${MEMO_CHAR_LIMIT})`);
  }
  return { memo: lines.join(NL), packed };
}

/**
 * Back-compat shim — old pipeline call signature.
 * Returns a string (the encoded memo) for ≤MAX_RECORDS records.
 * Throws if the resulting memo exceeds the chain's char limit.
 */
export function encodeBatch(ctx, records) {
  if (!Array.isArray(records) || records.length < MIN_RECORDS) {
    throw new Error(`encodeBatch: need at least ${MIN_RECORDS} record`);
  }
  if (records.length > MAX_RECORDS) {
    throw new Error(`encodeBatch: max ${MAX_RECORDS} records per batch (got ${records.length})`);
  }
  const { memo, packed } = packBatch(ctx, records);
  if (packed !== records.length) {
    throw new Error(`encodeBatch: only ${packed}/${records.length} records fit under ${MEMO_CHAR_LIMIT}-char memo limit; use packBatch instead`);
  }
  return memo;
}

// ─── Decoder (v2 CSV + v1 legacy binary fallback) ────────────────────────────

export function decodeMemo(memo, hrp = DEFAULT_HRP) {
  if (typeof memo !== 'string' || memo.length === 0) return null;

  // v2 (CSV) — starts with "SNTR1|v2|"
  if (memo.startsWith(`${MAGIC}${SEP}v${VERSION}${SEP}`)) {
    return _decodeCsv(memo);
  }
  if (memo.startsWith(`${MAGIC}${SEP}v`)) {
    // Future versions / unknown — try CSV-style anyway, return null on failure
    return _decodeCsv(memo);
  }

  // v1 (legacy binary base64) — try base64 decode + binary parse
  try {
    const bytes = fromBase64(memo);
    return _decodeLegacyBinary(bytes, hrp);
  } catch {
    return null;
  }
}

function _decodeCsv(memo) {
  const lines = memo.split(NL);
  if (lines.length < 1) return null;
  const headerParts = lines[0].split(SEP);
  if (headerParts[0] !== MAGIC) return null;
  const ver = headerParts[1] || '';
  const region = (headerParts[2] || '').replace(/-/g, '').trim() || null;
  let baselineMbps = 0;
  let startedAt = 0;
  for (let i = 3; i < headerParts.length; i++) {
    const eq = headerParts[i].indexOf('=');
    if (eq < 0) continue;
    const k = headerParts[i].slice(0, eq);
    const v = headerParts[i].slice(eq + 1);
    if (k === 'b') baselineMbps = Number(v) || 0;
    else if (k === 't') startedAt = Number(v) || 0;
  }
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const p = line.split(SEP);
    if (p.length < 5) continue;
    const ok = p[1] === '1';
    const mbps = ok && p[2] !== '' ? Number(p[2]) : null;
    const peers = Number(p[3]) || 0;
    const latencyMs = p[4] !== '' ? (Number(p[4]) || 0) : null;
    records.push({
      address: p[0],
      ok,
      mbps,
      peers,
      latencyMs,
      errCode: ok ? 0 : 255,
    });
  }
  return {
    version: ver,
    region,
    baselineMbps,
    startedAt,
    startedAtIso: startedAt ? new Date(startedAt * 1000).toISOString() : null,
    count: records.length,
    records,
  };
}

// Legacy v1 binary decoder (kept so old TXs still render in history popups).
function _decodeLegacyBinary(bytes, hrp) {
  const HEADER_LEN = 15;
  const RECORD_LEN = 28;
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LEN) return null;
  const magicBytes = new TextEncoder().encode(MAGIC);
  for (let i = 0; i < magicBytes.length; i++) {
    if (bytes[i] !== magicBytes[i]) return null;
  }
  const version = bytes[5];
  if (version !== 1) return null;
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
    version: 1,
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
 * Accepts either a pre-encoded string memo (v2 CSV) or a Uint8Array (legacy v1
 * binary, base64-encoded inline) so existing call sites keep working.
 *
 * Returns { txhash, height, memoBytes }. Throws on unrecoverable failure.
 */
export async function commitBatch(client, signerAddress, encoded, broadcast) {
  let memo;
  if (typeof encoded === 'string') {
    memo = encoded;
  } else if (encoded instanceof Uint8Array) {
    // Legacy: base64 the bytes (kept so any caller still using v1 binary works).
    memo = toBase64(encoded);
  } else {
    throw new Error('commitBatch: encoded must be a string (v2 CSV) or Uint8Array (legacy)');
  }
  if (memo.length > MEMO_CHAR_LIMIT) {
    throw new Error(`Encoded memo ${memo.length} chars exceeds Sentinel chain limit ${MEMO_CHAR_LIMIT}`);
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
    memoBytes: memo.length,
    base64Bytes: memo.length,
  };
}

// ─── Querier (RPC tx_search) ─────────────────────────────────────────────────

/**
 * Query past on-chain reports posted by a given tester wallet.
 * Filters chain-side via tx_search using `transfer.sender` (the bank module's
 * TransferEvent — `message.sender` is not reliably indexed for these MsgSends
 * on the Sentinel chain).
 */
export async function queryReports(senderAddress, opts = {}) {
  const { fromHeight = 0, limit = 50 } = opts;
  const queryParts = [
    `transfer.sender='${senderAddress}'`,
    `transfer.recipient='${senderAddress}'`,
  ];
  if (fromHeight > 0) queryParts.push(`tx.height>=${fromHeight}`);
  const query = queryParts.join(' AND ');
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
  MAGIC, VERSION, MAX_RECORDS, MIN_RECORDS, MEMO_CHAR_LIMIT, SEP,
});
