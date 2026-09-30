/**
 * Error class for adapter CRUD operations.
 *
 * Includes a machine-readable `code` for programmatic error handling.
 *
 * @module services/relay/adapter-error
 */

/** Machine-readable error codes for adapter operations. */
export type AdapterErrorCode =
  | 'DUPLICATE_ID'
  | 'NOT_FOUND'
  | 'UNKNOWN_TYPE'
  | 'MULTI_INSTANCE_DENIED'
  | 'REMOVE_BUILTIN_DENIED'
  /** The entry failed `AdapterConfigSchema` and was refused rather than persisted. */
  | 'INVALID_CONFIG'
  /**
   * The built-in adapter was asked for while the manager holds NO agent
   * runtimes at all. A composition-root mistake, not a missing runtime: there
   * is nothing to name and no session involved, so it is refused rather than
   * built around a guess.
   */
  | 'NO_AGENT_RUNTIMES';

/**
 * Error class for adapter CRUD operations.
 *
 * Includes a machine-readable `code` for programmatic error handling.
 */
export class AdapterError extends Error {
  /**
   * Build an adapter error.
   *
   * @param message - What went wrong, for logs and developer callers.
   * @param code - Machine-readable reason.
   * @param adapterId - The id the refusal is about, when there is one, so a
   *   caller can name it in its own words (e.g. a `DUPLICATE_ID` refusal).
   */
  constructor(
    message: string,
    public readonly code: AdapterErrorCode,
    public readonly adapterId?: string
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
