/**
 * What a person reads when a managed-MCP sign-in fails, and what they can do
 * about it (DOR-982).
 *
 * The server classifies a sign-in that could not START into one of a few
 * families and sends the family's `code` on the error payload; this table turns
 * that code into the one sentence the card shows. Anything without a code —
 * every failure the POLL reports — already carries a plain, server-authored
 * sentence, so it passes through untouched rather than being re-worded here.
 *
 * A sibling table exists in `features/agent-settings/lib/mcp-server-state.ts`
 * (`classifyFailure`), and they are deliberately NOT shared: that one reads a
 * reachability PROBE's raw string with no code to go on, this one reads a
 * structured sign-in failure. Merging them would mean sniffing strings here too.
 *
 * @module entities/agent/lib/mcp-signin-errors
 */
import type { McpSigninFailureCode } from '@dorkos/shared/transport';

/** The plain sentence each sign-in failure family gets. */
const FAMILY_COPY: Record<McpSigninFailureCode, string> = {
  SIGNIN_NO_APP_REGISTRATION:
    'This server doesn’t let DorkOS register itself. If you have app credentials from the ' +
    'provider, add them and try again.',
  SIGNIN_NO_SIGNIN_SUPPORT: 'This server doesn’t offer sign-in the way DorkOS expects.',
  SIGNIN_UNREACHABLE: 'Couldn’t reach the server to start the sign-in.',
};

/** A failed sign-in, reduced to what the card renders. */
export interface McpSigninErrorView {
  /** The sentence a person reads. */
  message: string;
  /** The raw error, for the Details disclosure. Absent when there is nothing more to say. */
  detail: string | null;
  /**
   * Whether this failure is one a person can fix by supplying app credentials
   * from the provider — true only for the no-automatic-registration family.
   */
  canUseOwnCredentials: boolean;
}

/** Whether a string is one of the sign-in failure codes. */
function isFailureCode(value: string | undefined): value is McpSigninFailureCode {
  return value !== undefined && value in FAMILY_COPY;
}

/**
 * Reduce a failed sign-in to its plain sentence, its raw detail, and whether the
 * "use your own app credentials" path is offered.
 *
 * @param args.message - What the flow already has to say (the server's own
 *   message, or the client's fallback).
 * @param args.code - The failure family the server sent, when it sent one.
 * @param args.detail - The raw error the server demoted behind the family.
 */
export function describeSigninError(args: {
  message: string | null;
  code?: string;
  detail?: string;
}): McpSigninErrorView {
  const { message, code, detail } = args;
  if (isFailureCode(code)) {
    return {
      message: FAMILY_COPY[code],
      detail: detail ?? message ?? null,
      canUseOwnCredentials: code === 'SIGNIN_NO_APP_REGISTRATION',
    };
  }
  return {
    message: message ?? 'The sign-in did not complete.',
    detail: detail ?? null,
    canUseOwnCredentials: false,
  };
}

/**
 * The structured half of a rejected sign-in start: the family `code` and the raw
 * `detail`, when the transport carried them.
 *
 * Read defensively off an unknown rejection rather than typed, because a
 * rejection is not always the server's: a dropped request, an abort, or an
 * embedded-mode stub all arrive here as plain `Error`s with neither field, and
 * every one of them must degrade to "no code" rather than throw on the way past.
 *
 * @param err - Whatever the start mutation rejected with.
 */
export function readSigninFailurePayload(err: unknown): { code?: string; detail?: string } {
  if (typeof err !== 'object' || err === null) return {};
  const { code, body } = err as { code?: unknown; body?: unknown };
  const detail =
    typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
  };
}
