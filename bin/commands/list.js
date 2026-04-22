/**
 * list — Print every registered command with description + flags.
 *
 * Scans bin/commands/ for sibling *.js files, dynamically imports each,
 * reads their exported { name, description, usage, flags } metadata,
 * and outputs a machine-readable registry.
 *
 * Missing or malformed files are skipped gracefully.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { readdirSync, existsSync } from 'fs';
import path from 'path';
import { printJson } from '../lib/output.js';

// ─── Metadata ────────────────────────────────────────────────────────────────

export const name = 'list';
export const description = 'List every registered command with description and flags (AI-discoverable registry).';
export const usage = 'sentinel-audit list [--pretty]';
export const flags = [
  { flag: '--pretty', description: 'Human-readable output instead of JSON' },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function run(args) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const commandsDir = __dirname;

  let entries;
  try {
    entries = readdirSync(commandsDir).filter(f => f.endsWith('.js') && f !== 'list.js');
  } catch {
    printJson({ error: 'Could not read commands directory' }, args.flags);
    return;
  }

  const registry = [];

  for (const file of entries.sort()) {
    const filePath = path.join(commandsDir, file);
    if (!existsSync(filePath)) continue;

    try {
      const mod = await import(pathToFileURL(filePath).href);
      if (!mod.name) continue; // not a command module

      registry.push({
        name: mod.name,
        description: mod.description ?? '(no description)',
        usage: mod.usage ?? `sentinel-audit ${mod.name}`,
        flags: mod.flags ?? [],
      });
    } catch {
      // Parallel agent hasn't written this file yet — skip silently.
    }
  }

  // Also include ourselves
  registry.unshift({
    name,
    description,
    usage,
    flags,
  });

  // Sort alphabetically by name
  registry.sort((a, b) => a.name.localeCompare(b.name));

  if (args.flags['--pretty']) {
    console.log('\nRegistered Commands\n');
    for (const cmd of registry) {
      console.log(`  ${cmd.name.padEnd(18)} ${cmd.description}`);
      if (cmd.flags.length) {
        for (const f of cmd.flags) {
          console.log(`    ${String(f.flag).padEnd(22)} ${f.description}`);
        }
      }
    }
    console.log('');
  } else {
    printJson({ commands: registry }, args.flags);
  }
}
