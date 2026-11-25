/**
 * What a person reads when a managed-MCP sign-in fails, and what they can do
 * about it (DOR-982).
 *
 * The server classifies a sign-in that could not START into one of a few
 * families and answers with the family's problem `code`; this table turns that
 * code into the one sentence the card shows. Anything without a family code
 * (every failure the POLL reports) already carries a plain, server-authored
 * sentence, so it passes through untouched rather than being re-worded here.
 *
 * A sibling table exists in `features/agent-settings/lib/mcp-server-state.ts`
 * (`classifyFailure`), and they are deliberately NOT shared: that one reads a
 * reachability PROBE's raw string with no code to go on, this one reads a
 * structured sign-in failure. Merging them would mean sniffing strings here too.
 *
 * @module entities/agent/lib/mcp-signin-errors
 */

/** The problem codes a sign-in that could not start answers with. */
type SigninFailureCode =
  'signin_no_app_registration' | 'signin_no_signin_support' | 'signin_unreachable';

/** The plain sentence each sign-in failure family gets. */
const FAMILY_COPY: Record<SigninFailureCode, string> = {
  signin_no_app_registration:
    'This server doesn’t let DorkOS register itself. Add your own app credentials to try again.',
  signin_no_signin_support: 'This server doesn’t offer sign-in the way DorkOS expects.',
  signin_unreachable: 'Couldn’t reach the server to start the sign-in.',
};

/** A failed sign-in, reduced to what the card renders. */
export interface McpSigninErrorView {
  /** The sentence a person reads. */
  message: string;
  /**
   * Whether this failure is one a person can fix by supplying app credentials
   * from the provider — true only for the no-automatic-registration family.
   */
  canUseOwnCredentials: boolean;
}

/** Whether a string is one of the sign-in failure codes. */
function isFailureCode(value: string | undefined): value is SigninFailureCode {
  return value !== undefined && value in FAMILY_COPY;
}

/**
 * Reduce a failed sign-in to its plain sentence and whether the "use your own
 * app credentials" path is offered.
 *
 * @param args.message - What the flow already has to say (the server's own
 *   message, or the client's fallback).
 * @param args.code - The failure family the server answered with, when it did.
 */
export function describeSigninError(args: {
  message: string | null;
  code?: string;
}): McpSigninErrorView {
  const { message, code } = args;
  if (isFailureCode(code)) {
    return {
      message: FAMILY_COPY[code],
      canUseOwnCredentials: code === 'signin_no_app_registration',
    };
  }
  return {
    message: message ?? 'Sign-in didn’t finish. Try again.',
    canUseOwnCredentials: false,
  };
}

/**
 * The problem code of a rejected sign-in start, when the transport carried one.
 *
 * Read defensively off an unknown rejection rather than typed, because a
 * rejection is not always the server's: a dropped request or an abort can
 * arrive here as a plain `Error` with no code, and every one of them must
 * degrade to "no code" rather than throw on the way past.
 *
 * @param err - Whatever the start mutation rejected with.
 */
export function readSigninFailureCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}
