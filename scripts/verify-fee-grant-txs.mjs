/**
 * verify-fee-grant-txs.mjs
 * Read-only verification: confirms Sub. Plan fee-grant flow is working on-chain.
 * No broadcasting. No writes to production code.
 *
 * Run: node scripts/verify-fee-grant-txs.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// Load .env manually (avoid top-level await issues with dotenv)
const envPath = join(ROOT, '.env');
if (!existsSync(envPath)) {
  console.error('ERROR: .env not found at', envPath);
  process.exit(1);
}
const envLines = readFileSync(envPath, 'utf8').split('\n');
const env = {};
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx === -1) continue;
  env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
}

const MNEMONIC = env.MNEMONIC;
if (!MNEMONIC) {
  console.error('ERROR: MNEMONIC not set in .env');
  process.exit(1);
}

// Known Sub. Plan fee-granter (plan operator's address)
const EXPECTED_GRANTER = 'sent1t0xjyflrah5n36rfkpfeuw6pz6vl2g27x2793l';
// Two distinct msg types:
//   P2P path:      /sentinel.node.v3.MsgStartSessionRequest         (pays own gas)
//   Sub. Plan:     /sentinel.subscription.v3.MsgStartSessionRequest (fee-granted)
const P2P_MSG_TYPE      = '/sentinel.node.v3.MsgStartSessionRequest';
const SUB_PLAN_MSG_TYPE = '/sentinel.subscription.v3.MsgStartSessionRequest';

// LCD endpoints with failover
const LCD_ENDPOINTS = [
  'https://sentinel-api.polkachu.com',
  'https://api.sentinel.quokkastake.io',
  'https://lcd.sentinel.co',
];

const RESULTS_DIR = join(ROOT, 'results');
const BALANCE_SNAPSHOT = join(RESULTS_DIR, '.balance-before.txt');

// ─── Wallet derivation ────────────────────────────────────────────────────────

async function deriveAddress(mnemonic) {
  // Use @cosmjs/proto-signing to derive the sent1... address
  const { DirectSecp256k1HdWallet } = await import('@cosmjs/proto-signing');
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: 'sent',
  });
  const [account] = await wallet.getAccounts();
  return account.address;
}

// ─── HTTP with failover ───────────────────────────────────────────────────────

async function fetchWithFailover(path, label) {
  for (const base of LCD_ENDPOINTS) {
    const url = `${base}${path}`;
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`  [WARN] ${base} → HTTP ${res.status} for ${label}`);
        continue;
      }
      const data = await res.json();
      console.log(`  [LCD]  Using ${base} for ${label}`);
      return data;
    } catch (err) {
      console.warn(`  [WARN] ${base} failed (${err.message}) for ${label}`);
    }
  }
  throw new Error(`All LCD endpoints failed for: ${label}`);
}

// ─── Query transactions ───────────────────────────────────────────────────────

async function queryRecentTxs(addr) {
  // URL-encode single quotes around the address value
  const encoded = encodeURIComponent(`'${addr}'`);
  const path = `/cosmos/tx/v1beta1/txs?events=message.sender=${encoded}&pagination.limit=20&pagination.reverse=true`;
  return fetchWithFailover(path, 'recent TXs');
}

// ─── Query balance ────────────────────────────────────────────────────────────

async function queryBalance(addr) {
  const path = `/cosmos/bank/v1beta1/balances/${addr}`;
  const data = await fetchWithFailover(path, 'balance');
  const coins = data.balances ?? [];
  const udvpn = coins.find(c => c.denom === 'udvpn');
  return udvpn ? BigInt(udvpn.amount) : 0n;
}

// ─── Balance snapshot ─────────────────────────────────────────────────────────

function formatP2P(udvpn) {
  const p2p = Number(udvpn) / 1_000_000;
  return `${p2p.toFixed(6)} P2P (${udvpn} udvpn)`;
}

async function handleBalanceSnapshot(addr) {
  const current = await queryBalance(addr);
  const currentStr = current.toString();

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

  if (existsSync(BALANCE_SNAPSHOT)) {
    const prev = BigInt(readFileSync(BALANCE_SNAPSHOT, 'utf8').trim());
    const diff = current - prev;
    console.log('\n── Balance Comparison ──────────────────────────────────────');
    console.log(`  Snapshot (before):  ${formatP2P(prev)}`);
    console.log(`  Current:            ${formatP2P(current)}`);
    if (diff === 0n) {
      console.log('  Change:             0 (no on-chain spend since snapshot)');
    } else if (diff < 0n) {
      console.log(`  Change:             -${formatP2P(-diff)}  ← tokens spent`);
    } else {
      console.log(`  Change:             +${formatP2P(diff)}  ← tokens received`);
    }
  } else {
    console.log('\n── Balance Snapshot ────────────────────────────────────────');
    console.log(`  No previous snapshot found. Creating now.`);
    console.log(`  Current balance: ${formatP2P(current)}`);
    writeFileSync(BALANCE_SNAPSHOT, currentStr, 'utf8');
    console.log(`  Snapshot saved → results/.balance-before.txt`);
  }

  return current;
}

// ─── Table helpers ────────────────────────────────────────────────────────────

function shortHash(hash) {
  return hash ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : 'N/A';
}

function shortMsgType(type) {
  // /sentinel.subscription.v3.MsgStartSessionRequest → MsgStartSessionRequest
  return type ? type.split('.').pop() : 'unknown';
}

function padEnd(str, len) {
  const s = String(str ?? '');
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Sentinel Sub. Plan Fee-Grant Verification (read-only)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // 1. Derive wallet address
  console.log('Deriving wallet address from MNEMONIC...');
  const addr = await deriveAddress(MNEMONIC);
  console.log(`  Wallet: ${addr}\n`);

  // 2. Query recent TXs
  console.log('Querying last 20 TXs from chain...');
  let txData;
  try {
    txData = await queryRecentTxs(addr);
  } catch (err) {
    console.error('\nFATAL: Could not fetch TXs from any LCD endpoint.');
    console.error(err.message);
    process.exit(1);
  }

  const txs = txData.txs ?? [];
  const responses = txData.tx_responses ?? [];

  if (txs.length === 0) {
    console.log('  No transactions found for this wallet.');
  }

  // 3. Inspect each TX
  const rows = [];
  for (let i = 0; i < txs.length; i++) {
    const tx   = txs[i];
    const resp = responses[i] ?? {};

    const granter  = tx?.auth_info?.fee?.granter ?? '';
    const payer    = tx?.auth_info?.fee?.payer   ?? '';
    const messages = tx?.body?.messages ?? [];
    const code     = resp.code ?? -1;
    const height   = resp.height ?? '?';
    const txhash   = resp.txhash ?? '';

    // All message types in this TX
    const msgTypes = messages.map(m => m['@type'] ?? 'unknown');

    rows.push({ txhash, height, msgTypes, granter, payer, code });
  }

  // 4. Print table
  console.log('\n── TX Table (last 20) ──────────────────────────────────────────');
  const hdr = `${'Hash'.padEnd(16)} | ${'Height'.padEnd(8)} | ${'Msg Type'.padEnd(26)} | ${'Granter'.padEnd(12)} | Code`;
  console.log(hdr);
  console.log('─'.repeat(hdr.length));

  for (const row of rows) {
    const hash    = shortHash(row.txhash);
    const height  = padEnd(row.height, 8);
    const msgSummary = row.msgTypes.map(shortMsgType).join(', ');
    const granterShort = row.granter
      ? `${row.granter.slice(0, 8)}...`
      : '(none)';
    const codeStr = row.code === 0 ? '✓ 0' : `✗ ${row.code}`;
    console.log(`${padEnd(hash, 16)} | ${height} | ${padEnd(msgSummary, 26)} | ${padEnd(granterShort, 12)} | ${codeStr}`);
  }

  // 5. Summarize Sub. Plan session TXs
  const subPlanRows = rows.filter(r =>
    r.msgTypes.some(t => t === SUB_PLAN_MSG_TYPE)
  );

  const withGranter  = subPlanRows.filter(r => r.granter && r.granter !== '');
  const withSuccess  = subPlanRows.filter(r => r.code === 0);
  const missingGranter = subPlanRows.filter(r => !r.granter || r.granter === '');

  console.log('\n── Sub. Plan Fee-Grant Summary ─────────────────────────────────');
  console.log(`  Total TXs inspected:                ${rows.length}`);
  console.log(`  Sub. Plan session TXs (MsgStartSession): ${subPlanRows.length}`);
  console.log(`  With fee.granter set:               ${withGranter.length}`);
  console.log(`  With code == 0 (success):           ${withSuccess.length}`);
  console.log(`  MISSING granter (BUG indicator):    ${missingGranter.length}`);

  // 6. Verdict
  console.log('\n── Verdict ─────────────────────────────────────────────────────');

  if (subPlanRows.length === 0) {
    console.log('  [INFO] No Sub. Plan session TXs found in last 20 TXs.');
    console.log('         Run some Sub. Plan sessions first, then re-verify.');
  } else if (missingGranter.length > 0) {
    console.log('  *** BUG DETECTED ***');
    console.log(`  ${missingGranter.length} Sub. Plan session TX(s) have NO fee.granter.`);
    console.log('  These were NOT fee-granted — the wallet paid its own gas.');
    console.log('  Missing-granter TX hashes:');
    for (const r of missingGranter) {
      console.log(`    ${r.txhash}  height=${r.height}  code=${r.code}`);
    }
  } else {
    // Check granter matches expected value
    const wrongGranter = withGranter.filter(r => r.granter !== EXPECTED_GRANTER);
    if (wrongGranter.length > 0) {
      console.log('  [WARN] Some TXs have a granter, but it is NOT the expected plan operator:');
      for (const r of wrongGranter) {
        console.log(`    TX ${r.txhash}  granter=${r.granter}`);
      }
      console.log(`  Expected: ${EXPECTED_GRANTER}`);
    } else if (withSuccess.length === subPlanRows.length) {
      console.log('  [OK] Fee-grant confirmed working on-chain.');
      console.log(`  All ${subPlanRows.length} Sub. Plan session TX(s) have:`);
      console.log(`    granter = ${EXPECTED_GRANTER}`);
      console.log('    code = 0 (success)');
    } else {
      console.log('  [PARTIAL] Some Sub. Plan TXs succeeded, some failed.');
      console.log(`  Succeeded: ${withSuccess.length} / ${subPlanRows.length}`);
      const failedRows = subPlanRows.filter(r => r.code !== 0);
      for (const r of failedRows) {
        console.log(`    FAILED TX ${r.txhash}  code=${r.code}  height=${r.height}`);
      }
    }
  }

  // 7. Balance snapshot
  try {
    await handleBalanceSnapshot(addr);
  } catch (err) {
    console.warn('\n  [WARN] Could not fetch balance:', err.message);
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
