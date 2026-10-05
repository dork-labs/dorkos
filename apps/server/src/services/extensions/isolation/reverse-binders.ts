/**
 * How the host carries each `reverse` member of the ctx protocol table
 * (DOR-2686, spec §5 and §8): the account advisor, the inbox action handler
 * and agent tool handlers. Each binder registers a host-side stand-in on the
 * extension's REAL ctx that calls the child's function through
 * {@link CtxDispatcher.rcall}.
 *
 * A test asserts every `reverse` leaf of the table has a binder here, so a
 * reverse member cannot be added to the table without deciding how the host
 * carries it.
 *
 * @module services/extensions/isolation/reverse-binders
 */
import type {
  AccountAdvisor,
  DataProviderContext,
  DecisionActionEvent,
} from '@dorkos/extension-api/server';
import { ADVISOR_METHODS, type AdvisorMethodName } from './ctx-protocol.js';
import type { CtxDispatcher } from './ctx-dispatcher.js';
import type { WireError } from './ipc-protocol.js';

/** A refusal the binder decides itself: a plain error with no host detail. */
function refusal(message: string): WireError {
  return { name: 'Error', message };
}

/** What an `expose` message said about the function, beyond its path. Untrusted. */
export interface ExposeDetail {
  /** An advisor's methods. */
  methods?: unknown;
  /** A tool's name. */
  name?: unknown;
}

/**
 * Binds a child's exposed function onto the real ctx. Each returns the
 * unregister function the real ctx hands back.
 */
export type ReverseBinder = (
  dispatcher: CtxDispatcher,
  ctx: DataProviderContext,
  exposeId: number,
  boundMs: number,
  detail: ExposeDetail
) => (() => void) | WireError;

/** How each `reverse` table entry is bound, by its dotted path. */
export const REVERSE_BINDERS: Readonly<Record<string, ReverseBinder>> = Object.freeze({
  'accounts.registerAdvisor': (dispatcher, ctx, exposeId, boundMs, { methods }) => {
    if (
      !Array.isArray(methods) ||
      methods.length === 0 ||
      methods.length > ADVISOR_METHODS.length ||
      !methods.every(
        (m): m is AdvisorMethodName =>
          typeof m === 'string' && (ADVISOR_METHODS as readonly string[]).includes(m)
      ) ||
      new Set(methods).size !== methods.length ||
      !methods.includes('rank')
    ) {
      return refusal('An account advisor needs a rank method, and only advisor methods.');
    }
    // Exactly the methods the child's advisor has: core treats a missing
    // method as "use the default", so a proxy must not invent one.
    const advisor: Partial<Record<AdvisorMethodName, (...args: unknown[]) => Promise<unknown>>> =
      Object.create(null);
    for (const method of methods) {
      advisor[method] = (...args: unknown[]) => dispatcher.rcall(exposeId, method, args, boundMs);
    }
    return ctx.accounts.registerAdvisor(advisor as unknown as AccountAdvisor);
  },
  'inbox.onAction': (dispatcher, ctx, exposeId, boundMs) =>
    ctx.inbox.onAction(
      (event: DecisionActionEvent) =>
        dispatcher.rcall(exposeId, 'onAction', [event], boundMs) as ReturnType<
          Parameters<DataProviderContext['inbox']['onAction']>[0]
        >
    ),
  // A tool (spec §8): bound through the REAL ctx.tools.handle, so the host's
  // own copy of the manifest decides (undeclared, refused, twice, after
  // register() finished all throw the in-process words), and only a tool the
  // host bound can ever be contributed. The stub carries no deadline of its
  // own: the host wrapper's per-tool deadline, cancellation and stop abort
  // `call.signal`, which cancels the child's call and settles at once.
  'tools.handle': (dispatcher, ctx, exposeId, boundMs, { name }) => {
    if (typeof name !== 'string') return refusal("A tool binding needs the tool's name.");
    ctx.tools.handle(name, (input, call) =>
      dispatcher.rcall(exposeId, 'tool', [input, { agentId: call.agentId }], boundMs, call.signal)
    );
    // A bound tool is never unbound: it ends with this instance (the
    // lifecycle removes it from the registry first on every stop).
    return () => undefined;
  },
});
