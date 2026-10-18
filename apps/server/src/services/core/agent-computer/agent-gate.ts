/**
 * The one door of a sealed agent computer (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md`).
 *
 * An agent computer serves no person. The classifier calls every request to
 * it `agent-computer` (`lib/request-classifier.ts`), and the gate policy turns
 * that into `agent` access for one from this machine and `refused` for
 * anything else (`services/core/auth/gate-policy.ts`). This module decides the
 * `agent` case, for every path the server answers, not only `/api` and `/mcp`:
 *
 * - **The liveness probe** (`/api/health`) passes with nothing, so whatever
 *   started the machine can tell it is up. Never `/api/health/deep`.
 * - **The DorkOS account routes** (`/api/cloud/*`) are refused whatever the
 *   request carries. An agent computer is never linked to an account from
 *   here and holds none to report; its access will come from its hub.
 * - **An agent's own credential** passes: the instance's local MCP token as
 *   `Authorization: Bearer`, or an `X-DorkOS-Agent` identity token that
 *   resolves to an agent still acting as itself (not revoked or expired).
 * - **Everything else is refused**, a person's cookie and API key included.
 *   None can exist here (registration is closed for every caller), and the
 *   gate does not look for one.
 *
 * Admitting a request here only lets it reach its route. Settings writes and
 * the sign-in routes of runtimes and MCP servers refuse on an agent computer
 * on their own (`./sealed.ts`, and `isAtThisComputer`, which is never true
 * there), and `/mcp` still asks its own authorizer, which accepts only the
 * local token here.
 *
 * @module services/core/agent-computer/agent-gate
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { logger } from '../../../lib/logger.js';
import { getAgentIdentityService } from '../agent-identity/agent-identity-service.js';
import { getMcpLocalToken } from '../auth/mcp-local-token.js';

/** The header an agent presents its identity token in (`middleware/agent-identity.ts`). */
const AGENT_IDENTITY_HEADER = 'x-dorkos-agent';

/** Path prefixes an agent computer refuses to every caller. */
const SEALED_PREFIXES = ['/api/cloud'] as const;

/**
 * Whether a lowercased path is one an agent computer refuses to every caller,
 * an agent's own credential included.
 *
 * @param path - The lowercased request path, without its query.
 */
export function isAgentComputerSealedPath(path: string): boolean {
  const collapsed = path.replace(/\/{2,}/g, '/');
  return SEALED_PREFIXES.some(
    (prefix) => collapsed === prefix || collapsed.startsWith(`${prefix}/`)
  );
}

/**
 * Whether a lowercased path is the liveness probe, the one path an agent
 * computer answers without a credential.
 *
 * @param path - The lowercased request path, without its query.
 */
export function isAgentComputerOpenPath(path: string): boolean {
  return path === '/api/health' || path === '/api/health/';
}

/**
 * Whether a request carries an agent's own credential: the local MCP token, or
 * an identity token that resolves to an active agent. Never throws.
 *
 * @param headers - The request headers.
 */
export async function presentsAgentCredential(headers: IncomingHttpHeaders): Promise<boolean> {
  if (bearerIsLocalToken(headers.authorization)) return true;
  const header = headers[AGENT_IDENTITY_HEADER];
  const token = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!token) return false;
  try {
    const identity = await getAgentIdentityService()?.resolve(token);
    return identity !== undefined && identity.inactive === undefined;
  } catch (err) {
    logger.debug('[agent-computer] Agent token resolution failed', { err: String(err) });
    return false;
  }
}

/**
 * Whether a request may pass the gate of an agent computer. See the module
 * doc for the rules.
 *
 * @param path - The lowercased request path, without its query.
 * @param headers - The request headers.
 */
export async function admitsOnAgentComputer(
  path: string,
  headers: IncomingHttpHeaders
): Promise<boolean> {
  if (isAgentComputerOpenPath(path)) return true;
  if (isAgentComputerSealedPath(path)) return false;
  return presentsAgentCredential(headers);
}

/** Whether an `Authorization: Bearer` value is this instance's local MCP token. */
function bearerIsLocalToken(authorization: string | undefined): boolean {
  if (!authorization) return false;
  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  const local = getMcpLocalToken();
  if (!local) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(local);
  return a.length === b.length && timingSafeEqual(a, b);
}
