/**
 * Which inbound envelope a running agent turn is answering, so the messages
 * that turn sends continue that envelope's budget instead of minting a new one.
 *
 * ## The hole this closes
 *
 * `relay_send`'s `budget` argument is optional, and a publish that omits one
 * gets a FRESH full budget from `createDefaultBudget`. So the hop counter and
 * the call budget reset at every agent: A messages B, B's turn calls
 * `relay_send` back to A with no budget, A's turn calls `relay_send` back to B,
 * and the envelope bound that was supposed to stop the loop never decrements
 * past one. Asking the model to pass the budget through does not fix it — a
 * budget the model may omit is a budget an accidental loop always omits, and a
 * budget the model may WRITE is not a bound at all. The association has to be
 * made server-side.
 *
 * ## How the association is made
 *
 * The adapter that dispatches a turn already knows both halves: the envelope it
 * is delivering, and the session key it is delivering into. It binds the two
 * here for the life of the turn, and the `relay_send*` tool handlers — which run
 * inside that turn and are told, by the server, which session they belong to —
 * read the binding back. Nothing is read from tool arguments, which is the same
 * reasoning `resolveSenderIdentity` applies to the publish `from`.
 *
 * The budget bound here is the one the adapter received, which the publish
 * gate has ALREADY decremented for this hop. So an outbound send inherits it as
 * its starting point and the gate decrements it again — one hop per turn, which
 * is what a hop is.
 *
 * ## Lifetime
 *
 * A binding lasts as long as the turn — with one deliberate exception. A turn
 * killed by its own TTL keeps its binding, still carrying the deadline that just
 * passed, because the iteration stopping is not proof the query stopped: a send
 * that landed in that window and inherited NOTHING would mint a fresh full
 * budget, which is the chain escaping on exactly the deadline meant to end it.
 * Inheriting a dead budget gets it refused at the publish gate instead. Those
 * held entries are what {@link TRACKED_SESSIONS} bounds.
 *
 * {@link InboundTurnBudgets.bind} returns its own release so the adapter cannot
 * forget which key it registered, and re-binding a key that is already bound
 * simply replaces it: a session that receives a second envelope is answering the
 * second one.
 *
 * Sessions are keyed by string, and the key is whatever the host uses for both
 * sides. A key nobody registered reads as "no inbound envelope", which is the
 * pre-existing behaviour — a turn a person started by typing has no budget to
 * inherit and mints a fresh one, correctly.
 *
 * @module relay/inbound-turn-budgets
 */
import type { RelayBudget } from '@dorkos/shared/relay-schemas';

/**
 * How many bindings to keep before dropping the least recently bound.
 *
 * Almost every binding is released when its turn ends, so this cap is not what
 * bounds ordinary use — it bounds the one case that deliberately does NOT
 * release: a TTL-aborted turn holds its (expired) budget so a late send cannot
 * mint a fresh one, and that entry waits for the session's next inbound message
 * to replace it, which may never come.
 *
 * Eviction is safe in the direction it fails: a forgotten binding reads as "no
 * inbound envelope", which is what an unbound session already reads as. It can
 * forget a bound, never invent one.
 */
const TRACKED_SESSIONS = 256;

/**
 * The live map of session key → the budget of the envelope that session is
 * currently answering.
 *
 * One instance per process, constructed by the host and handed to both sides
 * (the dispatching adapter and the tool surface). Deliberately NOT a module
 * singleton: two relays in one process — which the tests do routinely — must not
 * share one map.
 */
export class InboundTurnBudgets {
  private readonly bound = new Map<string, RelayBudget>();

  /**
   * Record that `sessionKey` is answering an envelope carrying `budget`.
   *
   * @param sessionKey - The session key the turn runs under.
   * @param budget - The inbound envelope's budget, as the adapter received it
   *   (already decremented for this hop by the publish gate).
   * @returns A release function. Call it when the turn ends, in a `finally`.
   */
  bind(sessionKey: string, budget: RelayBudget): () => void {
    // Re-inserted rather than updated in place, so the Map's insertion order is
    // least-recently-bound first and eviction below is one `keys().next()`.
    this.bound.delete(sessionKey);
    this.bound.set(sessionKey, budget);
    if (this.bound.size > TRACKED_SESSIONS) {
      const oldest = this.bound.keys().next().value;
      if (oldest !== undefined) this.bound.delete(oldest);
    }
    let released = false;
    return () => {
      // Idempotent, and it only releases ITS OWN binding: a second envelope that
      // arrived while this turn was ending has replaced the entry, and a late
      // release must not delete the newer turn's inheritance.
      if (released) return;
      released = true;
      if (this.bound.get(sessionKey) === budget) this.bound.delete(sessionKey);
    };
  }

  /**
   * The budget the given session's turn should continue, if it is answering one.
   *
   * @param sessionKeys - The session keys to look up. Callers may hold more
   *   than one candidate id for a session (a trigger id and the SDK's canonical
   *   id); pass them in preference order. `undefined` entries are skipped.
   * @returns The inbound budget, or `undefined` when this turn is not answering
   *   a relay envelope.
   */
  get(...sessionKeys: (string | undefined)[]): RelayBudget | undefined {
    for (const key of sessionKeys) {
      if (key === undefined) continue;
      const budget = this.bound.get(key);
      if (budget) return budget;
    }
    return undefined;
  }

  /** How many turns are currently bound. Diagnostics and tests only. */
  get size(): number {
    return this.bound.size;
  }
}
