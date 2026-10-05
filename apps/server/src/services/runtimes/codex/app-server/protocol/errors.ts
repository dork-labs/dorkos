/**
 * Error classification for `codex app-server` (protocol §1, risk 8).
 *
 * Every rejection the 0.154 binary sends uses code `-32600`, whether the
 * method is unknown, the thread is missing or the turn already ended, so the
 * only way to tell them apart is the message text. One table, here, does that;
 * nothing else in DorkOS matches on Codex's wording.
 *
 * @module services/runtimes/codex/app-server/protocol/errors
 */

/** What a rejection means, as far as DorkOS acts on it. */
export type CodexRpcErrorKind =
  | 'not-initialized'
  | 'already-initialized'
  | 'unknown-method'
  | 'thread-not-found'
  | 'no-rollout'
  | 'no-active-turn'
  | 'turn-mismatch'
  | 'not-steerable'
  | 'experimental-required'
  | 'overloaded'
  | 'other';

/** The JSON-RPC code Codex answers `Server overloaded; retry later.` with. */
export const OVERLOADED_CODE = -32001;

/**
 * Message patterns, in the order they are tried. Each was observed against the
 * pinned binary (protocol §1 and §3, spikes 1b and 4).
 */
const MESSAGE_PATTERNS: ReadonlyArray<readonly [RegExp, CodexRpcErrorKind]> = [
  [/^Not initialized/i, 'not-initialized'],
  [/^Already initialized/i, 'already-initialized'],
  [/unknown variant/i, 'unknown-method'],
  [/^thread not found/i, 'thread-not-found'],
  [/no rollout found for thread id/i, 'no-rollout'],
  [/no active turn to (steer|interrupt)/i, 'no-active-turn'],
  [/expected active turn id/i, 'turn-mismatch'],
  [/requires experimentalApi capability/i, 'experimental-required'],
];

/**
 * Classify one JSON-RPC error object.
 *
 * @param error - The `error` member of a response.
 */
export function classifyCodexRpcError(error: {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}): CodexRpcErrorKind {
  if (error.code === OVERLOADED_CODE) return 'overloaded';
  if (hasActiveTurnNotSteerable(error.data)) return 'not-steerable';
  const message = typeof error.message === 'string' ? error.message : '';
  for (const [pattern, kind] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return 'other';
}

function hasActiveTurnNotSteerable(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const info = (data as { codexErrorInfo?: unknown }).codexErrorInfo;
  return typeof info === 'object' && info !== null && 'activeTurnNotSteerable' in info;
}

/** A request the server rejected. */
export class CodexRpcError extends Error {
  /** What the rejection means. */
  readonly kind: CodexRpcErrorKind;
  /** The JSON-RPC code. */
  readonly code: number | undefined;
  /** The method that was rejected. */
  readonly method: string;

  /**
   * Construct from a response's error object.
   *
   * @param method - The request's method.
   * @param error - The response's `error` member.
   */
  constructor(method: string, error: { code?: unknown; message?: unknown; data?: unknown }) {
    const message = typeof error.message === 'string' ? error.message : 'unknown error';
    super(`Codex rejected ${method}: ${message}`);
    this.name = 'CodexRpcError';
    this.kind = classifyCodexRpcError(error);
    this.code = typeof error.code === 'number' ? error.code : undefined;
    this.method = method;
  }
}

/** A request that got no answer in time. */
export class CodexRpcTimeoutError extends Error {
  /** The method that timed out. */
  readonly method: string;

  /**
   * Construct for one timed-out request.
   *
   * @param method - The request's method.
   * @param timeoutMs - The bound that passed.
   */
  constructor(method: string, timeoutMs: number) {
    super(`Codex did not answer ${method} within ${timeoutMs}ms`);
    this.name = 'CodexRpcTimeoutError';
    this.method = method;
  }
}

/** The process went away (exit, protocol fault, closed pipe) with the request pending. */
export class CodexProcessExitedError extends Error {
  /** Why the connection ended, for the log and the error's details. */
  readonly detail: string;

  /**
   * Construct with the reason the connection ended.
   *
   * @param detail - Exit code/signal, or the protocol fault.
   */
  constructor(detail: string) {
    super(`Codex stopped: ${detail}`);
    this.name = 'CodexProcessExitedError';
    this.detail = detail;
  }
}

/**
 * Whether an error is a rejection of the given kind.
 *
 * @param err - Anything thrown.
 * @param kinds - The kinds to accept.
 */
export function isCodexRpcError(err: unknown, ...kinds: CodexRpcErrorKind[]): err is CodexRpcError {
  return err instanceof CodexRpcError && (kinds.length === 0 || kinds.includes(err.kind));
}
