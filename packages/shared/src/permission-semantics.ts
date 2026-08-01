/**
 * What a permission mode means, computed from what the runtime said it does.
 *
 * ## The table this replaces
 *
 * Every surface that warned about a permission mode used to answer from a list
 * of mode ids kept in the client — one list for "this is a bypass mode", another
 * for "tint this red". A list like that is right until a runtime ships a mode
 * nobody added to it, and then it is quietly, invisibly wrong: the status line
 * warns, the banner does not, and neither is checkable from the runtime's own
 * behavior.
 *
 * So the runtime declares its semantics on every mode it offers
 * (`PermissionModeDescriptor.stop` / `asks` / `reach` / `promise`), and these
 * functions are the only rules the client applies to them. No runtime names, no
 * mode-id membership — a new runtime is described correctly the day it declares
 * itself, without a client release (spec `trust-dial`, decision 2).
 *
 * Pure and descriptor-shaped on purpose: no hooks, no queries. The caller
 * resolves the descriptor from the runtime's capability profile and passes it
 * in, which is what lets one rule serve the status line, the banner, the scope
 * note, and the session rail.
 *
 * ## Why `shared` and not `apps/client`
 *
 * The rules are the client's to apply, but they are only *true* if they agree
 * with what the runtimes actually declare — and no test inside `apps/client` can
 * import a runtime's capability profile to check. Parking the rules here lets
 * the server's own test run every declared mode of every runtime through the
 * real functions instead of a restatement of them
 * (`apps/server/src/services/runtimes/__tests__/permission-semantics.test.ts`).
 * The client re-exports them from `layers/shared/lib`, so client code has one
 * import path as before.
 *
 * @module shared/permission-semantics
 */
import type { PermissionAsks, PermissionModeDescriptor, PermissionStop } from './agent-runtime.js';

/**
 * How severely a surface should mark a mode. Deliberately three values and not
 * a boolean: "never asks" and "never asks about anything, anywhere" are
 * different promises, and flattening them trains people to read neither.
 *
 * - `'danger'` — never asks, and can reach anything on the machine.
 * - `'caution'` — never asks, within a bounded reach.
 * - `'none'` — the mode still stops for the person; nothing to mark.
 */
export type TrustWarnTier = 'danger' | 'caution' | 'none';

/**
 * What each dial position promises about asking, before any runtime speaks.
 * The canonical expectation — a runtime that cannot meet it is not corrected,
 * it is reported ({@link isDivergent}).
 */
const STOP_EXPECTATION: Record<PermissionStop, PermissionAsks> = {
  ask: 'always',
  act: 'when-risky',
  autonomy: 'never',
};

/**
 * The asking behavior a dial position promises. The stop words are fixed across
 * runtimes, so this is the sentence a person is entitled to expect from the
 * position they picked, whichever agent is behind it.
 *
 * @param stop - A dial position.
 */
export function stopExpectation(stop: PermissionStop): PermissionAsks {
  return STOP_EXPECTATION[stop];
}

/**
 * How much asking each value represents, so two can be compared. Asking more
 * often is never the surprise a caption has to warn about; asking less is.
 */
const ASKS_RANK: Record<PermissionAsks, number> = {
  always: 2,
  'when-risky': 1,
  never: 0,
};

/**
 * Whether this runtime's mode asks LESS than its dial position promises —
 * Codex's workspace-write sitting at "act, ask when risky" while never asking at
 * all, because Codex has no way to pause mid-turn.
 *
 * Divergence is a fact to SAY, not a thing to hide: the stop words stay fixed
 * and the caption carries the difference (spec `trust-dial`, decision 2A).
 *
 * Two deliberate narrowings, both of which exist so the caption's emphasis lands
 * only where a person could actually be caught out:
 *
 * 1. **Directional.** Only asking less than promised counts. A runtime that
 *    stops more often than its position pledged has over-delivered on safety,
 *    and flagging that would teach people the flag means "unusual" rather than
 *    "this will do more than you agreed to".
 * 2. **A mode that cannot act cannot break an asking promise.** Codex's
 *    read-only default technically never asks — because it has nothing to ask
 *    about; it cannot write a file, run a command, or reach the network. Plain
 *    inequality marks the safest setting on offer as promise-breaking, which
 *    would put the caption's amber on it. So `reach: 'read'` is excluded.
 *
 * The pairing that matters is pinned in the server's cross-runtime test: Codex's
 * `workspace-write` diverges, Codex's read-only default does not.
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function isDivergent(descriptor: PermissionModeDescriptor): boolean {
  if (descriptor.reach === 'read') return false;
  return ASKS_RANK[descriptor.asks] < ASKS_RANK[stopExpectation(descriptor.stop)];
}

/**
 * How loudly to mark a mode, from what it does rather than what it is called.
 *
 * A mode earns red for exactly one combination — it never asks AND it can reach
 * the whole machine — because that is the one a person cannot walk back. Never
 * asking inside a bounded reach is worth a quieter mark. A mode that only reads
 * gets nothing at all: it may never ask, but it has nothing to ask about, and
 * warning about the safest setting on offer is how a warning stops being read.
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function warnTier(descriptor: PermissionModeDescriptor): TrustWarnTier {
  if (descriptor.asks !== 'never') return 'none';
  if (descriptor.reach === 'everything') return 'danger';
  if (descriptor.reach === 'read') return 'none';
  return 'caution';
}

/**
 * Whether a mode hands the agent the keys — runs any tool, anywhere, without
 * asking. The semantic replacement for the old id list, and the authoritative
 * answer wherever the runtime's profile is in hand: the standing banner, the
 * status line's severity, and the scope note beside every mode picker must all
 * agree, or one session warns on one surface and looks ordinary on another
 * (DOR-482, DOR-463, DOR-501).
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function isBypassSemantics(descriptor: PermissionModeDescriptor): boolean {
  return descriptor.asks === 'never' && descriptor.reach === 'everything';
}
