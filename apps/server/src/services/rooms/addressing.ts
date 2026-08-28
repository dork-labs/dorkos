/**
 * Who a committed post should trigger (spec `rooms` §5).
 *
 * Pure — no database, no clock, no runtime. It answers one question about one
 * entry and a roster, which is what makes the matrix below testable in full.
 *
 * Addressing three agents and getting three answers is the intended outcome,
 * not a pathology. `responseMode` exists to stop an agent answering when it was
 * NOT addressed; it makes no attempt to order or serialise the ones who were.
 * Bounding a conversation that feeds itself is the cascade guard's job
 * (`cascade-guard.ts`), and it runs after this.
 *
 * `room-trigger.ts` is the production caller.
 *
 * @module server/services/rooms/addressing
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { AuthorKind, RoomKind } from '@dorkos/shared/room-schemas';

/** One member as addressing sees it. */
export interface AddressingMember {
  authorId: string;
  /** Only `agent` members are ever triggered. */
  kind: AuthorKind;
  /** This room's stored override, not the manifest default. */
  responseMode: ResponseMode;
  /**
   * Whether this member is still inside its engaged window here — the §9.2
   * predicate, already evaluated.
   *
   * A boolean rather than a query, because that predicate needs a clock and the
   * room log and this module has neither. `engagement.ts` computes it and
   * `room-trigger.ts` threads it in; every other mode ignores it.
   */
  isEngaged: boolean;
}

/**
 * WHY the matrix picked a member — the one thing a caller needs to know about a
 * selection beyond the fact that it happened.
 *
 * The matrix has always answered "who", and every caller has always had to
 * re-derive "why" if it wanted it. The response gate
 * (`response-gate/routing-rules.ts`) needs it and must not re-derive it: it
 * decides whether a turn is worth running at all, and a second reading of the
 * same roster half a second later could disagree with the first — an agent
 * routed to silence on the grounds that nobody addressed it, by a reading taken
 * after the reading that said somebody had.
 *
 * **`mention` is resolved before every other reason, and that ordering is the
 * safety property.** A named agent can never be classified as ambient by a later
 * rule, whatever its mode or window says, which is what keeps invariant I3
 * ("being asked creates an obligation") out of the gate's reach.
 */
export type TriggerReason =
  /** This entry named them. */
  | 'mention'
  /** Outside a channel, where a person's message addresses whoever is there. */
  | 'dm'
  /**
   * `engaged`, inside an open window, unnamed — somebody was talking to them
   * recently and has not said their name this time.
   *
   * The only reason the response gate may act on.
   */
  | 'window'
  /** `always`, which fires on everything. */
  | 'always'
  /** The room's fallback seat, standing up for a post nobody addressed. */
  | 'seat';

/** One member the matrix picked, and why. */
export interface TriggerSelection {
  authorId: string;
  reason: TriggerReason;
}

/** The entry being addressed. */
export interface AddressingEntry {
  authorId: string;
  /** Author ids resolved from `@name` at write time. */
  mentions: readonly string[];
}

/**
 * Whether one `responseMode` answers this entry in this kind of room.
 *
 * | mode           | triggered when                                   |
 * | -------------- | ------------------------------------------------ |
 * | `silent`       | never                                            |
 * | `mention-only` | mentioned                                        |
 * | `engaged`      | mentioned, or still inside the engaged window    |
 * | `direct-only`  | the room is a DM, or mentioned                   |
 * | `always`       | always                                           |
 *
 * `engaged` reads `isEngaged` and never recomputes it: being mentioned resets
 * the window by construction, because the mention becomes its newest anchor, so
 * the two terms overlap rather than compete.
 *
 * @param mode - The member's per-room response mode.
 * @param opts.roomKind - The room's kind.
 * @param opts.mentioned - Whether this member is in the entry's resolved mentions.
 * @param opts.isEngaged - The already-evaluated engaged-window predicate.
 */
export function respondsTo(
  mode: ResponseMode,
  opts: { roomKind: RoomKind; mentioned: boolean; isEngaged: boolean }
): boolean {
  switch (mode) {
    case 'silent':
      return false;
    case 'mention-only':
      return opts.mentioned;
    case 'engaged':
      return opts.mentioned || opts.isEngaged;
    case 'direct-only':
      return opts.roomKind === 'dm' || opts.mentioned;
    case 'always':
      return true;
  }
}

/**
 * The agent members a committed post should trigger, in roster order.
 *
 * The entry's own author is never a target — an agent does not answer itself,
 * and `always` in a two-agent room would otherwise be an immediate loop.
 *
 * **Outside a channel, implicit addressing belongs to a PERSON's message**
 * (ADR 260814-025326). A direct message needs no `@`: whatever you type there is
 * addressed to whoever is on the other side, which is why `direct-only` fires on
 * everything in one and why the DM seed is the agent's `always` default. That is
 * a claim about a person talking to their agents, and it does not survive a
 * second agent joining: with every member on `always`, one "hello" made Ana
 * answer, Ana's answer trigger Bo, and Bo's answer trigger Ana — one message in,
 * four turns and two apology notices out, with nobody's setting changed. So a
 * post an AGENT writes in a DM addresses only the members it NAMES. Nothing
 * about a channel changes, and `@name` still reaches anyone anywhere.
 *
 * This is the same idea `standDownFallbackSeat` applies to the fallback seat — a
 * post an agent wrote is a conversation already underway — and it is not
 * arbitration: it never chooses between two agents that were addressed, and it
 * never silences one that was named.
 *
 * **The test is `!== 'channel'`, not `=== 'dm'`**, so a room whose stored kind is
 * neither takes the restrained side. `rooms.kind` is a `text` column narrowed by
 * an unchecked cast (`room-rows.ts`), so "the schema says this cannot happen" is
 * a claim about callers, not about storage.
 *
 * @param opts.roomKind - The room's kind; `direct-only` reads it too.
 * @param opts.authorKind - What wrote the entry. Only a person's post carries a
 *   DM's implicit address.
 * @param opts.entry - The committed entry.
 * @param opts.members - The room's roster.
 * @returns Author ids to trigger with the reason each was picked, before the
 *   cascade guard has its say.
 */
export function selectTriggerTargets(opts: {
  roomKind: RoomKind;
  authorKind: AuthorKind;
  entry: AddressingEntry;
  members: readonly AddressingMember[];
}): TriggerSelection[] {
  const mentioned = new Set(opts.entry.mentions);
  const impliesEveryone = opts.roomKind === 'channel' || opts.authorKind === 'human';
  return opts.members
    .filter((member) => member.kind === 'agent' && member.authorId !== opts.entry.authorId)
    .filter((member) => impliesEveryone || mentioned.has(member.authorId))
    .filter((member) =>
      respondsTo(member.responseMode, {
        roomKind: opts.roomKind,
        mentioned: mentioned.has(member.authorId),
        isEngaged: member.isEngaged,
      })
    )
    .map((member) => ({
      authorId: member.authorId,
      reason: reasonFor(opts.roomKind, member, mentioned.has(member.authorId)),
    }));
}

/**
 * Why one selected member was selected.
 *
 * Only reached for members {@link selectTriggerTargets} has already decided to
 * trigger, so this answers "which of the reasons that could have picked you did"
 * rather than "should you be picked" — and the order is the answer.
 *
 * 1. **Named**, whatever the mode. A mention beats everything, because being
 *    named is what creates the obligation the gate must never touch.
 * 2. **Not a channel**, where a person's message addresses whoever is there
 *    without typing a name (ADR 260814-025326). Tested as `!== 'channel'` rather
 *    than `=== 'dm'` for the same reason {@link selectTriggerTargets} tests it
 *    that way: a stored kind that is neither takes the restrained side, and here
 *    "restrained" means "treated as addressed and never gated".
 * 3. **`engaged`**, which is the one reason that means nobody addressed this
 *    agent at all — it is here because it was talking a moment ago.
 * 4. Everything left is `always`, on its own or as the room's fallback seat.
 *    {@link standDownFallbackSeat} tells those two apart, because the seat is
 *    named by the room and nothing here knows the room.
 *
 * @param roomKind - The room's kind.
 * @param member - The selected member.
 * @param mentioned - Whether this entry named them.
 */
function reasonFor(
  roomKind: RoomKind,
  member: AddressingMember,
  mentioned: boolean
): TriggerReason {
  if (mentioned) return 'mention';
  if (roomKind !== 'channel') return 'dm';
  if (member.responseMode === 'engaged') return 'window';
  return 'always';
}

/**
 * Stand the room's **fallback seat** down for anything but the post it exists to
 * catch.
 *
 * A fallback seat is one member held on `always` so that a message a PERSON
 * typed without addressing anybody still reaches one agent — #team's default
 * agent (team-home spec D3.4) is the only one today. `always` on its own is
 * unconditional, so without this the seat also answers every `@nova can you
 * deploy?` and every reply Nova then writes, and the design record for that
 * room is explicit that it must not: "unaddressed posts are handled by the
 * default agent; @mentioned agents respond; **other agents do not consume the
 * message (no token burn, no pile-on)**". For a post that named Nova, the
 * default agent IS an other agent.
 *
 * **The seat is named, never inferred from the mode.** `opts.seatAuthorId` comes
 * from the room (`rooms.fallback_seat_author_id`), because `always` is also what
 * a person picks from a room's member menu, and their choice must keep meaning
 * `always` — fires on everything, stands down for nothing. Reading the mode as
 * the marker made somebody else's deliberate setting behave like this one.
 *
 * **Two shapes stand it down, and they are one idea.** The seat catches what a
 * person typed at the room; it does not catch (1) a post that named another
 * agent, which is that agent's to answer, nor (2) a post written BY an agent —
 * a reply, an out-of-turn update — which is a conversation already underway and
 * not a question aimed at the room. Without the second, the first leaks
 * straight back in: Nova stands up, answers, and her reply re-triggers the seat
 * one cascade hop later, so the operator sees exactly the pile-on they were
 * promised was gone.
 *
 * **Two escapes, and both are the seat answering as itself rather than as the
 * fallback.** It survives when the post named it too (`@nova @dorkbot ...`
 * addressed both), and when it is inside its own engaged window — which in this
 * codebase means somebody addressed it BY NAME recently (`engagement.ts`
 * anchors on a mention). So a default agent you are actually talking to stays in
 * the conversation, follows a colleague's reply, and is not dismissed by your
 * handing one task to somebody else; a default agent that has only ever been
 * catching unaddressed posts has no window and steps back. That is the
 * deliberate reading of "was it conversing?": having been addressed, not having
 * been talking.
 *
 * **This is a second rule, not an edit to `respondsTo`.** The matrix above is the
 * generic §5 contract and `always` still means `always` in every room; a room
 * that names a fallback seat opts into this filter on top, and one that does not
 * is bit-for-bit unaffected. Making it a sixth `ResponseMode` instead would have
 * put a room-specific idea into a shared enum, every mode picker, the wire
 * schemas and every runtime that renders a mode — a much larger surface to buy
 * the same behaviour.
 *
 * Pure. Everything room-specific arrives as data, so nothing about #team reaches
 * this module.
 *
 * @param opts.entry - The committed entry.
 * @param opts.authorKind - What wrote it. The `agent` case is rule (2) above;
 *   passed in rather than looked up in `members`, because an entry's author is
 *   not always on the roster.
 * @param opts.seatAuthorId - Who holds the seat, or `null` in a room with none —
 *   in which case nothing here applies and `selected` comes back untouched.
 * @param opts.members - The room's roster, with `isEngaged` already evaluated —
 *   including for the seat, which the caller must compute rather than assume, or
 *   the second escape silently never fires.
 * @param opts.selected - What {@link selectTriggerTargets} chose.
 * @returns `selected`, without the seat when it has stood down and with the
 *   seat's reason relabelled `'seat'` when it has not. May be empty: a post that
 *   named only a silenced agent reaches nobody, which is what silencing that
 *   agent asked for.
 */
export function standDownFallbackSeat(opts: {
  entry: AddressingEntry;
  authorKind: AuthorKind;
  seatAuthorId: string | null;
  members: readonly AddressingMember[];
  selected: readonly TriggerSelection[];
}): TriggerSelection[] {
  const { seatAuthorId } = opts;
  if (seatAuthorId === null) return [...opts.selected];
  const held = opts.selected.find((selection) => selection.authorId === seatAuthorId);
  if (!held) return [...opts.selected];

  // The seat's own reason, named now that somebody knows which member holds the
  // seat. Only an `always` selection becomes `'seat'`: a seat that was MENTIONED
  // keeps `'mention'`, because it is then answering as itself rather than as the
  // fallback — the same distinction the two escapes below are drawn along.
  const labelled: TriggerSelection[] =
    held.reason === 'always'
      ? opts.selected.map((selection) =>
          selection.authorId === seatAuthorId
            ? { ...selection, reason: 'seat' as const }
            : selection
        )
      : [...opts.selected];

  const mentioned = new Set(opts.entry.mentions);
  const seat = opts.members.find((member) => member.authorId === seatAuthorId);
  if (mentioned.has(seatAuthorId) || seat?.isEngaged) return labelled;

  // A mention of a PERSON is not delegating the question to an agent, so it
  // leaves the seat exactly where it was — and neither does naming the seat's
  // own occupant, which the escape above already answered.
  const addressedAnotherAgent = opts.members.some(
    (member) =>
      member.kind === 'agent' &&
      member.authorId !== opts.entry.authorId &&
      member.authorId !== seatAuthorId &&
      mentioned.has(member.authorId)
  );
  if (!addressedAnotherAgent && opts.authorKind !== 'agent') return labelled;

  return labelled.filter((selection) => selection.authorId !== seatAuthorId);
}
