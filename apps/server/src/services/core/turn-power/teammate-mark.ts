/**
 * What a turn carrying a teammate's mark gets (DOR-3036, `specs/turn-marks`), wherever it came
 * from: the room a teammate wrote in, or any hop after it (a mention, a chat message, a spin-off).
 *
 * A teammate is a space member who is not this install's owner (`rooms/limits/space-teammates.ts`).
 * The mark is a record for the space's monthly limit and lowers nothing: the turn runs at its
 * agent's set level (Dorian 2026-10-30, DOR-3440). It is refused before it starts when any space in
 * its chain is at its monthly limit, and counted against every one of them when it ends
 * (`teammate-turn-cost.ts`). Counting a turn two spaces reached against both errs toward the limit.
 *
 * @module services/core/turn-power/teammate-mark
 */
import type { TeammateOrigin } from '@dorkos/shared/agent-runtime';

/** The refusal a marked turn gets once a space in its chain is at its monthly limit. */
export const TEAMMATE_LIMIT_REFUSAL =
  'This space reached its monthly limit for teammates, so this turn didn’t run.';

/** Whether a space room's monthly teammate limit still allows a turn; set at startup. */
let spaceAllows: ((roomId: string) => boolean) | null = null;

/**
 * Set how a space room's monthly limit is read, or `null` to read none (every space allowed).
 * Rooms and turns know nothing of spaces, so the space layer sets this from outside.
 *
 * @param next - Whether the space a local room copies is under its limit.
 */
export function setTeammateSpaceGate(next: ((roomId: string) => boolean) | null): void {
  spaceAllows = next;
}

/**
 * Why a teammate-marked turn may not run, or `null` when it may.
 *
 * @param origins - Where each teammate in its chain wrote.
 */
export function teammateTurnRefusal(origins: readonly TeammateOrigin[]): string | null {
  const gate = spaceAllows;
  if (gate && origins.some((origin) => !gate(origin.roomId))) return TEAMMATE_LIMIT_REFUSAL;
  return null;
}
