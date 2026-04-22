#!/usr/bin/env node
/**
 * Sentinel Node Tester — CLI Entry Point
 *
 * Subcommand-based router for AI agents and developers.
 * Every command is self-describing so AI can discover the full schema via:
 *   sentinel-audit list
 *
 * Usage:
 *   sentinel-audit [--help] [--version] [--json] [--pretty]
 *                  [--lcd <url>] [--sdk <js|tkd>]
 *                  <command> [command-args...]
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import 'dotenv/config';

import { parseArgs } from './lib/args.js';
import { printJson, printError } from './lib/output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const commandsDir = path.join(__dirname, 'commands');

// Load .env from the installed package root too (when run via npx/global bin,
// cwd may not be the package dir). dotenv's default already picked up cwd/.env.
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(rootDir, '.env') });
} catch {}

// ─── Version ─────────────────────────────────────────────────────────────────

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Command registry (static metadata for help text) ────────────────────────

/**
 * Commands grouped by category.
 * The file is only imported when actually invoked — cold-start stays fast.
 */
const COMMAND_GROUPS = {
  Discovery: ['list', 'functions', 'verify-sdks'],
  Read: ['nodes', 'node', 'balance', 'subscriptions', 'plans'],
  Action: ['speed', 'test', 'audit', 'serve'],
};

// Flat list for quick lookup
const ALL_COMMANDS = Object.values(COMMAND_GROUPS).flat();

// ─── Top-level help ───────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
  Sentinel Node Tester  v${getVersion()}
  Network audit dashboard for Sentinel dVPN

  Usage:
    sentinel-audit <command> [options]

  Global flags (work with any command):
    --help, -h          Show help for the command (or this text)
    --version, -v       Print version
    --json              Force JSON output  (default for most commands)
    --pretty            Human-readable output
    --lcd <url>         Override LCD endpoint
    --sdk <js|tkd>      SDK for chain queries (default: js)

  Commands:

    Discovery
      list              List every command with description + flags (AI registry)
      functions         List every exported SDK function grouped by module
      verify-sdks       Verify installed SDKs match GitHub tag (byte-for-byte)

    Read
      nodes             List all active chain nodes
      node <addr>       Get single node details
      balance [addr]    Query P2P token balance
      subscriptions     List wallet subscriptions
      plans             List all on-chain plans

    Action
      speed             Baseline internet speed test (no VPN)
      test <addr>       End-to-end test one node (paid — uses real tokens)
      audit             Run full audit loop across all nodes
      serve             Start the browser dashboard server

  Examples:
    sentinel-audit list
    sentinel-audit nodes --pretty
    sentinel-audit node sentnode1abc... --pretty
    sentinel-audit balance --pretty
    sentinel-audit test sentnode1abc... --pretty
    sentinel-audit serve --port 3001

  AI Quick-Start:
    sentinel-audit list           # discover all commands + schemas
    sentinel-audit functions      # discover all SDK exports
`);
}

// ─── Per-command help ─────────────────────────────────────────────────────────

async function printCommandHelp(commandName, flags) {
  const filePath = path.join(commandsDir, `${commandName}.js`);
  if (!existsSync(filePath)) {
    printHelp();
    return;
  }
  try {
    const mod = await import(pathToFileURL(filePath).href);
    const pretty = flags['--pretty'];
    if (pretty) {
      console.log(`\n  ${mod.name} — ${mod.description ?? ''}`);
      console.log(`\n  Usage: ${mod.usage ?? `sentinel-audit ${mod.name}`}`);
      if (Array.isArray(mod.flags) && mod.flags.length) {
        console.log('\n  Flags:');
        for (const f of mod.flags) {
          console.log(`    ${String(f.flag).padEnd(24)} ${f.description}`);
        }
      }
      console.log('');
    } else {
      printJson({
        name: mod.name,
        description: mod.description ?? null,
        usage: mod.usage ?? `sentinel-audit ${mod.name}`,
        flags: mod.flags ?? [],
      });
    }
  } catch {
    printHelp();
  }
}

// ─── Command loader ───────────────────────────────────────────────────────────

/**
 * Lazily import a command module.
 * Returns null if the file does not exist yet (parallel agent not done).
 */
async function loadCommand(commandName) {
  const filePath = path.join(commandsDir, `${commandName}.js`);
  if (!existsSync(filePath)) return null;
  try {
    return await import(pathToFileURL(filePath).href);
  } catch (err) {
    throw new Error(`Failed to load command "${commandName}": ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const { command, positional, flags } = parsed;

  // --version / -v (global, no command needed)
  if (flags['--version']) {
    console.log(`sentinel-node-tester v${getVersion()}`);
    process.exit(0);
  }

  // No command — show top-level help
  if (!command) {
    printHelp();
    process.exit(0);
  }

  // --help on a specific command
  if (flags['--help']) {
    await printCommandHelp(command, flags);
    process.exit(0);
  }

  // Unknown command
  if (!ALL_COMMANDS.includes(command)) {
    if (flags['--json'] || !flags['--pretty']) {
      printJson({ error: `unknown command: ${command}` });
    } else {
      console.log(`\nunknown command: ${command}`);
      printHelp();
    }
    process.exit(2);
  }

  // Load + run the command
  const mod = await loadCommand(command);

  if (!mod) {
    const msg = `command "${command}" is not yet implemented`;
    if (flags['--pretty']) {
      console.log(`\n  ${msg}\n`);
    } else {
      printJson({ error: msg });
    }
    process.exit(1);
  }

  if (typeof mod.run !== 'function') {
    const msg = `command "${command}" does not export a run() function`;
    printError(new Error(msg), flags);
    process.exit(1);
  }

  const result = await mod.run({ command, positional, flags });
  if (result !== undefined) {
    printJson(result, { pretty: !!flags['--pretty'] });
  }
}

main().catch(e => {
  const pretty = process.argv.includes('--pretty');
  printError(e, { pretty });
  process.exit(1);
});
