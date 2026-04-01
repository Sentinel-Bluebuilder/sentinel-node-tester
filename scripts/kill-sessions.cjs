// Kill all stale sessions using the same patterns as server.js
// MsgCancelSessionRequest: { from (string, field 1), id (uint64, field 2) }

const { DirectSecp256k1HdWallet, Registry } = require('@cosmjs/proto-signing');
const { SigningStargateClient, GasPrice, defaultRegistryTypes } = require('@cosmjs/stargate');

require('dotenv').config();
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) { console.error('Set MNEMONIC in .env'); process.exit(1); }
const RPC = process.env.RPC || 'https://rpc.sentinel.co:443';
const LCD = 'https://sentinel-api.polkachu.com';
let OUR_ADDR; // Derived from mnemonic at runtime
const MSG_CANCEL_TYPE = '/sentinel.session.v3.MsgCancelSessionRequest';
const BATCH_SIZE = 15;

// ---- Protobuf helpers (same as v3protocol.js) ----

function encodeVarint(n) {
  n = BigInt(n);
  const bytes = [];
  while (n > 127n) { bytes.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function protoString(fieldNum, str) {
  if (!str) return Buffer.alloc(0);
  const b = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 2n), encodeVarint(b.length), b]);
}

function protoUint64(fieldNum, n) {
  if (!n && n !== 0) return Buffer.alloc(0);
  return Buffer.concat([encodeVarint((BigInt(fieldNum) << 3n) | 0n), encodeVarint(n)]);
}

// ---- Encode MsgCancelSessionRequest ----

function encodeMsgCancelSession({ from, id }) {
  return Uint8Array.from(Buffer.concat([
    protoString(1, from),
    protoUint64(2, id),
  ]));
}

// ---- CosmJS registry type (same pattern as server.js MsgStartSessionV3) ----

const MsgCancelSessionV3 = {
  fromPartial: (value) => value,
  encode: (instance) => ({ finish: () => encodeMsgCancelSession(instance) }),
  decode: () => ({}),
};

// ---- Find our sessions ----

async function findOurSessions() {
  const ours = [];
  let nextKey = null;
  let pages = 0;
  let total = 0;

  do {
    let path = `/sentinel/session/v3/sessions?status=1&pagination.limit=100`;
    if (nextKey) path += `&pagination.key=${encodeURIComponent(nextKey)}`;

    const r = await fetch(LCD + path, { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    const sessions = d.sessions || [];
    total += sessions.length;

    for (const s of sessions) {
      const bs = s.base_session || s;
      if (bs.acc_address === OUR_ADDR) ours.push(bs);
    }

    nextKey = d.pagination?.next_key || null;
    pages++;
    if (pages % 5 === 0) process.stdout.write(`  Page ${pages}: ${total} scanned, ${ours.length} ours...\r`);
  } while (nextKey && pages < 500);

  console.log(`Scanned ${total} sessions (${pages} pages) -> ${ours.length} ours`);
  return ours;
}

// ---- Main ----

async function main() {
  console.log('=== Session Killer ===\n');

  console.log('Finding sessions...');
  const sessions = await findOurSessions();
  if (sessions.length === 0) { console.log('No sessions found.'); return; }

  const active = sessions.filter(s => s.status === 'active').length;
  const pending = sessions.filter(s => s.status === 'inactive_pending').length;
  console.log(`  Active: ${active}, Inactive pending: ${pending}, Total: ${sessions.length}\n`);

  // Wallet + signing client (same as server.js)
  console.log('Connecting wallet...');
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  console.log(`  Address: ${account.address}`);

  const registry = new Registry([
    ...defaultRegistryTypes,
    [MSG_CANCEL_TYPE, MsgCancelSessionV3],
  ]);

  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    registry,
    gasPrice: GasPrice.fromString('0.2udvpn'),
  });

  const bal = await client.getBalance(OUR_ADDR, 'udvpn');
  console.log(`  Balance: ${(parseInt(bal.amount) / 1e6).toFixed(2)} DVPN\n`);

  // Batch kill
  const batches = [];
  for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
    batches.push(sessions.slice(i, i + BATCH_SIZE));
  }
  console.log(`Killing ${sessions.length} sessions in ${batches.length} batch(es)...\n`);

  let killed = 0, failed = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const msgs = batch.map(s => ({
      typeUrl: MSG_CANCEL_TYPE,
      value: { from: OUR_ADDR, id: BigInt(s.id) },
    }));

    try {
      const result = await client.signAndBroadcast(OUR_ADDR, msgs, 'auto');
      if (result.code === 0) {
        killed += batch.length;
        console.log(`  Batch ${b + 1}/${batches.length}: OK (${batch.length} killed) tx=${result.transactionHash.slice(0, 16)}... gas=${result.gasUsed}`);
      } else {
        failed += batch.length;
        console.log(`  Batch ${b + 1}/${batches.length}: FAIL code=${result.code} ${(result.rawLog || '').slice(0, 120)}`);
      }
    } catch (e) {
      console.log(`  Batch ${b + 1} error: ${e.message?.slice(0, 150)}`);
      // Retry individually
      console.log(`    Retrying individually...`);
      for (const s of batch) {
        try {
          const msg = [{ typeUrl: MSG_CANCEL_TYPE, value: { from: OUR_ADDR, id: BigInt(s.id) } }];
          const r2 = await client.signAndBroadcast(OUR_ADDR, msg, 'auto');
          if (r2.code === 0) { killed++; console.log(`    ${s.id}: OK`); }
          else { failed++; console.log(`    ${s.id}: FAIL code=${r2.code}`); }
        } catch (e2) {
          failed++;
          console.log(`    ${s.id}: ERR ${e2.message?.slice(0, 80)}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n=== DONE: Killed ${killed}, Failed ${failed} ===`);
  const balAfter = await client.getBalance(OUR_ADDR, 'udvpn');
  console.log(`Balance: ${(parseInt(bal.amount) / 1e6).toFixed(2)} -> ${(parseInt(balAfter.amount) / 1e6).toFixed(2)} DVPN`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
