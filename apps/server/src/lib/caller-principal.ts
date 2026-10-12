/**
 * Who is on the other end of a request or a stream connection, in the only
 * terms anything here needs (spec `ask-entitlement` §1, DOR-1356).
 *
 * It sits beside `lib/caller-authority.ts` and exists for the same
 * anti-divergence reason that module's doc gives: several surfaces ask "who is
 * calling" — the fleet-wide Ask list, the global fan-out, and whatever joins
 * them next — and the failure that matters is not a wrong answer but a
 * DIVERGENT one. A list route and the live stream that disagreed about who a
 * caller is would show a prompt on one and withhold it on the other, and
 * nothing would say which was right.
 *
 * `caller-authority.ts` answers a narrower question — may this caller DECIDE —
 * in the shape `resolveDecisionAuthority` wants. This answers the broader one it
 * is built on: WHAT is calling. The policies that consume it live next to the
 * things they govern (`services/session/ask-entitlement.ts` is the first).
 *
 * @module lib/caller-principal
 */
import type { Request, Response } from 'express';

import { getRequestAgentIdentity, presentsAgentIdentity } from '../middleware/agent-identity.js';
import type { RequestFacts } from '../http/request-facts.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';

/**
 * Who is on the other end of a request or a stream connection.
 *
 * A `res.locals`-shaped read, exactly like `readCallerAuthority`, so both
 * transports answer it identically: the Express chain fills `res.locals`, and a
 * WebSocket upgrade fills the same shape itself (`StreamUpgradeLocals`).
 */
export type CallerPrincipal =
  /** A person in the cockpit — or, with login off, anything that presents nothing. */
  | { readonly kind: 'operator' }
  /** A program proving the person's identity with one of their per-user API keys. */
  | { readonly kind: 'program'; readonly userId: string }
  /** Anything presenting `X-DorkOS-Agent`, resolved or not. */
  | { readonly kind: 'agent' }
  /** Somebody clicking a button on a chat platform. Never arrives over HTTP. */
  | {
      readonly kind: 'bridged';
      readonly platform: string;
      readonly platformUserId: string;
    };

/**
 * Read the principal off a request and the locals the gate filled.
 *
 * Order is load-bearing and fails closed: the agent question is asked FIRST, so
 * a caller holding a valid credential AND presenting an agent header reads as an
 * agent. That is the same precedence `resolveDecisionAuthority` uses, and the
 * reason DOR-474 exists — an agent legitimately holds one of the person's
 * per-user API keys, so the credential alone cannot tell the two apart.
 *
 * There is no `bridged` branch: nothing on a chat platform speaks HTTP to this
 * server. That member is constructed by the relay path (spec `ask-entitlement`
 * §5) and belongs to the union so that one function answers for both worlds.
 *
 * Takes a request's facts (`http/request-facts.ts`), which is how a Hono
 * route asks, or a request and the locals the gate filled.
 *
 * @param req - The request's facts, or the incoming request or upgrade, for
 *   the raw headers.
 * @param res - With a request: anything holding the request-scoped locals — an
 *   Express `Response`, or the locals a WebSocket upgrade resolved for itself.
 * @returns What is calling.
 */
export function readCallerPrincipal(
  request: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'>
): CallerPrincipal;
export function readCallerPrincipal(
  req: Pick<Request, 'headers'>,
  res: Pick<Response, 'locals'>
): CallerPrincipal;
export function readCallerPrincipal(
  req: Pick<Request, 'headers'> | Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'>,
  res?: Pick<Response, 'locals'>
): CallerPrincipal {
  const caller: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> = res
    ? {
        headers: req.headers,
        user: res.locals.user as RequestUser | undefined,
        agentIdentity: getRequestAgentIdentity(res),
      }
    : (req as Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'>);
  if (presentsAgentIdentity(caller)) return { kind: 'agent' };

  if (caller.user?.credential === 'api-key') return { kind: 'program', userId: caller.user.userId };

  return { kind: 'operator' };
}
