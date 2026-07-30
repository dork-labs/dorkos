/**
 * How a room's `responseMode` override reads to a person.
 *
 * The stored values are `always` / `engaged` / `direct-only` / `mention-only` /
 * `silent`. None of them says out loud what it does, and this is the first UI
 * ever to put the field in front of anyone (spec `rooms` §14.3), so the labels
 * describe the behaviour rather than repeating the enum.
 *
 * The behaviour they describe is `respondsTo` on the server
 * (`services/rooms/addressing.ts`): `silent` never replies, `mention-only`
 * replies when @mentioned, `engaged` replies when @mentioned and for a bounded
 * window afterwards, `direct-only` replies when @mentioned or when the room is a
 * direct message, `always` replies to everything.
 *
 * @module entities/room/lib/response-mode
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomKind } from '@dorkos/shared/room-schemas';

/** One selectable response mode, in the order the menu offers them. */
export interface ResponseModeOption {
  value: ResponseMode;
  /** Plain-language label — one line, because it renders inside a Select. */
  label: string;
}

/**
 * Every response mode, loudest first.
 *
 * Module-private: {@link responseModeOptionsFor} is the only way in, because
 * which of these a room may offer is part of the answer and a caller reading the
 * raw list would skip it.
 *
 * **Three of these are degenerate in one room kind or the other**, and the rule
 * for what to do about that is not "hide it" — it is whether the LABEL stays
 * true:
 *
 * - `direct-only` in a channel behaves exactly like `mention-only`, and in a
 *   direct message exactly like `always`. Offered in both, because "Replies when
 *   spoken to directly" describes what happens either way; a reader who picks it
 *   gets what the words promised, and only a reader comparing two options
 *   notices the overlap.
 * - `mention-only` in a direct message is the quietest useful setting and its
 *   label is exact. Offered.
 * - **`engaged` in a direct message is the one whose label becomes false**, and
 *   that is why {@link responseModeOptionsFor} withholds it there. The window
 *   only ever opens on an `@mention` (`services/rooms/addressing.ts`), and
 *   nobody `@`s anyone in a two-person conversation — so it collapses to
 *   `mention-only`, which is very nearly "never replies", while the label
 *   promises the opposite. An option that lies is worse than one that
 *   duplicates.
 *
 * `engaged` is the seed a new channel member gets, and there it sits between the
 * two it was built to replace: quieter than `always`, without the `@` on every
 * message that `mention-only` charges.
 */
const RESPONSE_MODE_OPTIONS: readonly ResponseModeOption[] = [
  { value: 'always', label: 'Replies to everything' },
  { value: 'engaged', label: 'Replies while it is in the conversation' },
  { value: 'direct-only', label: 'Replies when spoken to directly' },
  { value: 'mention-only', label: 'Replies only when @mentioned' },
  { value: 'silent', label: 'Never replies on its own' },
] as const;

/**
 * The modes worth offering for one membership, given the room it is in.
 *
 * Only `engaged` is ever withheld, and only in a direct message — see
 * {@link RESPONSE_MODE_OPTIONS} for why that one and not the other degenerate
 * pairings.
 *
 * **A stored value is always offered, whatever the room kind.** The API still
 * accepts `engaged` everywhere and the schema still calls it legal, so a DM
 * membership CAN hold it — set by a script, by an older build, or by an agent
 * through the operator surface. Filtering it out unconditionally would leave the
 * control rendering blank for a value that is really there, which is a worse
 * failure than the one this exists to prevent: a person cannot fix a setting
 * they cannot see. So this narrows what somebody may newly choose, never what
 * the panel can display.
 *
 * @param roomKind - The room the membership lives in.
 * @param current - What the membership stores today.
 */
export function responseModeOptionsFor(
  roomKind: RoomKind,
  current: ResponseMode
): readonly ResponseModeOption[] {
  if (roomKind !== 'dm' || current === 'engaged') return RESPONSE_MODE_OPTIONS;
  return RESPONSE_MODE_OPTIONS.filter((option) => option.value !== 'engaged');
}
