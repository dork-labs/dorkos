/**
 * The one error type the runtime-connect endpoints throw.
 *
 * It lives in its own module so the modules that throw it — credential storage
 * and the pre-save key check — can share it without importing each other. The
 * routes map it uniformly: its `status` becomes the HTTP status and its message
 * is shown to the person as-is, so every message here must be honest, plain, and
 * free of any secret.
 *
 * @module services/runtimes/connect/connect-error
 */

/**
 * A connect failure with an HTTP status hint. Carries an honest, secret-free
 * message the route surfaces to the Connect UI.
 */
export class ConnectError extends Error {
  /** HTTP status the route should map this failure to. */
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ConnectError';
    this.status = status;
  }
}
