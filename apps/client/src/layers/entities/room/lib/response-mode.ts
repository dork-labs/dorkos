/**
 * How loud one agent is in one room — as something a person can rank.
 *
 * The stored field is `responseMode`, five values deep: `always` / `engaged` /
 * `direct-only` / `mention-only` / `silent`. Offered as five peer sentences,
 * nobody could rank them or tell two of them apart, and one was worse than
 * ambiguous: **`direct-only` changes what it means depending on the kind of
 * room it is in**, which no label can honestly cover.
 *
 * So the five values are projected onto an ordered **rung** — quiet to loud, so
 * that position carries the meaning. The projection is the behaviour table in
 * `apps/server/src/services/rooms/addressing.ts`, read straight off:
 *
 * | stored         | in a channel                   | in a direct message            |
 * | -------------- | ------------------------------ | ------------------------------ |
 * | `silent`       | never → **Silent**             | never → **Silent**             |
 * | `mention-only` | when mentioned → **@only**     | when mentioned → **@only**     |
 * | `engaged`      | mention + window → **Engaged** | mention + window → **Engaged** |
 * | `direct-only`  | mention → **@only**            | always → **Everything**        |
 * | `always`       | always → **Everything**        | always → **Everything**        |
 *
 * **Amended 2026-08-13 (DOR-1208): the DM column describes what a PERSON's
 * message does.** Outside a channel, a message written by an AGENT triggers only
 * the members it names, so every row of that column collapses to `@only` for
 * agent-authored posts — `always` and `direct-only` included (ADR
 * `260814-025326`). The rungs are unchanged and this module needs no new value:
 * a rung ranks how loud an agent is **to the person operating the room**, which
 * is exactly the column above. What moved is agent-to-agent reach, which no rung
 * ever claimed to describe.
 *
 * **Both kinds have four behaviours, so both get the same four rungs.**
 * `direct-only` is the only genuine alias in the five, and what moves with the
 * room kind is which rung it lands on — nothing else.
 *
 * **The engaged window opens in a direct message, and this module claimed
 * otherwise for one commit.** The claim — that the window only opens on an
 * `@mention` and nobody `@`s anyone in a two-person conversation — is a
 * prediction about how people behave rather than a property of the system, and
 * the server contradicts it three ways: `room-trigger.ts` evaluates
 * `engagementFor` for every room kind with no channel gate; mentions resolve
 * and the `@` palette is offered in a direct message; and **a group direct
 * message is still `kind: 'dm'`** — adding a second agent never promotes it to
 * a channel, and people plainly do address each other by name in a
 * three-way conversation. Executed against the server's own predicate,
 * `respondsTo('engaged', { roomKind: 'dm', mentioned: false, isEngaged: true })`
 * answers `true` where `mention-only` answers `false`: two behaviours, which
 * may not share a rung. The cost of the collapse was not cosmetic — `engaged`
 * is the only bounded setting (`services/rooms/engagement.ts`), so a direct
 * message could reach it by no means the UI offered.
 *
 * The claim was inherited rather than invented: the same sentence is still on
 * the TSDoc of `responseModeOptionsFor` in `main`, which this module replaced.
 *
 * **{@link rungOf} is total on purpose.** The API accepts every value in every
 * room and the schema calls them all legal, so a membership CAN hold one no UI
 * writes any more — `direct-only`, set by a script, by an older build, or by an
 * agent through the operator surface. A control that rendered blank for a value
 * that is really there is a setting nobody can fix.
 *
 * @module entities/room/lib/response-mode
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import type { ServerConfig } from '@dorkos/shared/types';

/** One position on the loudness scale, quietest first. */
export type ResponseRung = 'silent' | 'mention' | 'engaged' | 'everything';

/** A rung and what to call it on a control. */
export interface ResponseRungOption {
  rung: ResponseRung;
  /** One or two words — this renders inside a segment, not a sentence. */
  label: string;
}

/**
 * The two ceilings the engaged window decays against, whichever runs out first.
 *
 * Derived from the wire contract rather than restated, so this and
 * `GET /api/config` cannot drift into disagreeing about the field names.
 */
export type EngagedWindow = NonNullable<ServerConfig['rooms']>;

/** What a rung does, in words that are true of this room. */
export interface RungExplanation {
  /** The sentence. Always says something; never says a number it does not have. */
  sentence: string;
  /** A second line when there is one worth adding, `null` when there is not. */
  note: string | null;
}

/**
 * The scale, quietest first — the same four wherever it is drawn.
 *
 * The order IS the information: a reader who cannot rank five sentences can
 * read a left-to-right scale without being told how.
 *
 * It does not vary by room kind, because there is nothing to vary. Both kinds
 * have these four behaviours; only which stored value lands on which rung
 * moves, and that is {@link rungOf}'s business.
 */
export const RESPONSE_RUNGS: readonly ResponseRungOption[] = [
  { rung: 'silent', label: 'Silent' },
  { rung: 'mention', label: '@only' },
  { rung: 'engaged', label: 'Engaged' },
  { rung: 'everything', label: 'Everything' },
] as const;

/**
 * Where a stored value sits on the scale. Total — every one of the five lands
 * on a rung in both kinds of room.
 *
 * @param mode - What the membership stores today.
 * @param roomKind - The room it lives in; `direct-only` is the one value that
 *   reads it.
 */
export function rungOf(mode: ResponseMode, roomKind: RoomKind): ResponseRung {
  switch (mode) {
    case 'silent':
      return 'silent';
    case 'mention-only':
      return 'mention';
    case 'engaged':
      return 'engaged';
    case 'direct-only':
      return roomKind === 'dm' ? 'everything' : 'mention';
    case 'always':
      return 'everything';
  }
}

/**
 * The value to write when somebody picks a rung.
 *
 * One canonical value per rung, so the alias stops multiplying: nothing here
 * ever writes `direct-only`, whose meaning depends on where it is stored, and a
 * control whose consequence depends on a field the reader cannot see is one
 * nobody can predict.
 *
 * **The room kind is not an input.** Four of the five stored values mean the
 * same thing wherever they live, and the fifth is the one this never writes —
 * so a rung maps to a value without anything else having to be known, and a
 * caller cannot store the wrong behaviour by projecting through the wrong kind.
 *
 * @param rung - The rung the reader picked.
 */
export function modeForRung(rung: ResponseRung): ResponseMode {
  switch (rung) {
    case 'silent':
      return 'silent';
    case 'mention':
      return 'mention-only';
    case 'engaged':
      return 'engaged';
    case 'everything':
      return 'always';
  }
}

/** `1 minute` / `3 minutes` — the unit agrees with the number in front of it. */
function count(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/**
 * What the engaged rung does, given the window this install is running.
 *
 * Three answers, because there are three real situations and only one of them
 * has numbers in it.
 */
function explainEngaged(window: EngagedWindow | null): RungExplanation {
  const quietAgain = 'Then it goes quiet again until you say its name.';
  if (window === null) {
    // The numbers are settings, so inventing them would state something false
    // about somebody's own install. The shape of the rule is still true.
    return {
      sentence: 'Answers when you @mention it, then keeps answering for a while afterwards.',
      note: quietAgain,
    };
  }
  if (window.engagedWindowMinutes === 0 || window.engagedWindowPosts === 0) {
    // Either ceiling at zero means the window can never be open — see
    // `services/rooms/engagement.ts`, where both terms have to hold.
    return {
      sentence: 'Answers when you @mention it, and stops as soon as it has.',
      note: 'The engaged window is switched off on this DorkOS, so this behaves like @only.',
    };
  }
  return {
    sentence:
      `Answers when you @mention it — then keeps answering for ` +
      `${count(window.engagedWindowMinutes, 'more minute')} or ` +
      `${count(window.engagedWindowPosts, 'more message')}, whichever runs out first.`,
    note: quietAgain,
  };
}

/**
 * What a rung does here, in a sentence a person can check against what they see
 * happen.
 *
 * No two rungs in one kind of room say the same thing — if two did, one of them
 * would be a control with nothing to choose.
 *
 * @param rung - The rung being described.
 * @param roomKind - The room it is being described in.
 * @param window - The engaged-window ceilings, or `null` while they are still
 *   being read. Never substitute the shipped defaults: they are settings, and a
 *   guess here is the UI stating a false number.
 */
export function explainRung(
  rung: ResponseRung,
  roomKind: RoomKind,
  window: EngagedWindow | null
): RungExplanation {
  switch (rung) {
    case 'silent':
      return {
        sentence: 'Never speaks here',
        note: 'You can still talk to it in its own session.',
      };
    case 'mention':
      // No second line for a direct message any more. The one that used to sit
      // here — "in a conversation this small, it mostly stays quiet" — was the
      // module's false premise in miniature: it predicted how a small room
      // behaves, and a direct message holding three agents does not behave that
      // way. The sentence above is exact in both kinds and needs no help.
      return { sentence: 'Answers only when you @mention it.', note: null };
    case 'engaged':
      return explainEngaged(window);
    case 'everything':
      return {
        sentence:
          roomKind === 'dm'
            ? 'Answers every message you send here.'
            : 'Answers every message in this room.',
        note: null,
      };
  }
}
