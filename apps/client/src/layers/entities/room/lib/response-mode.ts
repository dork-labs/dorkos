/**
 * How a room's `responseMode` override reads to a person.
 *
 * The stored values are `always` / `direct-only` / `mention-only` / `silent`.
 * None of them says out loud what it does, and this is the first UI ever to put
 * the field in front of anyone (spec `rooms` §14.3), so the labels describe the
 * behaviour rather than repeating the enum.
 *
 * The behaviour they describe is `respondsTo` on the server
 * (`services/rooms/addressing.ts`): `silent` never replies, `mention-only`
 * replies when @mentioned, `direct-only` replies when @mentioned or when the
 * room is a direct message, `always` replies to everything.
 *
 * @module entities/room/lib/response-mode
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';

/** One selectable response mode, in the order the menu offers them. */
export interface ResponseModeOption {
  value: ResponseMode;
  /** Plain-language label — one line, because it renders inside a Select. */
  label: string;
}

/**
 * Every response mode, loudest first.
 *
 * All four are always offered, including the one a given room cannot tell apart
 * from its neighbour — in a channel `direct-only` behaves exactly like
 * `mention-only`, and in a direct message it behaves exactly like `always`.
 * Hiding the degenerate one would mean a membership already set to it had no
 * value to display, which is worse than an option that happens to duplicate
 * another's effect in one kind of room.
 */
export const RESPONSE_MODE_OPTIONS: readonly ResponseModeOption[] = [
  { value: 'always', label: 'Replies to everything' },
  { value: 'direct-only', label: 'Replies when spoken to directly' },
  { value: 'mention-only', label: 'Replies only when @mentioned' },
  { value: 'silent', label: 'Never replies on its own' },
] as const;

/**
 * The label for one stored response mode.
 *
 * @param mode - The stored value.
 * @returns Its plain-language label, or the raw value if the enum ever grows a
 *   member this list has not caught up with.
 */
export function responseModeLabel(mode: ResponseMode): string {
  return RESPONSE_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}
