/**
 * Reading a Buzz channel's history forwards, gap-free, over a wall-clock filter.
 *
 * The port asks for the one thing NIP-01 does not offer: pages that run
 * oldest-first from a resume point, with exhaustion declared rather than
 * inferred. Buzz has no monotonic sequence anywhere, and its filters page by
 * `created_at` — whole seconds, assigned by the writing client
 * (`crates/buzz-relay/src/handlers/req.rs:873-882`). Two things follow, and this
 * module exists for both.
 *
 * **1. Ties.** Many messages share a second, so `created_at` alone cannot address
 * a position: a page boundary landing inside a tie silently drops the rest of it.
 * Buzz knows this — its own NIP-CW keyset is `(until, before_id)`, mandatory
 * both-or-neither, and half a cursor is a deterministic 400 rather than a
 * head request (`api/bridge.rs:404-455`). So the walk asks with an **inclusive**
 * `since` at the cursor's second, re-reads the whole tie, and discards what falls
 * at or before the cursor in the total order `(createdAt, id)`. A tie is never
 * split.
 *
 * **2. `limit` means different things at different ends.** NIP-01's convention is
 * that a limit returns the NEWEST matching events, which is the opposite of what
 * a forward page needs, and a relay implementing it as a plain SQL limit returns
 * the oldest. Rather than depend on which, the walk **detects the difference**: a
 * page that came back saturated may have dropped rows at the bottom of the
 * window, so if its oldest row is still above the cursor the window is narrowed
 * and the read repeats, accumulating downward until the window's floor reaches
 * the cursor. Under either semantic the result is the same complete set. The
 * conformance suite runs against both, and once more with a page size small
 * enough that every read is saturated — which is what makes that claim checkable
 * rather than asserted, and is how the off-by-one in the first narrowing (an
 * inclusive `until` set to the second it was already at, so the walk stood still)
 * was caught.
 *
 * **What this costs, honestly.** Under newest-first semantics, reading the oldest
 * page of a deep room walks down through it. That is the price of using one
 * transport; Buzz's own gap-free keyset lives on HTTP `POST /query` behind NIP-98
 * (`bridge.rs:404-455`), and a write-capable adapter that already speaks HTTP
 * should adopt it. A read-only adapter that added a second transport, a second
 * auth scheme and a second failure mode to save round trips on rooms it cannot
 * write to would be paying more than it saves. When the walk cannot finish inside
 * its step budget it **throws**, loudly, rather than returning a short page that
 * would look exactly like exhaustion.
 *
 * @module server/services/communities/buzz/buzz-history
 */
import { comparePositions, type BuzzPosition } from './buzz-cursor.js';
import type { NostrEvent, NostrFilter } from './buzz-protocol.js';

/** Rows to ask for per read. Buzz clamps a filter's limit to 2000 (`req.rs:25`). */
export const DEFAULT_RAW_LIMIT = 500;

/**
 * The relay's own cap on a filter's `limit` (`crates/buzz-relay/src/handlers/req.rs:25`).
 *
 * **`rawLimit` must stay strictly below this**, and the tie read is why: it asks
 * for `rawLimit + 1` rows so that "this second is bigger than a page" is a fact
 * rather than a guess. A `rawLimit` at or above the clamp makes that extra row
 * unaskable — the relay would silently return `rawLimit` either way — and the
 * walk would step below a second it had not finished reading. The guard below
 * refuses that configuration instead of walking into it.
 */
export const RELAY_LIMIT_CLAMP = 2000;

/** How many times the walk may narrow its window before giving up loudly. */
export const DEFAULT_MAX_STEPS = 64;

/** Everything {@link walkHistoryAfter} needs. */
export interface WalkHistoryOpts {
  /**
   * Run one historical read.
   *
   * @param filter - The filter to send.
   */
  fetch: (filter: NostrFilter) => Promise<NostrEvent[]>;
  /** Kinds and scope — everything about the filter except its window. */
  base: NostrFilter;
  /** Exclusive lower bound; only events strictly after this are returned. */
  after: BuzzPosition;
  /**
   * Rows to ask for per read. Defaults to {@link DEFAULT_RAW_LIMIT}, and must
   * stay below {@link RELAY_LIMIT_CLAMP} — see that constant for why the bound is
   * load-bearing rather than tidy.
   */
  rawLimit?: number;
  /** Window narrowings allowed. Defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
}

/**
 * Every event strictly after a position, in ascending `(createdAt, id)` order.
 *
 * The result is complete for the window `[after, newest-at-call-time]` or the
 * call throws. There is no partial success: a short answer and an exhausted one
 * are indistinguishable to a caller, which is the failure the port's "exhaustion
 * is declared, never inferred" rule exists to prevent.
 *
 * @param opts - The fetch, the scope, and the resume point.
 * @throws {Error} When the history is deeper than the step budget, or when a
 *   single second holds more rows than one read can carry.
 */
export async function walkHistoryAfter(opts: WalkHistoryOpts): Promise<NostrEvent[]> {
  const rawLimit = opts.rawLimit ?? DEFAULT_RAW_LIMIT;
  if (rawLimit >= RELAY_LIMIT_CLAMP) {
    throw new Error(
      `a Buzz history page size must stay below the relay's own clamp of ${RELAY_LIMIT_CLAMP} ` +
        `(got ${rawLimit}): the tie read asks for one row more than a page, and it cannot ask for one the relay will not give`
    );
  }
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const collected = new Map<string, NostrEvent>();
  let floor = opts.after.createdAt;
  let ceiling: number | undefined;

  /**
   * Collect the whole of one second, refusing if it is bigger than a read can
   * carry. Asking for one row MORE than a page holds is what turns "there is
   * more of this second" from a guess into a fact.
   */
  const takeWholeSecond = async (second: number): Promise<void> => {
    const tie = await opts.fetch({
      ...opts.base,
      since: second,
      until: second,
      limit: rawLimit + 1,
    });
    if (tie.length > rawLimit) {
      throw new Error(
        `a single second (${second}) in this Buzz channel holds more than ${rawLimit} events; ` +
          'the window cannot be stepped past it without splitting a tie'
      );
    }
    for (const event of tie) collected.set(event.id, event);
  };

  for (let step = 0; step <= maxSteps; step += 1) {
    const page = await opts.fetch({
      ...opts.base,
      since: floor,
      ...(ceiling === undefined ? {} : { until: ceiling }),
      limit: rawLimit,
    });
    for (const event of page) collected.set(event.id, event);

    // UNDER-FULL MEANS COMPLETE, whichever end the relay's limit favours — and
    // it is the only signal in this walk that does not depend on knowing which.
    // Every ceiling below is lowered only after everything above it is in hand,
    // so a complete window here is a complete read.
    if (page.length < rawLimit) return after(collected, opts.after);

    const ordered = ascending(page);
    const lowest = ordered[0]!.created_at;
    const highest = ordered.at(-1)!.created_at;
    await takeWholeSecond(highest);

    // WHICH END DID THE RELAY GIVE US? A saturated page cannot say: two rows at
    // the bottom of the window and two at the top look identical from here. So
    // ask — one row above this page, inside the same window. Nothing above means
    // the page is the window's top and what is missing lies underneath; anything
    // above means the page is its bottom. This probe is why the walk does not
    // have to know how a relay reads `limit`, and it is the whole difference
    // between a correct read and one that silently returns a prefix.
    const above = await opts.fetch({
      ...opts.base,
      since: highest + 1,
      ...(ceiling === undefined ? {} : { until: ceiling }),
      limit: 1,
    });

    if (above.length > 0) {
      floor = highest + 1;
      ceiling = undefined;
      continue;
    }

    await takeWholeSecond(lowest);
    // The page spans the whole window, top to bottom: there is nothing left.
    if (lowest <= floor) return after(collected, opts.after);
    ceiling = lowest - 1;
  }

  throw new Error(
    `this Buzz channel's history is deeper than ${maxSteps} windows of ${rawLimit}; ` +
      "a gap-free read from this position needs the relay's NIP-CW keyset over HTTP"
  );
}

/**
 * Sort ascending in the total order `(createdAt, id)`.
 *
 * @param events - The events to order.
 */
export function ascending(events: readonly NostrEvent[]): NostrEvent[] {
  return [...events].sort((a, b) => comparePositions(positionOf(a), positionOf(b)));
}

/**
 * One event's position in its room's total order.
 *
 * @param event - The event.
 */
export function positionOf(event: NostrEvent): BuzzPosition {
  return { createdAt: event.created_at, eventId: event.id };
}

/**
 * Order what was collected and drop everything at or before the resume point.
 *
 * @param collected - Events by id, deduplicated across overlapping windows.
 * @param from - The exclusive lower bound.
 */
function after(collected: Map<string, NostrEvent>, from: BuzzPosition): NostrEvent[] {
  return ascending([...collected.values()]).filter(
    (event) => comparePositions(positionOf(event), from) > 0
  );
}
