/**
 * The one door of a sealed agent computer (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md`).
 *
 * An agent computer serves no person. The classifier calls every request to
 * it `agent-computer` (`lib/request-classifier.ts`), and the gate policy turns
 * that into `agent` access for one from this machine and `refused` for
 * anything else (`services/core/auth/gate-policy.ts`). This module decides the
 * `agent` case, for every path the server answers, not only `/api` and `/mcp`.
 * One rule, first match wins:
 *
 * 1. **The liveness probe** (`/api/health`) passes with nothing, so whatever
 *    started the machine can tell it is up. Never `/api/health/deep`.
 * 2. **The DorkOS account routes** (`/api/cloud/*`) and **the app's event
 *    streams** ({@link isAgentComputerStreamPath}) are refused whatever the
 *    request carries. The account belongs to the hub, and the streams feed a
 *    window nobody opens here; their WebSocket upgrades refuse the same way
 *    (`streams/stream-upgrade-auth.ts`).
 * 3. **`/mcp` and A2A** (`/a2a`, its agent cards) pass to their own
 *    authorizer, `middleware/mcp-auth.ts`, which runs on every one of those
 *    routes and alone decides them: the local MCP token, `MCP_API_KEY` and the
 *    legacy config key, exactly as it accepts them, and nothing tokenless. The
 *    gate does not check a credential there, so the two can never disagree.
 * 4. **Everything else**, all of `/api` included, needs a live agent
 *    identity: an `X-DorkOS-Agent` token that resolves to an agent still
 *    acting as itself (not revoked or expired). The local MCP token admits
 *    nothing here, and neither does a person's cookie or key, which cannot
 *    exist (registration is closed for every caller).
 *
 * An admitted request may still be refused by its route: a write the hub owns
 * answers `403` ({@link agentComputerRouteRefusal}), and an action only the
 * hub may take, or one nobody here could approve, is refused at the
 * capability gates (`./hub-owned.ts`).
 *
 * **Until the hub owns authority over an agent computer (part 6 of the design
 * note), any process on the computer is trusted at agent level.** Every
 * process there runs as the same user, so any of them can read the local MCP
 * token or an agent's identity token, and the gate cannot tell them apart.
 * What keeps the computer sealed today is what no agent may do (the tables in
 * `./hub-owned.ts`), not who is asking.
 *
 * @module services/core/agent-computer/agent-gate
 */
import type { IncomingHttpHeaders } from 'node:http';
import { logger } from '../../../lib/logger.js';
import {
  getAgentIdentityService,
  type AgentIdentity,
} from '../agent-identity/agent-identity-service.js';
import { agentComputerRouteRefusal, type HubOwnedRouteRefusal } from './hub-owned.js';

/** The header an agent presents its identity token in (`middleware/agent-identity.ts`). */
const AGENT_IDENTITY_HEADER = 'x-dorkos-agent';

/** Path prefixes an agent computer refuses to every caller. */
const SEALED_PREFIXES = ['/api/cloud'] as const;

/** The app's event streams, which an agent computer never serves. */
const STREAM_PATHS: readonly RegExp[] = [
  /^\/api\/events\/?$/,
  /^\/api\/sessions\/[^/]+\/events\/?$/,
  /^\/api\/rooms\/[^/]+\/events\/?$/,
  /^\/api\/communities\/[^/]+\/rooms\/[^/]+\/events\/?$/,
  /^\/api\/relay\/stream\/?$/,
  /^\/api\/extensions\/events\/?$/,
  /^\/api\/tunnel\/stream\/?$/,
];

/** Paths whose own authorizer (`middleware/mcp-auth.ts`) decides them. */
const OWN_AUTHORIZER_PATHS: readonly RegExp[] = [
  /^\/mcp\/?$/,
  /^\/a2a(\/.*)?$/,
  /^\/\.well-known\/agent(-card)?\.json$/,
];

/** What the gate of an agent computer decided about one request. */
export type AgentComputerGateDecision =
  /** Let it through, with the agent that proved itself when one did. */
  | { allowed: true; agentIdentity?: AgentIdentity }
  /** Refuse: `refusal` is the `403` body, or absent for the plain `401`. */
  | { allowed: false; refusal?: HubOwnedRouteRefusal };

/** Collapse repeated slashes, the way the router reads a path. */
function collapse(path: string): string {
  return path.replace(/\/{2,}/g, '/');
}

/**
 * Whether a lowercased path is one an agent computer refuses to every caller.
 *
 * @param path - The lowercased request path, without its query.
 */
export function isAgentComputerSealedPath(path: string): boolean {
  const collapsed = collapse(path);
  return (
    SEALED_PREFIXES.some((prefix) => collapsed === prefix || collapsed.startsWith(`${prefix}/`)) ||
    isAgentComputerStreamPath(collapsed)
  );
}

/**
 * Whether a lowercased path is one of the app's event streams.
 *
 * @param path - The lowercased request path, without its query.
 */
export function isAgentComputerStreamPath(path: string): boolean {
  const collapsed = collapse(path);
  return STREAM_PATHS.some((pattern) => pattern.test(collapsed));
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
 * The live agent an `X-DorkOS-Agent` header names, or `undefined` when it
 * names none, or one that is revoked or expired. Never throws.
 *
 * @param headers - The request headers.
 */
export async function liveAgentIdentity(
  headers: IncomingHttpHeaders
): Promise<AgentIdentity | undefined> {
  const header = headers[AGENT_IDENTITY_HEADER];
  const token = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!token) return undefined;
  try {
    const identity = await getAgentIdentityService()?.resolve(token);
    return identity && identity.inactive === undefined ? identity : undefined;
  } catch (err) {
    logger.debug('[agent-computer] Agent token resolution failed', { err: String(err) });
    return undefined;
  }
}

/**
 * Decide one request at the gate of an agent computer. See the module doc for
 * the rule.
 *
 * @param method - The request method.
 * @param path - The lowercased request path, without its query.
 * @param headers - The request headers.
 */
export async function decideAgentComputerGate(
  method: string,
  path: string,
  headers: IncomingHttpHeaders
): Promise<AgentComputerGateDecision> {
  const collapsed = collapse(path);
  if (isAgentComputerOpenPath(collapsed)) return { allowed: true };
  if (isAgentComputerSealedPath(collapsed)) return { allowed: false };
  if (OWN_AUTHORIZER_PATHS.some((pattern) => pattern.test(collapsed))) return { allowed: true };
  const agentIdentity = await liveAgentIdentity(headers);
  if (!agentIdentity) return { allowed: false };
  const refusal = agentComputerRouteRefusal(method, collapsed);
  return refusal ? { allowed: false, refusal } : { allowed: true, agentIdentity };
}
