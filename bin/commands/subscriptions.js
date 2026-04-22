/**
 * subscriptions — List active subscriptions for a wallet.
 *
 * Positional arg 0 (optional): sent1... address.
 * If omitted, address is derived from the MNEMONIC env var.
 */

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { querySubscriptions } from '../../core/chain.js';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'subscriptions';
export const description = 'List active plan subscriptions for a wallet address.';
export const usage = 'sentinel-audit subscriptions [sent1...] [--pretty]';
export const flags = [
  { flag: '--pretty', description: 'Human-readable output' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function addrFromMnemonic(mnemonic) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'sent' });
  const [account] = await wallet.getAccounts();
  return account.address;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run({ positional = [], flags: _f } = {}) {
  let address = positional[0] || null;

  if (!address) {
    const mnem = process.env.MNEMONIC;
    if (!mnem) {
      throw new Error('No address provided and MNEMONIC env var is not set');
    }
    address = await addrFromMnemonic(mnem.trim());
  }

  const subscriptions = await querySubscriptions(address);

  return {
    address,
    count: subscriptions.length,
    subscriptions,
  };
}
