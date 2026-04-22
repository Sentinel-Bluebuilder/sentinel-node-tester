/**
 * serve — Boot the dashboard server.
 */

export const name = 'serve';
export const description = 'Start the Sentinel Node Tester dashboard server.';
export const usage = 'sentinel-audit serve [--port 3001]';
export const flags = [
  { name: '--port', desc: 'Port to listen on', default: String(process.env.PORT || '3001') },
];

export async function run({ positional, flags: f }) {
  const port = parseInt(f['--port'] || process.env.PORT || '3001', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${f['--port']}`);
  }

  // Set PORT before importing server.js — server reads process.env.PORT at load
  process.env.PORT = String(port);

  const url = `http://localhost:${port}`;
  console.error(`[serve] Starting dashboard on ${url}...`);

  // server.js registers app.listen() at top level — the import resolves once
  // the module is evaluated, but Node stays alive on the event loop because
  // the HTTP server keeps it running. Returning from run() is fine here;
  // the router will print our return value and Node will not exit because
  // the server holds the event loop open.
  await import('../../server.js');

  return {
    started: true,
    url,
    pid: process.pid,
  };
}
