/**
 * How loud one agent is in one room — as something a person can rank.
 *
 * The stored field is `responseMode`, five values deep: `always` / `engaged` /
 * `direct-only` / `mention-only` / `silent`. Offered as five peer sentences,
 * nobody could rank them or tell two of them apart, and two were worse than
 * ambiguous: **`direct-only` and `engaged` change what they mean depending on
 * the kind of room they are in**, which no label can honestly cover.
 *
 * So the five values are projected onto an ordered **rung** — quiet to loud, so
 * that position carries the meaning — and the room decides how many rungs there
 * are. The projection is the behaviour table in
 * `apps/server/src/services/rooms/addressing.ts`, read straight off:
 *
 * | stored         | in a channel                    | in a direct message           |
 * | -------------- | ------------------------------- | ----------------------------- |
 * | `silent`       | never → **Silent**              | never → **Silent**            |
 * | `mention-only` | when mentioned → **@only**      | when mentioned → **@only**    |
 * | `engaged`      | mention + window → **Engaged**  | window never opens → **@only** |
 * | `direct-only`  | `roomKind !== 'dm'`, so mention → **@only** | always → **Everything** |
 * | `always`       | always → **Everything**         | always → **Everything**       |
 *
 * A direct message therefore has three behaviours, not four, and that is why it
 * gets three rungs. `engaged` collapses there because the window only ever
 * opens on an `@mention` (`services/rooms/engagement.ts`) and nobody `@`s
 * anyone in a two-person conversation.
 *
 * **{@link rungOf} is total on purpose.** The API accepts every value in every
 * room and the schema calls them all legal, so a membership CAN hold one this
 * room would never offer — set by a script, by an older build, or by an agent
 * through the operator surface. A control that rendered blank for a value that
 * is really there is a setting nobody can fix, which is worse than the
 * duplication that avoiding it costs.
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

/** Quiet → loud. A channel has a bounded middle setting; see the module doc. */
const CHANNEL_RUNGS: readonly ResponseRungOption[] = [
  { rung: 'silent', label: 'Silent' },
  { rung: 'mention', label: '@only' },
  { rung: 'engaged', label: 'Engaged' },
  { rung: 'everything', label: 'Everything' },
] as const;

/** Three, because a direct message only has three behaviours. */
const DM_RUNGS: readonly ResponseRungOption[] = [
  { rung: 'silent', label: 'Silent' },
  { rung: 'mention', label: '@only' },
  { rung: 'everything', label: 'Everything' },
] as const;

/**
 * The rungs this kind of room offers, quietest first.
 *
 * The order IS the information: a reader who cannot rank five sentences can
 * read a left-to-right scale without being told how.
 *
 * @param roomKind - The room the membership lives in.
 */
export function rungsFor(roomKind: RoomKind): readonly ResponseRungOption[] {
  return roomKind === 'dm' ? DM_RUNGS : CHANNEL_RUNGS;
}

/**
 * Where a stored value sits on this room's scale. Total — every value lands
 * somewhere in both kinds of room, and never on a rung the room does not offer.
 *
 * @param mode - What the membership stores today.
 * @param roomKind - The room it lives in; two of the five values read it.
 */
export function rungOf(mode: ResponseMode, roomKind: RoomKind): ResponseRung {
  switch (mode) {
    case 'silent':
      return 'silent';
    case 'mention-only':
      return 'mention';
    case 'engaged':
      return roomKind === 'dm' ? 'mention' : 'engaged';
    case 'direct-only':
      return roomKind === 'dm' ? 'everything' : 'mention';
    case 'always':
      return 'everything';
  }
}

/**
 * The value to write when somebody picks a rung.
 *
 * One canonical value per rung, so the four aliases stop multiplying: a room
 * never writes `direct-only`, whose meaning depends on where it is stored, and
 * a direct message never writes `engaged`, whose window cannot open there.
 * Asking for `engaged` in a direct message writes `mention-only` instead —
 * that is what it would have behaved as, and writing it plainly is what keeps
 * the control from jumping to a rung the reader did not choose.
 *
 * @param rung - The rung the reader picked.
 * @param roomKind - The room it was picked in.
 */
export function modeForRung(rung: ResponseRung, roomKind: RoomKind): ResponseMode {
  switch (rung) {
    case 'silent':
      return 'silent';
    case 'mention':
      return 'mention-only';
    case 'engaged':
      return roomKind === 'dm' ? 'mention-only' : 'engaged';
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
  // A direct message has no engaged rung, so a caller that asks for one is
  // asking about a stored value that behaves as `@only` there. Answer for what
  // it does rather than for what it is called.
  const asked = roomKind === 'dm' && rung === 'engaged' ? 'mention' : rung;
  switch (asked) {
    case 'silent':
      return {
        sentence: 'Never speaks here',
        note: 'You can still talk to it in its own session.',
      };
    case 'mention':
      return {
        sentence: 'Answers only when you @mention it.',
        note:
          roomKind === 'dm'
            ? 'In a conversation this small, that means it mostly stays quiet.'
            : null,
      };
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
