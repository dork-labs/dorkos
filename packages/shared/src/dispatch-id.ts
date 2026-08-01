/**
 * The dispatch correlation id — the one key that joins every hop of a message's
 * life.
 *
 * A room entry, a claim, a `triggerTurn`, a runtime turn, a reply post and a
 * relay delivery are six events with six different id vocabularies. Before this
 * they shared no key, so reconstructing one exchange from the log was
 * timestamp-guessing: on 2026-07-31 a forty-one minute room exchange left three
 * log lines and no way to tie them together.
 *
 * `sessionId` cannot be that key. One room entry fans out to N agents, each on a
 * different session, and the session id that STARTS a turn is frequently not the
 * one that finishes it — the room mints a placeholder, the runtime hands back its
 * own canonical id, and a rekey reconciles them afterwards. During the window
 * where correlation matters most, the session id changes. A dispatch id does not.
 *
 * Four properties, each load-bearing:
 *
 * - **Prefixed** `dsp_`, so `grep dsp_` finds every correlated line in a file and
 *   a bare id pasted into an issue is self-describing.
 * - **A ULID**, so ids sort lexicographically by mint time and a plain `sort`
 *   recovers dispatch order.
 * - **Monotonic**, so two dispatches minted in the same millisecond still sort in
 *   the order they were minted.
 * - **Opaque and random.** It derives from nothing — not a path, not a name, not
 *   a session id. That is what makes it admissible as a span attribute under the
 *   no-PII allowlist (ADR 260711-154514 §4): there is no content to leak.
 *
 * It lives in `shared` rather than in the server because `packages/relay` needs
 * {@link isDispatchId} to validate the field an envelope carries across the bus.
 *
 * @module dispatch-id
 */
import { monotonicFactory } from 'ulidx';

/**
 * The `dsp_` prefix, exported so log tooling, docs, and the envelope validator
 * share one literal rather than three copies of a string.
 */
export const DISPATCH_ID_PREFIX = 'dsp_';

/**
 * Monotonic within the process, so two dispatches minted in the same
 * millisecond still sort in mint order. A fresh (non-monotonic) ULID would tie,
 * and a tie is exactly the ambiguity the sortable id was chosen to remove.
 */
const nextUlid = monotonicFactory();

/** The character count of a ULID's Crockford base32 body. */
const ULID_LENGTH = 26;

/** A well-formed dispatch id: the prefix, then a ULID's Crockford base32 alphabet. */
const DISPATCH_ID_PATTERN = new RegExp(`^${DISPATCH_ID_PREFIX}[0-9A-HJKMNP-TV-Z]{${ULID_LENGTH}}$`);

/**
 * Mint a new opaque, time-sortable dispatch correlation id.
 *
 * Called once per dispatch at a turn ingress — never per event, and never
 * re-minted mid-chain. A runtime handing back a canonical session id does not
 * change it; that stability is the entire point.
 *
 * @returns A fresh `dsp_`-prefixed id.
 */
export function newDispatchId(): string {
  return `${DISPATCH_ID_PREFIX}${nextUlid()}`;
}

/**
 * Whether a string is a well-formed dispatch id.
 *
 * The relay's inbound path uses this on a field that arrived from another
 * process: an envelope may carry anything, and a malformed value would become a
 * `traceId` that groups unrelated spans. Rejecting it mints a fresh id instead.
 *
 * @param value - The candidate string.
 * @returns `true` when `value` is `dsp_` followed by a ULID.
 */
export function isDispatchId(value: string): boolean {
  return DISPATCH_ID_PATTERN.test(value);
}
