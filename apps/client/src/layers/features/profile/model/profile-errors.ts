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
 * What went wrong with a handle, said a different way for each refusal.
 *
 * **A sentence per refusal, because each is a different thing to do about
 * it** (spec §W3.3): somebody else has it, it is spoken for, it looks like
 * somebody else's, or it is not a spellable handle at all. One shared "couldn't
 * save that" would tell a person to try again with no idea what to change.
 *
 * `INVALID_HANDLE`, `HANDLE_RESERVED` and `HANDLE_LOOKALIKE` pass the server's
 * own sentence through, because only the server knows which rule broke, whose
 * handle it looks like, or whether a reserved word is DorkOS's or somebody's
 * old handle. The grammar alone has five rules (`packages/shared/src/handle.ts`)
 * and "a handle is all lowercase" is a fix the person can make in one
 * keystroke, where any sentence written here would have to describe all five
 * and help with none. Each written fallback is there
 * for the case where the refusal arrived without a message.
 *
 * @param error - Whatever the transport threw.
 * @param attempted - The handle they typed, so the message can name it.
 */
export function handleErrorMessage(error: unknown, attempted: string): string {
  const at = `@${attempted}`;
  switch (codeOf(error)) {
    case 'HANDLE_TAKEN':
      return `${at} is taken. Pick a different one.`;
    // The server knows whether it is a word DorkOS keeps or somebody's old
    // handle, and says which; the fallback covers a refusal with no message.
    case 'HANDLE_RESERVED':
      return (
        messageOf(error) ??
        `${at} used to belong to someone else and stays theirs. Pick a different one.`
      );
    // The server names whose handle it looks like, which no sentence here can.
    case 'HANDLE_LOOKALIKE':
      return messageOf(error) ?? `${at} looks too much like another handle. Pick a different one.`;
    case 'INVALID_HANDLE':
      return (
        messageOf(error) ??
        'That handle won’t work. Use lowercase letters, numbers, dots, underscores or hyphens.'
      );
    default:
      return messageOf(error) ?? 'Couldn’t save your handle. Try again.';
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
      return 'That file isn’t a photo DorkOS can use. Pick a PNG, JPEG or WebP.';
    case 'AVATAR_MISSING':
      return 'No photo came through. Pick the file again.';
    case 'OPERATOR_ONLY':
      return 'Only the person at the keyboard can change this photo.';
    default:
      return messageOf(error) ?? 'Couldn’t save your photo. Try again.';
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
  return messageOf(error) ?? 'Couldn’t save your name. Try again.';
}

/**
 * What went wrong claiming — or releasing — an account on another platform
 * (DOR-1778).
 *
 * Two refusals worth their own sentence, because they are two different things
 * to do about it. `IDENTITY_NOT_EXTERNAL` means the row cannot be claimed at
 * all — it is somebody on this machine, or an agent — and no retry changes
 * that; `OPERATOR_ONLY` means this is not the caller's install to say so.
 * Everything else, including a server that never answered, falls back to the
 * one sentence a person can act on.
 *
 * @param error - Whatever the transport threw.
 * @param linking - Which direction was refused, so the fallback names it.
 */
export function identityLinkErrorMessage(error: unknown, linking: boolean): string {
  switch (codeOf(error)) {
    case 'IDENTITY_NOT_EXTERNAL':
      return 'Only an account on another chat platform can be linked to you.';
    case 'OPERATOR_ONLY':
      return 'Only this install’s owner can link accounts.';
    default:
      return (
        messageOf(error) ??
        (linking
          ? 'Couldn’t link that account. Try again.'
          : 'Couldn’t remove that link. Try again.')
      );
  }
}
