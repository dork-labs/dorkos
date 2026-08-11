/**
 * The dispatch correlation context, carried across one dispatch's async chain.
 *
 * The alternative was threading a `dispatchId` parameter through forty
 * functions, which would not survive review and would fight the detached-turn
 * shape ADR-0264 requires besides. One `AsyncLocalStorage`, entered once per
 * dispatch, gets the id to the file reporter — so **every existing log line
 * inside the chain gains correlation without being edited**. That retrofit is
 * the whole reason this module is worth its existence: hundreds of call sites,
 * for the price of one `run()`.
 *
 * ## Where the context is provably lost
 *
 * ALS does not reach work the runtime scheduled outside the scope. Three
 * boundaries, and all three are accepted rather than discovered:
 *
 * | Boundary                             | Behaviour                                | Verdict                                                          |
 * | ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------- |
 * | SSE fan-out to `/events` subscribers | Runs in each subscriber's request context | Accepted — the subscriber is not the thing being diagnosed       |
 * | The relay bus                        | A new envelope, possibly a new process    | Handled by the envelope's own `dispatchId` field, not by ALS      |
 * | Timers registered at module load     | No scope                                  | Not on the dispatch path                                          |
 *
 * ## The two scoping rules
 *
 * 1. {@link runInDispatch} must wrap the CONSTRUCTION of a detached async
 *    chain, not an `await` that settles before the chain does. An async
 *    generator created inside a scope keeps that scope for its whole life, so a
 *    turn that outlives its HTTP response stays correlated — but a scope placed
 *    around only the awaited part expires at the response and correlates
 *    nothing.
 * 2. Work that is STORED now and CALLED later must carry a
 *    {@link captureDispatchScope} snapshot. ALS follows the call chain, and a
 *    stored closure's later call chain belongs to whoever invoked it — which,
 *    for a message waiting behind a running turn, is the turn AHEAD of it. That
 *    was DOR-1159: three messages, three ids, and every line after the first
 *    turn logged under the first id.
 *
 * @module lib/dispatch-context
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where a dispatch came from, for grouping.
 *
 * `queue-recovery` is the odd one out and deliberately so: it is not a caller
 * but the server picking up words a previous process was told it had accepted.
 * Nobody is waiting on the other end of it, which is exactly why it needs a
 * label of its own — a turn that started for no visible reason is the hardest
 * kind to explain during an incident.
 */
export type DispatchOrigin = 'room' | 'session' | 'task' | 'relay' | 'queue-recovery';

/** The correlation context carried across one dispatch's async chain. */
export interface DispatchContext {
  /** Opaque `dsp_`-prefixed correlation id. Never content-derived. */
  readonly dispatchId: string;
  /** Coarse origin of the dispatch, for grouping. */
  readonly origin: DispatchOrigin;
  /** The room entry this dispatch answers, when the origin is a room. */
  readonly entryId?: string;
}

/**
 * Module-private, and deliberately the only one. A second store would be a
 * second answer to "which dispatch is this", and the reporter can only read one.
 */
const storage = new AsyncLocalStorage<DispatchContext>();

/**
 * Run `fn` with a dispatch context bound to the current async chain.
 *
 * Called ONCE per dispatch — at a turn ingress — never per event. Everything
 * `fn` creates, including generators it never awaits, inherits the context.
 *
 * @param ctx - The context this dispatch is identified by.
 * @param fn - The work to run inside it.
 * @returns Whatever `fn` returns.
 */
export function runInDispatch<T>(ctx: DispatchContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Freeze the current async context so work stored now runs inside it later.
 *
 * The answer to rule 2 above. A closure parked in a map and called minutes
 * later by unrelated machinery inherits THAT machinery's context, because ALS
 * is a property of the call chain and a closure does not carry one. The
 * snapshot is the missing carrier: taken where the work was accepted, applied
 * where it finally runs.
 *
 * It captures every `AsyncLocalStorage` in play, not only this module's, which
 * is the point rather than an accident — applying it REPLACES the caller's
 * context wholesale, so a queued turn cannot inherit stray scope from the turn
 * that happened to release it either.
 *
 * @returns A runner that executes `fn` inside the context captured here.
 */
export function captureDispatchScope(): <T>(fn: () => T) => T {
  return AsyncLocalStorage.snapshot();
}

/**
 * The active dispatch context, or `undefined` outside any dispatch.
 *
 * @returns The context bound to the current async chain.
 */
export function currentDispatch(): DispatchContext | undefined {
  return storage.getStore();
}

/**
 * The active dispatch id, or `undefined` outside any dispatch.
 *
 * The convenience the log reporter and the span call sites use, so neither has
 * to know the context has other fields.
 *
 * @returns The id bound to the current async chain.
 */
export function currentDispatchId(): string | undefined {
  return storage.getStore()?.dispatchId;
}
