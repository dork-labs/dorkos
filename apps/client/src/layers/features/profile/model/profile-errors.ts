/**
 * Turning a refusal into a sentence the person who typed it can act on.
 *
 * Pure and separate from the form on purpose: what a refusal MEANS is worth
 * testing on its own, and the thing this exists to prevent — three different
 * refusals collapsing into one "couldn't save that" — is a property of the
 * mapping, not of the component that renders it.
 *
 * @module features/profile/model/profile-errors
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
 * What went wrong with a handle, said three different ways.
 *
 * **Three refusals, three sentences, because they are three different things to
 * do about it** (spec §W3.3): somebody else has it, it is spoken for, or it is
 * not a spellable handle at all. One shared "couldn't save that" would tell a
 * person to try again with no idea what to change.
 *
 * `INVALID_HANDLE` deliberately passes the server's own sentence through rather
 * than replacing it. The grammar has five separate rules (`packages/shared/src/handle.ts`)
 * and the server knows WHICH one broke — "a handle is all lowercase" is a fix
 * the person can make in one keystroke, where any sentence written here would
 * have to describe all five and help with none. The written fallback is there
 * for the case where the refusal arrived without a message.
 *
 * @param error - Whatever the transport threw.
 * @param attempted - The handle they typed, so the message can name it.
 */
export function handleErrorMessage(error: unknown, attempted: string): string {
  const at = `@${attempted}`;
  switch (codeOf(error)) {
    case 'HANDLE_TAKEN':
      return `${at} belongs to someone else. Pick a different one.`;
    case 'HANDLE_RESERVED':
      return `${at} is spoken for. Either you used it before, or it is a word DorkOS uses to reach everyone. Pick a different one.`;
    case 'INVALID_HANDLE':
      return (
        messageOf(error) ??
        'That is not a handle DorkOS can use. Try lowercase letters, numbers, dots, underscores and hyphens.'
      );
    default:
      return messageOf(error) ?? 'Your handle could not be saved. Try again.';
  }
}

/**
 * What went wrong with a photo.
 *
 * Every case says what to do next, because every one of them is fixable by the
 * person looking at it — a smaller file, a different format, a different seat.
 *
 * @param error - Whatever the transport threw.
 */
export function avatarErrorMessage(error: unknown): string {
  switch (codeOf(error)) {
    case 'AVATAR_TOO_LARGE':
      return 'That photo is over 2 MB. Pick a smaller one.';
    case 'AVATAR_TYPE_UNSUPPORTED':
      return 'DorkOS can use a PNG, JPEG or WebP photo. That file is something else.';
    case 'AVATAR_MISSING':
      return 'No photo came through. Pick the file again.';
    case 'OPERATOR_ONLY':
      return 'Only the person at the keyboard can change this photo.';
    default:
      return messageOf(error) ?? 'Your photo could not be saved. Try again.';
  }
}

/**
 * What went wrong saving a name.
 *
 * @param error - Whatever the transport threw.
 */
export function nameErrorMessage(error: unknown): string {
  if (codeOf(error) === 'OPERATOR_ONLY') {
    return 'Only the person at the keyboard can change this name.';
  }
  return messageOf(error) ?? 'Your name could not be saved. Try again.';
}
