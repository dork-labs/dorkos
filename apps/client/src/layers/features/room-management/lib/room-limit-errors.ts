/**
 * Turning a refused limit change into a sentence the reader can act on.
 *
 * Pure and separate from the section for the reason `profile-errors.ts` states:
 * what a refusal MEANS is worth testing on its own, and the thing this exists to
 * prevent — a real "you are not allowed to" collapsing into a generic "couldn't
 * save that" — is a property of the mapping, not of the component rendering it.
 *
 * @module features/room-management/lib/room-limit-errors
 */

/** The `code` an HTTP transport error carries, when the route sent one. */
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

/** The server's own sentence, when it sent one worth reading. */
function messageOf(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.trim() : '';
  return message.length > 0 ? message : undefined;
}

/**
 * What went wrong changing a room's limits.
 *
 * **`OPERATOR_ONLY` is replaced rather than passed through, and that is the
 * whole point of this file.** The server writes that refusal in the owner's
 * voice — "Only you can change how much a room may spend" — which is exactly
 * right in a log and exactly wrong shown to the person it just refused, who is
 * by definition not that "you". Said back plainly, it names who can, so the
 * reader knows the answer is "ask the owner" rather than "try again".
 *
 * `ROOM_ARCHIVED` gets its own line because it is fixable in one press, from the
 * foot of the same panel. Everything else passes the server's own sentence
 * through: it knows which of its rules broke, and any sentence written here
 * would have to describe all of them and help with none.
 *
 * @param error - Whatever the transport threw.
 */
export function roomLimitsErrorMessage(error: unknown): string {
  switch (codeOf(error)) {
    case 'OPERATOR_ONLY':
      return 'Only the person who owns this DorkOS can change a room’s limits.';
    case 'ROOM_ARCHIVED':
      return 'This room is archived, so its limits are on hold. Bring it back first.';
    default:
      return messageOf(error) ?? 'That limit could not be saved. Try again.';
  }
}
