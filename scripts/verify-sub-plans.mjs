#!/usr/bin/env node
/**
 * Verify fee-grant status across ALL subscribed plans for the wallet in .env.
 * Does NOT broadcast TX. Read-only chain query.
 */

import 'dotenv/config';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { querySubscriberPlansEnriched } from '../core/chain.js';

const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC || MNEMONIC.startsWith('your twelve')) {
  console.error('Missing MNEMONIC in .env');
  process.exit(1);
}

const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
const [account] = await wallet.getAccounts();
console.log('Wallet:', account.address);
console.log('Querying enriched subscriber plans...\n');

const t0 = Date.now();
const rows = await querySubscriberPlansEnriched(account.address);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

if (rows.length === 0) {
  console.log('No active subscriptions.');
  process.exit(0);
}

console.log(`Found ${rows.length} subscription(s) in ${elapsed}s:\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('SubId', 8), pad('PlanId', 8), pad('Nodes', 7), pad('FeeGrant', 10), pad('Granter', 45), 'Expiry');
console.log('-'.repeat(120));
for (const r of rows) {
  const fg = r.feeGrantActive ? 'ACTIVE' : 'MISSING';
  console.log(
    pad(r.subscriptionId, 8),
    pad(r.planId, 8),
    pad(r.nodeCount, 7),
    pad(fg, 10),
    pad(r.ownerSentAddr || '(none)', 45),
    r.expiry || '(none)',
  );
}

const active = rows.filter(r => r.feeGrantActive);
const missing = rows.filter(r => !r.feeGrantActive);
console.log(`\nSummary: ${active.length} with active fee grant, ${missing.length} without.`);
if (active.length > 0) {
  console.log('\nPlans ready for Sub. Plan testing:');
  for (const r of active) {
    console.log(`  - Plan ${r.planId} (${r.nodeCount} nodes), granter ${r.ownerSentAddr}, sub ${r.subscriptionId}`);
  }
}
process.exit(0);
