/**
 * Error raised when protected content cannot be accepted or dispatched safely.
 */
export class PrivateSessionMessageRefusalError extends Error {
  /** Stable internal reason code suitable for logs and tests. */
  readonly code: string;

  /**
   * Build a refusal without exposing protected source content.
   *
   * @param code - Stable internal reason code
   * @param message - Safe diagnostic detail
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrivateSessionMessageRefusalError';
    this.code = code;
  }
}
