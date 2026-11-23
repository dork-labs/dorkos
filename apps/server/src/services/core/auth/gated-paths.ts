/**
 * Which paths the session gate decides on: the API surface and the external
 * MCP endpoint. Everything else (the app's pages and assets) is served without
 * the gate, so the login screen can load. Among those, the exemptions it lets
 * through with no credential ({@link isGateExemptPath}; why each one is exempt
 * is in `./session-gate.ts`). On an agent computer none of the exemptions
 * apply: its own gate decides every path.
 *
 * A leaf module, so the managed ingress can ask without importing the auth
 * stack, and the OpenAPI document can mark the same operations as open from
 * the code the gate runs (`services/core/openapi/security-schemes.ts`).
 *
 * @module services/core/auth/gated-paths
 */
import {
  RELAY_LINK_PATH,
  SESSION_RELAY_PASSKEY_FINISH_PATH,
} from '@dorkos/shared/session-relay-link';
import type { ServerRole } from '../../../lib/server-role.js';

/**
 * Whether the session gate decides on a path. Matched without regard to case,
 * as the router matches.
 *
 * @param path - A pathname, or an origin-form target (its query is ignored).
 */
export function isSessionGatedPath(path: string): boolean {
  const lowered = path.split('?')[0]!.toLowerCase();
  return lowered.startsWith('/api/') || lowered === '/mcp' || lowered.startsWith('/mcp/');
}

/**
 * The one path under `/api/health` that the gate still protects.
 *
 * The liveness probe is exempt because a load balancer, the desktop shell, and
 * the tunnel all have to reach it before anyone signs in, and it says only that
 * the server is up. `/api/health/deep` is a different thing wearing the same
 * prefix: it reports how many rooms, integrations, and agents this machine has
 * and which of them are broken. That is for the operator, so it needs the
 * operator's credential.
 */
const GATED_HEALTH_PATHS = ['/api/health/deep'];

/**
 * Whether a path reaches a gated health route, however it is spelled.
 *
 * The router matches non-strictly, so `/api/health/deep/` reaches the same
 * handler as `/api/health/deep`, and a path with doubled slashes must not be
 * trusted to miss it either. An
 * exact-string carve-out out of a prefix exemption therefore leaks: the
 * trailing-slash spelling misses the carve-out, matches the `/api/health/`
 * exemption, and returns the whole report with no credential. Match the way
 * the router does — normalize, then compare as a prefix.
 *
 * Case is already handled: the caller lowercases before any gate check.
 *
 * @param path - The lowercased request path.
 * @returns `true` when the request would reach a gated health route.
 */
function isGatedHealthPath(path: string): boolean {
  const collapsed = path.replace(/\/{2,}/g, '/');
  // `\/$`, not `\/+$`: the collapse on the line above leaves no run of two
  // slashes for the `+` to consume, so it could only ever retry at every offset
  // of a run that cannot exist — quadratic in shape (CodeQL js/polynomial-redos)
  // on the pre-auth path every request takes, which is the last place to leave
  // one standing.
  const normalized = collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
  return GATED_HEALTH_PATHS.some(
    (gated) => normalized === gated || normalized.startsWith(`${gated}/`)
  );
}

/**
 * A media URL with a whole ticket (43 base64url characters), matched on the
 * path exactly as the router sees it, case and all: the router is
 * case-sensitive, so this is the only spelling that reaches the media route,
 * and no other spelling (`/api/extensions/MEDIA/…`) is ever exempt.
 */
const MEDIA_TICKET_PATH = /^\/api\/extensions\/media\/[A-Za-z0-9_-]{43}$/;

/**
 * Whether the session gate lets a path through with no credential, whatever
 * the request's origin: the Better Auth endpoints (so sign-in is reachable),
 * the health probe, the signed-token and ticket routes, and the two
 * role-bound paths. The session gate's module doc gives each one's reason.
 *
 * @param path - The path, lowercased.
 * @param exactPath - The same path in its original case, for the one
 *   exemption that must match it exactly.
 * @param role - The role this server runs in; two exemptions turn on it.
 */
export function isGateExemptPath(path: string, exactPath: string, role: ServerRole): boolean {
  if (isGatedHealthPath(path)) return false;
  return (
    path.startsWith('/api/auth/') ||
    path === '/api/health' ||
    path.startsWith('/api/health/') ||
    // Signed-token-authorized embedded-browser content (the session gate's module doc).
    path.startsWith('/api/workbench/serve/') ||
    // A video an app's frame plays, by its ticket (the session gate's module doc).
    MEDIA_TICKET_PATH.test(exactPath) ||
    // A computer redeeming a link code, on a hub only (the session gate's module doc).
    (path === RELAY_LINK_PATH && role === 'hub') ||
    // A new approvals passkey coming back to this computer (the session gate's module doc).
    (path === SESSION_RELAY_PASSKEY_FINISH_PATH && role !== 'hub')
  );
}
