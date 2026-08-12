/**
 * Per-session request sequencer for enqueue POSTs (DOR-1165).
 *
 * Each queued message is its own `POST /sessions/:id/messages` with
 * `disposition: 'queue'`, and the server orders the queue by the order it
 * ACCEPTS those requests. Two POSTs fired ~20ms apart — a fast typist, or a
 * paste-and-Enter hammer — can be accepted out of keystroke order when the
 * network reorders them, so the queue ends up holding what the person typed
 * transposed. The e2e helper sidesteps this by serializing its sends; the
 * product did not.
 *
 * This chains a session's enqueue requests so request N+1 is not fired until
 * request N has SETTLED. That is REQUEST ordering, not queue STATE: it holds no
 * message bodies, no ordering of its own, and never gates on turn status — it is
 * emphatically NOT a revival of the local FIFO queue removed in DOR-1161. All it
 * keeps is one pending promise per session (the tail of the chain), and it drops
 * even that once the chain drains.
 *
 * A rejected request must never wedge the session: the next request runs whether
 * the previous one fulfilled or rejected (`prior.then(run, run)`), and the tail
 * is reset when it settles either way rather than only on success — so one failed
 * POST costs its own message and nothing after it.
 *
 * @module features/chat/lib/enqueue-sequencer
 */

/**
 * Per-session tail of the enqueue chain. Present only while a session has a
 * request in flight (or queued behind one); deleted the moment the chain drains,
 * so this map never grows past the set of sessions actively being typed into.
 */
const tails = new Map<string, Promise<unknown>>();

/**
 * Run `send` after this session's previous enqueue request has settled, so the
 * server accepts them in the order they were called.
 *
 * The returned promise resolves (or rejects) with `send`'s own outcome — the
 * caller awaits the real POST, not the sequencing bookkeeping. Ordering is
 * established at CALL time: invoke this synchronously, in keystroke order, before
 * any per-message `await`, and the chain preserves that order regardless of how
 * long any individual request takes.
 *
 * @param sessionId - The session whose enqueue POSTs are being ordered.
 * @param send - Fires one enqueue request; called at most once, only after the
 *   prior request for this session has settled.
 * @returns `send`'s result — resolves/rejects exactly as the underlying request.
 */
export function sequenceEnqueue<T>(sessionId: string, send: () => Promise<T>): Promise<T> {
  // `prior` is always a TAIL, and a tail never rejects (see below) — so `send`
  // runs after the previous request settles, whatever its outcome.
  const prior = tails.get(sessionId) ?? Promise.resolve();
  const result = prior.then(send);
  // The tail is what the NEXT call chains off, and it must resolve whether this
  // request fulfilled OR rejected — both arms collapse to `undefined`. That is
  // the whole no-wedge guarantee: a failed POST settles the tail rather than
  // pinning it, so the next enqueue still fires (and the rejection stays with
  // `result`, this call's own return, never leaking onto the chain).
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  tails.set(sessionId, tail);
  void tail.then(() => {
    // Only clear the slot this call owns — a newer enqueue may already hold it.
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  });
  return result;
}
