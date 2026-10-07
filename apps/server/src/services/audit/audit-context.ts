/**
 * Who is acting, carried across one request's or one tool call's async chain,
 * so a deep writer can record an audit event without every caller threading an
 * actor through (spec `audit-trail` §3.3).
 *
 * The same mechanism, and the same accepted limits, as `lib/dispatch-context.ts`:
 * one `AsyncLocalStorage`, entered at the edge, read wherever an action is
 * recorded. Three edges enter it:
 *
 * | Edge                                    | Actor                                   | Surface |
 * | --------------------------------------- | --------------------------------------- | ------- |
 * | Every HTTP request (`middleware/audit-actor.ts`) | the agent, program or person calling | `http` / `app` / `mcp` |
 * | A hand-registered MCP tool call (`core/mcp-tool-gate.ts`) | the calling agent, or unidentified | `mcp` |
 * | A capability invocation with an identity (`core/capabilities/registry.ts`) | that agent | `mcp` |
 *
 * ## The scope that must not leak
 *
 * An agent's turn is started by a request (a person's message) but runs detached
 * from it, and ALS follows the call chain, so anything the turn does inherits the
 * PERSON's scope unless something re-enters. That is why the two tool-call edges
 * above enter their own scope rather than trusting what is already there: the
 * agent calling a tool must be recorded as the agent, never as whoever sent the
 * message that woke it.
 *
 * @module services/audit/audit-context
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditActor, AuditEvent, AuditSurface } from '@dorkos/shared/audit-schemas';

/** Who is acting, and how they reached the server. */
export interface AuditActorContext {
  /** The stable actor. */
  readonly actor: AuditActor;
  /** Where the action came in. */
  readonly surface: AuditSurface;
  /** Which credential acted, hashed, when one did. */
  readonly credential?: AuditEvent['credential'];
  /** The session the action belongs to, when there is one. */
  readonly sessionId?: string;
}

const storage = new AsyncLocalStorage<AuditActorContext>();

/**
 * Run `fn` with `context` as the current actor. Whatever `fn` starts, sync or
 * async, sees it.
 *
 * @param context - Who is acting.
 * @param fn - The work to run under it.
 * @returns Whatever `fn` returns.
 */
export function runWithAuditActor<T>(context: AuditActorContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The actor of the current chain, or `undefined` outside any scope (startup,
 * timers, anything DorkOS does on its own).
 */
export function currentAuditActor(): AuditActorContext | undefined {
  return storage.getStore();
}
