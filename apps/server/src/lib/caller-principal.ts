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
import { presentsAgentIdentity } from './http/agent-identity-header.js';
import type { RequestFacts } from '../http/request-facts.js';

/**
 * Who is on the other end of a request or a stream connection.
 *
 * Read off a request's facts, exactly like `readCallerAuthority`, so both
 * transports answer it identically: the chain fills them for a request, and a
 * WebSocket upgrade from what it resolved for itself (`StreamUpgradeLocals`).
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
    }
  /**
   * The session relay: the owner's own DorkOS on the web, reaching this
   * computer's chats over the connection this computer dialed out to its
   * pinned hub (`services/core/session-relay/`). Never a person and never "at
   * this computer": whatever it may do is decided per request by the relay's
   * own request server, never by a policy that trusts a person here. Never
   * arrives over HTTP.
   */
  | { readonly kind: 'relayed' };

/**
 * Read the principal off a request's facts.
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
 * No `relayed` branch either, for the same reason: only the session relay's
 * request server constructs one.
 *
 * @param caller - The request's facts (`http/request-facts.ts`): the raw
 *   headers and what the session gate and the agent-identity step resolved. A
 *   WebSocket upgrade passes `upgradeCaller(headers, locals)`.
 * @returns What is calling.
 */
export function readCallerPrincipal(
  caller: Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'>
): CallerPrincipal {
  if (presentsAgentIdentity(caller)) return { kind: 'agent' };

  if (caller.user?.credential === 'api-key') return { kind: 'program', userId: caller.user.userId };

  return { kind: 'operator' };
}

/**
 * The audience a computer-side broadcast falls back to before the space side
 * has handed it the real one: the operator at this computer, and nobody else.
 * Every audience the space side hands in lets the operator hear, so this one
 * can only ever be narrower than the rule it stands in for, never wider
 * (spec `computer-side-starts-alone` §5.12).
 *
 * @param principal - What the connection registered itself as.
 */
export function ownerOnlyAudience(principal: CallerPrincipal): boolean {
  return principal.kind === 'operator';
}

/**
 * The audience of front-door state a person may read and an agent may not: the
 * person, or a program holding one of their keys, never anything presenting
 * an agent identity. The tunnel's status uses it on `GET /api/events` and
 * `GET /api/tunnel/status` alike (DOR-3650), so the stream and the route
 * answer the same callers. Only HTTP principals pass: a chat-platform button or
 * the session relay never reads front-door state. Kept apart from the inbox's
 * `operatorAudience` on purpose: front-door state may tighten on its own.
 *
 * @param principal - What the connection registered itself as.
 */
export function frontDoorReadAudience(principal: CallerPrincipal): boolean {
  return principal.kind === 'operator' || principal.kind === 'program';
}
