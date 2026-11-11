/**
 * `ctx.connections`: an isolated extension's server half reads from an app a
 * person connected, through DorkOS, without ever holding a token (DOR-3547).
 *
 * The manifest declares the services and the exact read operations it wants
 * (`serverCapabilities.connections`). A person approves them, per service and
 * account, once. Then `read` runs one declared operation. DorkOS checks the
 * grant, makes the call, and records it under this extension's name.
 *
 * Only the server half of an extension running in the subprocess runtime has
 * it; probe with `ctx.connections !== undefined`. Page code never does.
 *
 * @module extension-api/extension-connections
 */

/** Every reason `ctx.connections.read` refuses, as `err.code`. */
export const EXTENSION_CONNECTION_ERROR_CODES = [
  /** The operation isn't in this extension's manifest. */
  'EXTENSION_CONNECTION_NOT_DECLARED',
  /** A person hasn't approved this service for this copy of the extension, or took it back. */
  'EXTENSION_CONNECTION_NOT_GRANTED',
  /** The operation can change something, and an extension may only read. */
  'EXTENSION_CONNECTION_NOT_READ',
  /** The account is paused, signed out or not ready, or DorkOS can't reach it yet. */
  'EXTENSION_CONNECTION_UNAVAILABLE',
  /** This copy of the extension can't hold connections (where it came from, or how it runs). */
  'EXTENSION_CONNECTION_NOT_ALLOWED',
  /** The arguments don't match the operation's input. */
  'EXTENSION_CONNECTION_INVALID_INPUT',
  /** The answer was bigger than DorkOS hands to an extension (8 MB). Nothing is truncated. */
  'EXTENSION_CONNECTION_RESULT_TOO_LARGE',
] as const;

/** One reason `ctx.connections.read` refuses. */
export type ExtensionConnectionErrorCode = (typeof EXTENSION_CONNECTION_ERROR_CODES)[number];

/** The most a read hands back to an extension, in bytes of JSON (Security Q5). */
export const EXTENSION_CONNECTION_RESULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A read `ctx.connections.read` refused, with nothing returned. `message` is
 * plain words, safe to show. Match on `err.code` rather than `instanceof`: an
 * extension bundle carries its own copy of this class.
 */
export class ExtensionConnectionError extends Error {
  /** Which rule refused the read. */
  readonly code: ExtensionConnectionErrorCode;

  /**
   * Refuse a read.
   *
   * @param code - Which rule refused it.
   * @param message - What went wrong, in plain words.
   */
  constructor(code: ExtensionConnectionErrorCode, message: string) {
    super(message);
    this.name = 'ExtensionConnectionError';
    this.code = code;
  }
}

/** What one read returned. */
export type ExtensionConnectionReadResult =
  | {
      /** The app answered. */
      readonly status: 'success';
      /** The app's answer, as JSON. */
      readonly data: unknown;
    }
  | {
      /** The app, or the way to it, refused or failed. Nothing was changed. */
      readonly status: 'error' | 'cancelled' | 'outcome_unknown' | 'unsupported';
      /** A stable code. */
      readonly code: string;
      /** What happened, in plain words. */
      readonly message: string;
    };

/** One declared service, and whether this copy may read it right now. */
export interface ExtensionConnectionStatus {
  /** The service id the manifest declares, e.g. `linear`. */
  readonly service: string;
  /** Whether a person approved it for this copy, and the approval still holds. */
  readonly granted: boolean;
  /** The approved account's label, when granted. */
  readonly accountLabel?: string;
}

/** `ctx.connections`, as an isolated extension's server half sees it. */
export interface ExtensionConnectionsApi {
  /**
   * Run one declared, granted read operation through DorkOS. DorkOS picks the
   * approved account, makes the call and returns the app's answer. The
   * extension never sees a token. Refuses with an
   * {@link ExtensionConnectionError} whose `code` says why.
   *
   * @param operation - An operation slug the manifest declares, e.g. `LINEAR_LIST_LINEAR_PROJECTS`.
   * @param params - Its arguments, matching the operation's input.
   */
  read(operation: string, params?: Record<string, unknown>): Promise<ExtensionConnectionReadResult>;
  /** Each declared service, and whether this copy may read it right now. */
  status(): Promise<ExtensionConnectionStatus[]>;
}
