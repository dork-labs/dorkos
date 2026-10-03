/**
 * The typed refusals a dev link answers with (DOR-2696). Each carries a code
 * from `DevLinkErrorCode`, the HTTP status the routes answer with, and one
 * plain sentence that says what did not happen and what to do instead.
 *
 * @module services/marketplace/dev-links/errors
 */
import type { DevLinkErrorCode } from '@dorkos/shared/marketplace-schemas';

/** A dev link refused, with the code and status the caller acts on. */
export class DevLinkError extends Error {
  /**
   * Build one refusal.
   *
   * @param code - The machine-readable refusal.
   * @param status - The HTTP status the routes answer with.
   * @param message - One plain sentence for the person or the agent.
   * @param details - Extra fields a caller can retry with (e.g. `realPath`).
   */
  constructor(
    readonly code: DevLinkErrorCode,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'DevLinkError';
  }

  /** The JSON body a route answers with. */
  toBody(): Record<string, unknown> {
    return { error: this.message, code: this.code, ...this.details };
  }
}

/**
 * The refusal an install, update or uninstall gets when the package's slot is
 * a dev link: those would replace or delete the link, and the explicit switch
 * is unlink.
 *
 * @param name - The package name.
 */
export function packageIsDevLinked(name: string): DevLinkError {
  return new DevLinkError(
    'package_is_dev_linked',
    409,
    `${name} runs from a dev link. Unlink it first.`,
    { name }
  );
}
