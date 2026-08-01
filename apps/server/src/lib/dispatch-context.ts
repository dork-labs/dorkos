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
 * ## The one scoping rule
 *
 * {@link runInDispatch} must wrap the CONSTRUCTION of a detached async chain,
 * not an `await` that settles before the chain does. An async generator created
 * inside a scope keeps that scope for its whole life, so a turn that outlives
 * its HTTP response stays correlated — but a scope placed around only the
 * awaited part expires at the response and correlates nothing.
 *
 * @module lib/dispatch-context
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Where a dispatch came from, for grouping. */
export type DispatchOrigin = 'room' | 'session' | 'task' | 'relay';

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
