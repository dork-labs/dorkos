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
  | 'REMOVE_BUILTIN_DENIED';

/**
 * Error class for adapter CRUD operations.
 *
 * Includes a machine-readable `code` for programmatic error handling.
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly code: AdapterErrorCode
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
