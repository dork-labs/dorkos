/** Validation failures never include supplied paths, page data or input text. */
export type BrowserValidationCode =
  | 'INVALID_COMMAND'
  | 'INVALID_RESULT'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_RUNTIME_DESCRIPTOR'
  | 'INVALID_COUNTER'
  | 'INVALID_ID'
  | 'COUNTER_EXHAUSTED';

/** A fixed, input-free failure from the private engine contract boundary. */
export class BrowserValidationError extends Error {
  /** Stable code for callers; the rejected value is deliberately absent. */
  readonly code: BrowserValidationCode;

  constructor(code: BrowserValidationCode) {
    super(`Browser validation failed: ${code}`);
    this.name = 'BrowserValidationError';
    this.code = code;
  }
}
