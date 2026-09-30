/** What the owner of a community with an open replacement can do about it now. */
export interface OwnerReplacementOptions {
  /** Keeping ownership needs only the email link or a signed-in session, in every open state. */
  keep: true;
  /** Hand the community to someone: `POST /owner/transfer`, only in `active`, with a password. */
  transfer: boolean;
  /** Delete the community: `POST /owner/deletion`, which needs a password. */
  delete: boolean;
  /** The owner has no password, so transfer and delete wait until they add one. */
  needsPassword: boolean;
}

/**
 * The owner's options, from the community's lifecycle and whether their account has a password.
 * An open replacement exists only in `active`, `archived`, or `held`, and the owner-deletion
 * route accepts all three, so deleting needs only the password; transfer is refused in
 * `archived` and `held`.
 */
export function ownerReplacementOptions(input: {
  lifecycle: string;
  hasPassword: boolean;
}): OwnerReplacementOptions {
  return {
    keep: true,
    transfer: input.lifecycle === 'active' && input.hasPassword,
    delete: input.hasPassword,
    needsPassword: !input.hasPassword,
  };
}
