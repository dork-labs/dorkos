/**
 * Why a delegated vendor login did not complete, said two ways: a redacted
 * record for the log, and one plain line with a next step for the person.
 *
 * A failed sign-in used to log one fixed line and show one fixed message, so
 * neither the person nor anyone reading the log afterwards could tell a
 * timeout from a crash from a refused account (DOR-4426). The CLI's own stderr
 * is the only place that says which, and it can carry an address, a browser
 * URL or token text, so it never leaves this module: it is read here, sorted
 * into a fixed vocabulary, and dropped. Only the category, the step, the exit
 * code or signal, an errno-shaped code and the byte count survive.
 *
 * @module services/runtimes/connect/login-failure
 */

/** What went wrong, from a fixed list. */
export type LoginFailureReason =
  'timeout' | 'spawn_failed' | 'network' | 'credential_store' | 'refused' | 'exited';

/** How far the login got, from a fixed list. */
export type LoginFailureStep =
  'start' | 'waiting_for_browser' | 'oauth_flow' | 'refresh_token' | 'saving_key' | 'unknown';

/** What the child process did, as the login saw it. */
export type LoginFailureInput =
  | { kind: 'timeout'; step?: LoginFailureStep }
  | { kind: 'spawn'; code?: string }
  | { kind: 'exit'; code: number | null; signal: string | null; stderr: StderrSample };

/** The redacted record a failed login logs. Every field is safe to write down. */
export interface LoginFailure {
  /** What went wrong. */
  reason: LoginFailureReason;
  /** How far the login got. */
  step: LoginFailureStep;
  /** The CLI's exit code, when it exited on its own. */
  exitCode?: number;
  /** The signal that stopped the CLI, when one did. */
  signal?: string;
  /** The spawn error's code (`ENOENT`, `EACCES` …), when it had a well-formed one. */
  errno?: string;
  /** How many bytes the CLI wrote to stderr in all, so an empty one is visible. */
  stderrBytes?: number;
}

/** How many characters of stderr are kept from each end: the start names the step, the end the cause. */
const STDERR_EDGE_CHARS = 4_096;

/**
 * A bounded sample of a child's stderr: its start, its end and its full size.
 * A chatty CLI cannot grow it without limit over a three-minute sign-in, and
 * a long stack trace cannot push the CLI's own first line out of it.
 */
export class StderrSample {
  private head = '';
  private tail = '';
  private truncated = false;
  /** Total bytes written, counted as they arrive. */
  bytes = 0;

  /**
   * Add a chunk as it arrives.
   *
   * @param chunk - The bytes the child just wrote.
   */
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    const text = chunk.toString();
    if (this.head.length < STDERR_EDGE_CHARS) {
      const room = STDERR_EDGE_CHARS - this.head.length;
      this.head += text.slice(0, room);
      const rest = text.slice(room);
      if (rest) this.addTail(rest);
      return;
    }
    this.addTail(text);
  }

  /** The sampled text, for sorting only. Never log or return it. */
  text(): string {
    return this.truncated ? `${this.head}\n${this.tail}` : this.head + this.tail;
  }

  private addTail(text: string): void {
    const joined = this.tail + text;
    if (joined.length > STDERR_EDGE_CHARS) this.truncated = true;
    this.tail = joined.slice(-STDERR_EDGE_CHARS);
  }
}

/** An errno-style code: capitals, digits and underscores, starting with E. */
const ERRNO_SHAPE = /^E[A-Z0-9_]{1,30}$/;
/** A signal name, as Node reports one. */
const SIGNAL_SHAPE = /^SIG[A-Z0-9]{1,12}$/;

// Whole phrases only: a bare word ("network", "organization") turns up in
// stack paths and progress lines and would send the person the wrong way.
const NETWORK =
  /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|network error/i;
const CREDENTIAL_STORE = /keychain|credentials? (store|file)/i;
const REFUSED = /\bnot allowed\b|\bforbidden\b|\b403\b/i;

/**
 * Sort a failed login into the fixed vocabulary. The stderr text is read, never
 * returned.
 *
 * @param input - What the child process did.
 */
export function classifyLoginFailure(input: LoginFailureInput): LoginFailure {
  if (input.kind === 'timeout') {
    return { reason: 'timeout', step: input.step ?? 'waiting_for_browser' };
  }
  if (input.kind === 'spawn') {
    return input.code && ERRNO_SHAPE.test(input.code)
      ? { reason: 'spawn_failed', step: 'start', errno: input.code }
      : { reason: 'spawn_failed', step: 'start' };
  }

  const stderr = input.stderr.text();
  const failure: LoginFailure = { reason: exitReason(stderr), step: exitStep(stderr) };
  if (typeof input.code === 'number') failure.exitCode = input.code;
  if (input.signal && SIGNAL_SHAPE.test(input.signal)) failure.signal = input.signal;
  failure.stderrBytes = input.stderr.bytes;
  return failure;
}

/** The category a non-zero exit's stderr points at. Network first: it is the most specific. */
function exitReason(stderr: string): LoginFailureReason {
  if (NETWORK.test(stderr)) return 'network';
  if (CREDENTIAL_STORE.test(stderr)) return 'credential_store';
  if (REFUSED.test(stderr)) return 'refused';
  return 'exited';
}

/** The step a non-zero exit's stderr names, matched on the CLI's own fixed prefixes. */
function exitStep(stderr: string): LoginFailureStep {
  if (stderr.includes('Login from refresh token failed')) return 'refresh_token';
  if (stderr.includes('Login failed')) return 'oauth_flow';
  return 'unknown';
}

/**
 * The line a person sees: what happened, then what to do. Each one stands on
 * its own, because some surfaces show it alone and some under the account's
 * name.
 *
 * @param reason - What went wrong.
 * @param timeoutMinutes - How long a sign-in may take, for the timeout line.
 */
export function loginFailureMessage(reason: LoginFailureReason, timeoutMinutes = 3): string {
  switch (reason) {
    case 'timeout':
      return `Sign-in timed out. Finish it in the browser within ${timeoutMinutes} ${timeoutMinutes === 1 ? 'minute' : 'minutes'}, then try again.`;
    case 'spawn_failed':
      return 'The sign-in couldn’t start. Reinstall DorkOS, then try again.';
    case 'network':
      return 'The sign-in service couldn’t be reached. Check your connection, then try again.';
    case 'credential_store':
      return 'The sign-in couldn’t be saved on this computer. Try signing in from a terminal.';
    case 'refused':
      return 'This account was refused. Sign in with a different account.';
    case 'exited':
      return 'The sign-in stopped before it finished. Try again, or sign in from a terminal.';
  }
}
