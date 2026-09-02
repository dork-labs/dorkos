/**
 * The one rule for what an extension id may look like.
 *
 * An extension id doubles as a directory name and as the filename of the
 * extension's secrets and settings files, so this pattern is what keeps every
 * one of those paths inside the folder it belongs to. It lives here — the
 * lowest package in the graph — so the stores that build those paths and the
 * manifest schemas that accept ids can share a single definition.
 *
 * @module shared/extension-id
 */

/**
 * Allowed shape of an extension id: lowercase letters, digits, and hyphens,
 * starting with a letter or digit.
 *
 * It admits no dot, slash, backslash, or non-ASCII character, which is every
 * way a name could climb out of its parent directory.
 */
export const EXTENSION_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Thrown when a value used as an extension id could name a file outside the
 * folder it belongs to.
 */
export class InvalidExtensionIdError extends Error {
  /** The rejected id, kept so callers can report what was refused. */
  readonly extensionId: string;

  /**
   * Build the error for a refused id.
   *
   * @param extensionId - The id that failed {@link EXTENSION_ID_REGEX}.
   */
  constructor(extensionId: string) {
    super(
      `Invalid extension id: ${JSON.stringify(extensionId)} — ` +
        'use lowercase letters, numbers, and hyphens only'
    );
    this.name = 'InvalidExtensionIdError';
    this.extensionId = extensionId;
  }
}

/**
 * Throw unless `extensionId` is safe to put in a file path.
 *
 * Callers that reach an extension's stored data by id use this so the check
 * cannot be forgotten at a new call site — the boundary allowlists at the
 * routes stay, this is the backstop underneath them.
 *
 * @param extensionId - The id to check.
 * @throws {InvalidExtensionIdError} If the id does not match {@link EXTENSION_ID_REGEX}.
 */
export function assertValidExtensionId(extensionId: string): void {
  if (!EXTENSION_ID_REGEX.test(extensionId)) {
    throw new InvalidExtensionIdError(extensionId);
  }
}
