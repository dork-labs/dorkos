/**
 * What a live turn keeps when it is cleared, trimmed or replaced: the sign-in
 * cards a runtime's transcript has never heard of (DOR-1004), the bound on a
 * turn a chain of wake-ups keeps growing (DOR-1100), and the line a Stop leaves
 * for work still running (DOR-3285).
 *
 * Its own module so `session-stream-store.ts` stays within the size rule.
 *
 * @module entities/session/model/stream/live-turn-retention
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** The two event types that make up a sign-in card and its receipt (DOR-1004). */
const SIGNIN_CARD_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'mcp_signin_required',
  'mcp_signin_resolved',
]);

/**
 * The events a cleared turn keeps: a sign-in card, and the resolution that
 * turned it into a receipt (DOR-1004).
 *
 * Everything else a turn produced is in the reloaded history by the time this
 * runs, which is exactly why the turn is cleared. A sign-in is not: it was asked
 * for in DorkOS, it is answered minutes later in a browser tab, and the runtime's
 * own transcript has never heard of it. Clearing it with the rest would delete
 * the link a person walked away to use — the single most likely moment for them
 * to come back and look — and, once signed in, the only record in the whole
 * conversation of what they just authorized.
 *
 * BOTH halves are kept, unfiltered: the card carries the server name and the
 * disclosure, the resolution carries how it ended, and the fold needs the pair to
 * render either state. Grace is spent at `turn_start` ({@link carrySigninCards}),
 * not here — a history reload is not the conversation moving on.
 *
 * @param events - The settling turn's events.
 * @returns The events to keep, in their original order.
 */
export function retainOpenSigninCards(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => SIGNIN_CARD_EVENT_TYPES.has(event.type));
}

/**
 * The most events one live turn may hold on the client before the finished
 * windows behind it are dropped (DOR-1100).
 *
 * A turn used to be self-limiting: every `turn_start` reset it, so the only way
 * to grow was to keep streaming, and the server's own `RingBuffer` caps the
 * replayable turn at the same 200. A runtime-opened window appends instead, so a
 * chain of wake-ups — one background task waking the agent, whose work starts
 * another — accumulates until a reload trims it. Normally that reload lands
 * within a round trip and this never bites; if it fails or the chain outruns it,
 * this is the bound that keeps a long-lived tab from growing without limit.
 *
 * Matched to `RING_BUFFER_MAX_EVENTS` deliberately: past it the server could not
 * replay the turn to a reconnecting client either, so keeping more here would
 * hold events no cold hydrate could reproduce.
 */
export const MAX_LIVE_TURN_EVENTS = 200;

/**
 * Drop whole finished windows off the front of an over-long live turn, keeping
 * any sign-in card they held.
 *
 * Trims by WINDOW, never mid-window: half a window renders as a reply that
 * starts mid-sentence, which is worse than one that is missing. So an
 * over-budget turn gives up its oldest complete window and re-checks, and a
 * single window over budget on its own is left alone — there is nothing to drop
 * that would not be a lie.
 *
 * The oldest window does NOT always start at index 0: a retained sign-in card
 * sits ahead of it (`retainOpenSigninCards`, and the same card is why the trim
 * puts one back). Finding the first `turn_start` before looking for the next is
 * what makes the cut land a whole window later than that card, rather than on
 * the card itself — cutting there dropped nothing, and the cap silently stopped
 * applying for the rest of the session (DOR-1107).
 *
 * @param events - The live turn, possibly spanning several windows.
 */
export function boundLiveTurn(events: SessionEvent[]): SessionEvent[] {
  let kept = events;
  while (kept.length > MAX_LIVE_TURN_EVENTS) {
    const oldestWindow = kept.findIndex((event) => event.type === 'turn_start');
    if (oldestWindow === -1) break;
    const nextWindow = kept.findIndex(
      (event, index) => index > oldestWindow && event.type === 'turn_start'
    );
    // Nothing but the oldest window left: over budget on its own, and dropping
    // part of it would render a reply starting mid-sentence.
    if (nextWindow === -1) break;
    // Always strictly shorter — the dropped prefix holds that `turn_start`, and
    // only sign-in cards come back — so the loop cannot spin.
    kept = [...retainOpenSigninCards(kept.slice(0, nextWindow)), ...kept.slice(nextWindow)];
  }
  return kept;
}

/**
 * Drop everything before the CURRENTLY OPEN window, keeping any sign-in card the
 * dropped prefix held (DOR-1100).
 *
 * The preserve path exists for one situation — a new turn started while the
 * history reload was in flight, so clearing the turn would wipe events the
 * reload predates. It used to be able to keep the whole turn because a
 * `turn_start` reset it, which meant "the whole turn" and "the new window" were
 * the same thing. A runtime-opened window APPENDS instead (so the finished reply
 * does not blank while the agent wakes up), and that broke the equivalence: the
 * turn now also holds the FINISHED window's deltas, which the reload has just
 * supplied as canonical history. Preserving all of it renders the reply twice
 * for as long as the wake-up runs.
 *
 * So the preserve is narrowed to what the reload genuinely predates: the events
 * at or after the last `turn_start`. A sign-in card from the prefix still
 * survives, for the same reason it survives a full clear — the runtime's
 * transcript has never heard of it.
 *
 * @param events - The live turn, possibly spanning several windows.
 * @returns The current window, preceded by any sign-in card from before it.
 */
export function retainCurrentWindow(events: SessionEvent[]): SessionEvent[] {
  // Hand-rolled reverse scan: the client's `lib` target predates
  // `findLastIndex`, and one loop is cheaper than raising it for one call.
  let windowStart = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn_start') {
      windowStart = i;
      break;
    }
  }
  if (windowStart <= 0) return events;
  return [...retainOpenSigninCards(events.slice(0, windowStart)), ...events.slice(windowStart)];
}

/** The flow a sign-in card event belongs to. Both members carry `flowId`. */
function signinFlowIdOf(event: SessionEvent): string {
  return (event as Extract<SessionEvent, { type: 'mcp_signin_required' }>).flowId;
}

/**
 * Spend one `turn_start` of every carried sign-in card's grace, retiring the
 * ones that had already spent theirs (DOR-1004).
 *
 * The client half of the server projector's rule of the same name, and written
 * to be read beside it: signing in triggers a resume turn almost immediately, so
 * clearing the turn on its `turn_start` erased the receipt about a second after
 * it appeared. A card therefore survives exactly one `turn_start`, and the next
 * one retires it.
 *
 * The mark is CARRIED IN, not derived. Deriving it from the event list looked
 * tidier and was wrong: the reload path strips the very `turn_start` the
 * derivation read, so every reload restored the grace and the receipt became
 * permanent.
 *
 * @param events - The outgoing turn's events.
 * @param spentFlowIds - Flows whose grace was already spent.
 * @returns The events the new turn starts with (before its own `turn_start`),
 *   and the flows that have now spent their grace.
 */
export function ageSigninCards(
  events: SessionEvent[],
  spentFlowIds: readonly string[]
): { kept: SessionEvent[]; spentFlowIds: string[] } {
  const spent = new Set(spentFlowIds);
  const kept: SessionEvent[] = [];
  const nowSpent = new Set<string>();
  for (const event of events) {
    if (!SIGNIN_CARD_EVENT_TYPES.has(event.type)) continue;
    const flowId = signinFlowIdOf(event);
    // A flow that already had its turn goes, and is forgotten with it — nothing
    // accumulates across a long session.
    if (spent.has(flowId)) continue;
    kept.push(event);
    nowSpent.add(flowId);
  }
  return { kept, spentFlowIds: [...nowSpent] };
}

/** The two events that make up the line a Stop leaves for work still running. */
const WORK_LEFT_EVENT_TYPES: ReadonlySet<SessionEvent['type']> = new Set([
  'work_left_running',
  'work_left_ended',
]);

/**
 * The `work_left_*` events a person's next turn keeps (DOR-3285).
 *
 * They arrive after the stopped turn has ended, usually after its history
 * reload too, so the history on screen does not have the line yet. Clearing
 * them at the next `turn_start` would hide work still running until that turn
 * ended; carried, they stay until the reload that follows it supplies the line
 * from history, which is when `retainOpenSigninCards` lets them go.
 *
 * @param events - The outgoing turn's events.
 */
export function keptWorkLeft(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter((event) => WORK_LEFT_EVENT_TYPES.has(event.type));
}
