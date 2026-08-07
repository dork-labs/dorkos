/**
 * Turning a sign-in that never got off the ground into something a person can
 * act on (DOR-982).
 *
 * The MCP SDK's `auth()` throws whatever its last HTTP hop produced. For a
 * provider that does not support automatic app registration that is typically
 * `HTTP 404: Invalid OAuth error response: … Raw body: <!doctype html>…` — a
 * string nobody can do anything with, and one that hides the single most useful
 * fact: this is fixable by pasting app credentials from the provider.
 *
 * So the failure is classified from the STAGE the provider recorded on its way
 * through `auth()` ({@link McpSigninProgress}) rather than from the message, and
 * the raw text is demoted to a detail the UI keeps behind a disclosure.
 *
 * @module services/mesh/mcp-signin-failure
 */
import type { McpSigninFailureCode } from '@dorkos/shared/transport';

import type { McpSigninProgress } from './agent-mcp-oauth-provider.js';

/**
 * How much of the raw error is carried forward. Enough to identify a status code
 * and an error body's first line; short enough that a provider answering with a
 * whole HTML error page cannot flood a card or a transcript.
 */
const MAX_DETAIL_LENGTH = 400;

/** A sign-in start failure, already reduced to what each surface needs. */
export interface McpSigninFailure {
  /** The plain sentence a person reads. */
  message: string;
  /** The machine-readable family; see {@link McpSigninFailureCode}. */
  code: McpSigninFailureCode;
  /** The raw error, truncated — for the Details disclosure, never the headline. */
  detail: string;
}

/** The plain sentence each family gets. */
const MESSAGES: Record<McpSigninFailureCode, string> = {
  SIGNIN_NO_APP_REGISTRATION:
    'This server doesn’t let DorkOS register itself. If you have app credentials from the ' +
    'provider, add them and try again.',
  SIGNIN_NO_SIGNIN_SUPPORT: 'This server doesn’t offer sign-in the way DorkOS expects.',
  SIGNIN_UNREACHABLE: 'Couldn’t reach the server to start the sign-in.',
};

/**
 * Which family a failed sign-in start belongs to.
 *
 * The one distinction worth the extra care is inside the `registration` stage:
 * reaching it means no client identity was stored, so `auth()` was about to
 * register DorkOS. Whether that is worth offering credentials for depends on
 * whether the server publishes OAuth metadata at all — a server with none is not
 * refusing to register us, it is simply not an OAuth server DorkOS can drive,
 * and telling that person to go find app credentials would send them hunting for
 * something that does not exist.
 *
 * @param progress - How far the provider got; absent when nothing recorded it.
 */
function codeFor(progress: McpSigninProgress | undefined): McpSigninFailureCode {
  if (!progress) return 'SIGNIN_UNREACHABLE';
  // Nothing answered, so nothing is known about the server — least of all that
  // it is "not an OAuth server", which is what an absent-metadata verdict would
  // claim on the strength of requests that never landed.
  if (!progress.responded) return 'SIGNIN_UNREACHABLE';
  if (progress.stage === 'registration') {
    return progress.metadataFound === false
      ? 'SIGNIN_NO_SIGNIN_SUPPORT'
      : 'SIGNIN_NO_APP_REGISTRATION';
  }
  // `discovery` — never even learned where the OAuth server is — and `authorize`
  // — got a client identity and still could not finish — are both "we could not
  // complete this", with the raw text carrying whatever more there is to say.
  return 'SIGNIN_UNREACHABLE';
}

/**
 * The raw error text, trimmed to {@link MAX_DETAIL_LENGTH}.
 *
 * @param err - Whatever `auth()` threw.
 */
function detailOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > MAX_DETAIL_LENGTH ? `${raw.slice(0, MAX_DETAIL_LENGTH)}…` : raw;
}

/**
 * Classify a failed `startSignin` into its plain-language family plus the raw
 * detail behind it.
 *
 * @param err - The error the sign-in threw.
 * @param progress - The provider's record of how far `auth()` got.
 */
export function classifySigninFailure(
  err: unknown,
  progress: McpSigninProgress | undefined
): McpSigninFailure {
  const code = codeFor(progress);
  return { code, message: MESSAGES[code], detail: detailOf(err) };
}

/**
 * What `startSignin` throws when a sign-in cannot be started: the plain family
 * as the `Error` message, with the code and raw detail attached for the surfaces
 * that can render them separately.
 *
 * A plain `Error` subclass rather than a result field, because every existing
 * caller already treats a throw as "no sign-in happened" — the classification
 * rides along without changing who is responsible for what.
 */
export class McpSigninStartError extends Error {
  /** The plain family, its code, and the raw detail behind it. */
  readonly failure: McpSigninFailure;

  /**
   * Build the error from an already-classified failure.
   *
   * @param failure - The classified failure this error reports.
   * @param cause - The error `auth()` threw, kept for server-side logging.
   */
  constructor(failure: McpSigninFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = 'McpSigninStartError';
    this.failure = failure;
  }
}
