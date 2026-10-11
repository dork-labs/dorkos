/** One reservation in a session's turn chain. */
interface TurnSlot {
  /**
   * Resolves when every turn the SAME client reserved earlier on the SAME
   * session has settled, or when the wait bound elapses — whichever comes first.
   * Never rejects: a failed turn releases its slot like any other, so one bad
   * turn cannot wedge the chain behind it.
   */
  readonly ready: Promise<void>;
  /**
   * Mark this turn settled so the next waiter may run. Idempotent.
   *
   * The caller MUST reach this on every exit path — a refused lock and a throw
   * before the turn is launched included — or every later turn this client sends
   * to this session waits for the full bound before it can proceed.
   */
  release(): void;
}

/**
 * Separator between the two halves of a chain key.
 *
 * NUL, because a client id arrives in the `X-Client-Id` header and is therefore
 * whatever the caller chose to send. A printable separator lets a crafted id
 * collide with another session's chain — `"a b"` + `"c"` and `"a"` + `"b c"`
 * produce the same key with a space — which would silently serialize (or fail
 * to serialize) two unrelated sessions. Node rejects a header value containing
 * NUL before it reaches a route, so no id can carry one.
 */
const TURN_QUEUE_KEY_SEP = '\u0000';

/**
 * Serializes turn triggers per (session, client) — subtlety 5 above.
 *
 * A second trigger from the same client is not a mistake to refuse: the person
 * typed that message for this session and meant it. So it WAITS, in a promise
 * chain of the shape `RuntimeAdapter.enqueueForSession` uses in `@dorkos/relay`
 * (ADR-0075), and runs the instant the turn ahead of it settles.
 *
 * **Why the key carries the client id.** Refusing a second CLIENT is the lock's
 * job, and that behavior is deliberate: a second client's POST is a 409 naming
 * the holder while the turn is alive, and an accepted takeover once the holder
 * goes dark (otherwise a crashed turn would own the session until its TTL).
 * Making a second client wait here would turn a refusal into a hang and delete
 * the takeover path. Different clients therefore never queue behind each other;
 * they meet at the lock exactly as before.
 *
 * **Why a chain can be reached by more than one id.** A live session answers to
 * every id it has ever held: the request UUID the client first used, plus the
 * canonical id the runtime assigns mid-first-turn. The runtime resolves both to
 * one session, so keying a chain on the raw request id let the same tab's second
 * POST — sent under the canonical id it just read off the 202 — miss the chain
 * its own first turn was standing in and start a second stream into one
 * projector (DOR-1088 review, G4). {@link link} points the newly-learned id at
 * the chain that already exists, and callers resolve through {@link primaryOf}.
 *
 * @internal Exported for testing only — {@link triggerTurn} owns the one instance.
 */
export class SessionTurnQueue {
  /** Tail of each live chain, keyed by session+client; dropped when it drains. */
  private readonly tails = new Map<string, Promise<void>>();
  /** Later-learned session id → the session id its chain is filed under. */
  private readonly aliases = new Map<string, string>();

  /** The session id `sessionId`'s chain is filed under (itself, unless aliased). */
  private primaryOf(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  /**
   * Record that `aliasId` names the same live session as `primaryId`, so a
   * trigger arriving under either id joins one chain.
   *
   * Idempotent, and safe to call with ids already linked; a self-link is
   * ignored. Aliases are dropped when the session's last chain drains.
   *
   * @param aliasId - The newly-learned id (the runtime's canonical id).
   * @param primaryId - The id the existing chain is filed under.
   */
  link(aliasId: string, primaryId: string): void {
    const primary = this.primaryOf(primaryId);
    if (aliasId === primary) return;
    this.aliases.set(aliasId, primary);
  }

  /**
   * Reserve the next slot in `(sessionId, clientId)`'s chain.
   *
   * Registration is synchronous, so two triggers arriving in the same tick are
   * ordered by arrival: the second sees the first's tail and queues behind it
   * instead of racing it.
   *
   * @param sessionId - The session whose turns are being serialized; resolved
   *   through any alias recorded by {@link link}.
   * @param clientId - The lock identity triggering the turn.
   * @param maxWaitMs - How long this reservation may wait for the turns ahead of
   *   it before proceeding anyway. The bound exists because the write-lock has a
   *   TTL and the chain does not: without it, a turn that went dark handed the
   *   session to any STRANGER one TTL later while its own client's queued turn
   *   waited on a slot that would never be released (DOR-1088 review, G1c). A
   *   waiter released by the bound still meets the lock, so it proceeds only if
   *   the lock is genuinely free — it gets the same answer a stranger would, at
   *   the same moment.
   * @returns The slot to await ({@link TurnSlot.ready}) and release.
   */
  reserve(sessionId: string, clientId: string, maxWaitMs: number): TurnSlot {
    const primary = this.primaryOf(sessionId);
    const key = `${primary}${TURN_QUEUE_KEY_SEP}${clientId}`;
    const previous = this.tails.get(key);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // Head of the chain: nothing to wait for, and no timer to arm.
    let ready: Promise<void>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (previous === undefined) {
      ready = Promise.resolve();
    } else {
      ready = Promise.race([
        previous,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    }
    // The next reservation waits for THIS one to settle, and for our own wait to
    // be over — so a slot released by the bound above does not make its
    // successor inherit an unbounded wait on a predecessor that never settles.
    const tail = ready.then(() => settled);
    this.tails.set(key, tail);

    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        settle();
        // Only the CURRENT tail may drop the entry; a later reservation has
        // already chained onto ours and must keep its place in the map.
        if (this.tails.get(key) === tail) {
          this.tails.delete(key);
          this.pruneAliases(primary);
        }
      },
    };
  }

  /** Drop `primary`'s aliases once no client has a live chain on it. */
  private pruneAliases(primary: string): void {
    const prefix = `${primary}${TURN_QUEUE_KEY_SEP}`;
    for (const key of this.tails.keys()) {
      if (key.startsWith(prefix)) return;
    }
    for (const [alias, target] of this.aliases) {
      if (target === primary) this.aliases.delete(alias);
    }
  }

  /** How many chains are live. Zero once every reserved slot has been released. */
  get size(): number {
    return this.tails.size;
  }

  /** How many alias links are held. Zero once every aliased session goes quiet. */
  get aliasCount(): number {
    return this.aliases.size;
  }
}
