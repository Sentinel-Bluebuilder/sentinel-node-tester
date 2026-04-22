/**
 * Sentinel Node Tester — argv Parser
 *
 * Parses process.argv into:
 *   { command, positional, flags }
 *
 * Rules:
 *   - The first non-flag token after argv[2] is the command.
 *   - Everything after the command that is not a flag is positional.
 *   - Supports --flag value and --flag=value syntax.
 *   - Boolean flags (no value token following) are set to true.
 *   - Short aliases (-h, -v) are mapped here.
 */

// ─── Known flag aliases ───────────────────────────────────────────────────────

const ALIASES = {
  '-h': '--help',
  '-v': '--version',
};

// ─── Flags that consume the next token as their value ────────────────────────

const VALUE_FLAGS = new Set([
  '--lcd', '--sdk', '--port', '--wallet', '--output',
  '--limit', '--max', '--country', '--timeout', '--out',
]);

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv - typically process.argv.slice(2)
 * @returns {{ command: string|null, positional: string[], flags: Record<string,string|boolean> }}
 */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let command = null;
  let i = 0;

  while (i < argv.length) {
    let token = argv[i];

    // Resolve short alias
    if (ALIASES[token]) {
      token = ALIASES[token];
    }

    if (token.startsWith('--')) {
      // Handle --flag=value
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        const key = token.slice(0, eqIdx);
        const val = token.slice(eqIdx + 1);
        flags[key] = val;
        i++;
        continue;
      }

      // Handle --flag value
      if (VALUE_FLAGS.has(token) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[token] = argv[i + 1];
        i += 2;
        continue;
      }

      // Boolean flag
      flags[token] = true;
      i++;
      continue;
    }

    if (token.startsWith('-') && token.length === 2) {
      // Unknown short flag — treat as boolean
      flags[token] = true;
      i++;
      continue;
    }

    // Non-flag token
    if (command === null) {
      command = token;
    } else {
      positional.push(token);
    }
    i++;
  }

  return { command, positional, flags };
}
