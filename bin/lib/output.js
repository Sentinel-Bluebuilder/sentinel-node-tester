/**
 * Sentinel Node Tester — Shared Output Helpers
 *
 * All CLI commands import from here for consistent formatting.
 */

// ─── JSON Output ──────────────────────────────────────────────────────────────

/**
 * Print an object to stdout.
 * @param {unknown} obj
 * @param {{ pretty?: boolean }} [opts]
 */
export function printJson(obj, opts = {}) {
  if (opts.pretty) {
    console.log(JSON.stringify(obj, null, 2));
  } else {
    console.log(JSON.stringify(obj));
  }
}

// ─── Error Output ─────────────────────────────────────────────────────────────

/**
 * Print an error to stdout (not stderr) so piped consumers always get output.
 * In JSON mode (default) prints {"error":"<message>"}.
 * In pretty mode prints a formatted stack trace.
 * @param {Error|unknown} err
 * @param {{ pretty?: boolean }} [opts]
 */
export function printError(err, opts = {}) {
  const message = err instanceof Error ? err.message : String(err);
  if (opts.pretty) {
    const stack = err instanceof Error && err.stack ? err.stack : message;
    console.log(`\nError: ${stack}\n`);
  } else {
    console.log(JSON.stringify({ error: message }));
  }
}
