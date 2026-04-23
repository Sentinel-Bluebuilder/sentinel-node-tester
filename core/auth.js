/**
 * Sentinel Node Tester — Auth Middleware
 * Admin token gate: Bearer header or signed cookie.
 * Public routes use attachAdminFlag for optional context.
 */

// ─── adminOnly ───────────────────────────────────────────────────────────────
// Blocks the request if no valid ADMIN_TOKEN is presented.
// Accepts:  Authorization: Bearer <token>
//           Cookie: admin_token=<token>  (signed by Express, see server.js cookieParser setup)
export function adminOnly(req, res, next) {
  const token = process.env.ADMIN_TOKEN;

  // No ADMIN_TOKEN configured → local/single-user mode, allow all access.
  // This is intentional: single-user installs (developer workstations) don't need auth.
  // PUBLIC_MODE=true enforces that ADMIN_TOKEN MUST be set before server starts,
  // so this bypass only applies in private/local setups.
  if (!token) {
    req.admin = true;
    return next();
  }

  // Extract from Bearer header
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;

  // Extract from signed cookie (set by POST /admin/login)
  const cookieToken = req.signedCookies?.admin_token || null;

  const presented = bearerToken || cookieToken;

  if (presented === token) {
    req.admin = true;
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized', hint: 'Provide a valid Bearer token or log in at /admin/login' });
}

// ─── attachAdminFlag ─────────────────────────────────────────────────────────
// Non-blocking: sets req.admin = true/false so public routes can conditionally
// render admin controls without enforcing authentication.
export function attachAdminFlag(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    req.admin = false;
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;
  const cookieToken = req.signedCookies?.admin_token || null;
  const presented = bearerToken || cookieToken;

  req.admin = !!(presented && presented === token);
  next();
}
