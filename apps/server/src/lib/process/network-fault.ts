/**
 * The process-level safety net for errors nothing caught (DOR-3229).
 *
 * **A narrow net, never a catch-all.** A connection that drops, or a remote
 * host that resets it, is something outside DorkOS doing something ordinary:
 * the server carries on. Anything else that reaches the process — a
 * `TypeError`, a failed assertion, a database error, anything unknown — means
 * DorkOS's own state may be wrong, so it is logged and the process exits
 * non-zero for its supervisor to restart.
 *
 * **Why staying up is safe for exactly these.** They are socket and DNS
 * failures: an emitter with no `error` listener, or a promise nobody awaited,
 * reporting that one outbound connection failed. No DorkOS state was half
 * written by them. The call sites are still the real fix (every socket gets an
 * `error` listener, every request is awaited); this only keeps one that was
 * missed from taking the whole server down.
 *
 * @module lib/process/network-fault
 */

/**
 * The error codes of an outbound connection failing. Node's own socket and DNS
 * codes, plus undici's (what `fetch` throws), which wrap the same failures.
 */
export const NETWORK_FAULT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * The system calls a socket or DNS failure names: connecting, reading,
 * writing, and resolving a name.
 */
const NETWORK_SYSCALLS: ReadonlySet<string> = new Set([
  'connect',
  'read',
  'write',
  'getaddrinfo',
  'getnameinfo',
  'queryA',
  'queryAaaa',
]);

/** The fields of an error this module reads. */
interface ErrorFields {
  code?: unknown;
  syscall?: unknown;
  cause?: unknown;
  stack?: unknown;
}

/**
 * Whether one error, as given, is an outbound connection failing.
 *
 * An errno code needs a socket or DNS `syscall` beside it, so an `EPIPE` from
 * writing a file, or a code some library reused, does not count. undici's codes
 * are its socket layer by definition and carry no `syscall`, so the code alone
 * counts for them.
 *
 * @param value - Anything thrown or rejected.
 */
function isNetworkFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { code, syscall } = value as ErrorFields;
  if (typeof code !== 'string' || !NETWORK_FAULT_CODES.has(code)) return false;
  if (code.startsWith('UND_ERR_')) return true;
  return typeof syscall === 'string' && NETWORK_SYSCALLS.has(syscall);
}

/**
 * Whether an uncaught error or unhandled rejection is an outbound network
 * failure the server should survive.
 *
 * `fetch` rejects with `TypeError('fetch failed')` and puts the real failure in
 * `cause`, so one level of `cause` is read too. A `TypeError` whose cause is not
 * a network failure is still a `TypeError`, and still fatal.
 *
 * @param value - Anything thrown or rejected.
 */
export function isSurvivableNetworkFault(value: unknown): boolean {
  if (isNetworkFailure(value)) return true;
  const cause = typeof value === 'object' && value !== null ? (value as ErrorFields).cause : null;
  return isNetworkFailure(cause);
}

/**
 * Where a failure came from: the first stack frame outside Node's own code, or
 * `unknown`. One line, so the warning names the code path that missed a handler.
 *
 * @param value - The error.
 */
export function faultOrigin(value: unknown): string {
  const stack = typeof value === 'object' && value !== null ? (value as ErrorFields).stack : null;
  if (typeof stack !== 'string') return 'unknown';
  const frame = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ') && !line.includes('node:'));
  return frame ? frame.slice(3) : 'unknown';
}

/** What {@link createProcessFaultHandlers} reports to and stops with. */
export interface ProcessFaultDeps {
  /** Logs a survived network failure. */
  warn: (message: string, data: Record<string, unknown>) => void;
  /** Logs, reports and exits non-zero; never returns control to the caller's state. */
  fatal: (kind: 'uncaughtException' | 'unhandledRejection', value: unknown) => void;
}

/** The two process handlers, and how many network failures they have survived. */
export interface ProcessFaultHandlers {
  /** For `process.on('uncaughtException')`. */
  onUncaughtException: (error: unknown) => void;
  /** For `process.on('unhandledRejection')`. */
  onUnhandledRejection: (reason: unknown) => void;
  /** How many network failures were survived since start. */
  survivedCount: () => number;
}

/**
 * Build the process's last-resort handlers: survive an outbound network
 * failure with one warning, end the process on anything else. The same split
 * holds for an uncaught error and an unhandled rejection.
 *
 * @param deps - Where a survived failure is logged, and how a fatal one ends.
 */
export function createProcessFaultHandlers(deps: ProcessFaultDeps): ProcessFaultHandlers {
  let survived = 0;
  const handle = (kind: 'uncaughtException' | 'unhandledRejection', value: unknown) => {
    if (!isSurvivableNetworkFault(value)) {
      deps.fatal(kind, value);
      return;
    }
    survived += 1;
    const failure = isNetworkFailure(value) ? value : (value as ErrorFields).cause;
    deps.warn('[DorkOS] A network connection failed and nothing caught it; still running', {
      kind,
      code: (failure as ErrorFields).code,
      origin: faultOrigin(value),
      survived,
    });
  };
  return {
    onUncaughtException: (error) => handle('uncaughtException', error),
    onUnhandledRejection: (reason) => handle('unhandledRejection', reason),
    survivedCount: () => survived,
  };
}
