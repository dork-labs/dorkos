import type { PermissionModeId } from '@dorkos/shared/types';

/**
 * What a screen reader is told about the mark on a session running at full
 * power — the sidebar row's icon and the full row's tooltip button both.
 *
 * One string for both rows, because the two used to spell the same fact two
 * ways ("Permissions bypassed" on one, a longer sentence on the other) and a
 * person moving between the two lists heard about two different things.
 *
 * Plain and factual, in the dial's own vocabulary. "Permissions bypassed" was
 * engineering's word for it and read as an accusation once the colour turned
 * green; what a person needs told is which stop this chat is at and what that
 * means (spec `full-power-defaults`, D8).
 */
export const FULL_POWER_MARK_LABEL = 'Full power: acts without approval prompts';

/**
 * A session's effective permission mode: a change the person just made and the
 * server has not confirmed yet wins over the last row the server sent.
 *
 * Pure so both the full status hook and the lightweight read-only hook resolve
 * it identically instead of each re-deriving the precedence.
 *
 * ## The trailing `'default'` is a PLACEHOLDER, not an answer (DOR-2103)
 *
 * It used to be described as "an unknown session is treated as asking for
 * everything", which read as a safety posture and was not one — it is the
 * value that comes out when nothing is known, and it happens to be shaped
 * exactly like a real mode. Painting it is the DOR-2103 defect: a conversation
 * whose operator configured Full autonomy read "Default" until the first
 * message, and a cold load read it for a few frames before flipping.
 *
 * So callers do not paint this value on trust. `useSessionStatus` reports
 * `permissionModeKnown` beside it — "a change, a row, or the start-mode
 * resolution has answered" — and the two surfaces that DRAW a mode (the
 * permissions control, the read-only dead-end notice) withhold themselves
 * until it is true. A caller that merely passes the value along need not
 * care; a caller that puts a word on screen must.
 *
 * The literal survives rather than the signature widening to
 * `PermissionModeId | undefined` because roughly a dozen readers take it as a
 * plain string, and an `undefined` threaded through all of them would be a
 * larger change than the one defect warrants — the flag is what makes the
 * unknown state legible, and it is checked by test.
 *
 * `isBypassPermissionMode` used to live here and now lives in
 * `shared/lib/permission-mode`. An integration binding is an entity and may not
 * import a sibling entity, so a definition parked here was out of reach of one of the
 * three surfaces that have to agree about what a bypass mode covers.
 *
 * Typed as {@link PermissionModeId} (a wire-shaped string), not the narrower
 * `PermissionMode` enum — `confirmed` comes from `Session.permissionMode`,
 * which carries whatever id the session's own runtime reports (DOR-851;
 * `test-mode`'s ids sit outside the enum on purpose). Nothing here reads
 * meaning off the name, so the wider type costs nothing.
 *
 * @param pending - Optimistic mode from an in-flight settings change.
 * @param confirmed - Mode from the session row the server last returned.
 */
export function resolvePermissionMode(
  pending: PermissionModeId | undefined,
  confirmed: PermissionModeId | undefined
): PermissionModeId {
  return pending ?? confirmed ?? 'default';
}
