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
  | 'NO_AGENT_RUNTIMES'
  /**
   * A paused connection's owner confirmed a summary that no longer matches it:
   * its references or destinations changed after they looked (DOR-3271).
   */
  | 'CONFIRMATION_STALE'
  /**
   * A new connection was saved, but starting it failed (a bad token, an
   * unreachable service). It stays saved, so trying the add again would only
   * meet `DUPLICATE_ID`.
   */
  | 'START_FAILED';

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
   * @param fields - For `INVALID_CONFIG`, the config field KEYS that were
   *   refused (`token`, `inbound.subject`), so a form can mark them. Keys only,
   *   never a value: this travels to the caller, the message does not.
   */
  constructor(
    message: string,
    public readonly code: AdapterErrorCode,
    public readonly adapterId?: string,
    public readonly fields?: readonly string[]
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
