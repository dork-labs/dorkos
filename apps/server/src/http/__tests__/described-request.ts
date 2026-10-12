/**
 * Build a request the way a policy test describes it, on a real Hono context,
 * and read its facts (`http/request-facts.ts`), so a policy test runs against
 * exactly what the chain hands the policy.
 */
import { Hono } from 'hono';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { honoRequestFacts, type RequestFacts, type RequestFactsEnv } from '../request-facts.js';

/** One request, described the way a test thinks about it. */
export interface DescribedRequest {
  /** Request headers, any case. */
  headers?: Record<string, string>;
  /** The TCP peer. `null` means the socket reports no address. */
  peer?: string | null;
  /** Whether the socket is TLS. */
  encrypted?: boolean;
  /** What the session gate resolved. */
  user?: RequestUser;
  /** What the agent-identity step resolved. */
  agentIdentity?: AgentIdentity;
}

/** Node's view of the headers: lower-case names. */
function nodeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** A socket stand-in carrying only what the facts read. */
function socketOf(described: DescribedRequest): { remoteAddress?: string; encrypted?: boolean } {
  return {
    remoteAddress: described.peer === null ? undefined : (described.peer ?? '127.0.0.1'),
    ...(described.encrypted ? { encrypted: true } : {}),
  };
}

/**
 * Build a described request on a real Hono context and read its facts.
 *
 * @param described - The request.
 * @returns What `honoRequestFacts` reads off it.
 */
export async function requestFactsFor(described: DescribedRequest): Promise<RequestFacts> {
  let captured: RequestFacts | undefined;
  const app = new Hono<RequestFactsEnv>();
  app.use(async (c, next) => {
    if (described.user) c.set('user', described.user);
    if (described.agentIdentity) c.set('agentIdentity', described.agentIdentity);
    await next();
  });
  app.all('*', (c) => {
    captured = honoRequestFacts(c);
    return c.body(null, 204);
  });
  const incoming = { headers: nodeHeaders(described.headers), socket: socketOf(described) };
  await app.request('/', { headers: described.headers }, { incoming, outgoing: {} });
  return captured!;
}
