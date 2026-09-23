/**
 * In-memory breadcrumb ring buffer for bug reports (feedback-pipeline spec
 * Part 1).
 *
 * Captures a bounded trail of recent client-side signals — console
 * errors/warnings, TanStack Query/Mutation failures, and durable-stream
 * disconnects — so a bug report can carry "what just happened" without the
 * user retyping it. In-memory only: never persisted, cleared on reload, capped
 * at {@link MAX_BREADCRUMBS} so a runaway error loop can't grow it without
 * bound.
 *
 * `installBreadcrumbHandlers` is called once at startup (`main.tsx`, alongside
 * `installClientErrorHandlers`); `addBreadcrumb` is called directly by the
 * QueryCache/MutationCache error handlers (`query-client.ts`) and the durable
 * session stream's disconnect handler (`transport/stream-manager.ts`).
 * `console.error`/`console.warn` are WRAPPED, not replaced — the original
 * always still runs, so devtools output is unaffected.
 *
 * @module shared/lib/breadcrumbs
 */
import { redactPaths, redactTokens, redactUrlQueries } from '@dorkos/shared/error-report';
import {
  MAX_BREADCRUMBS,
  MAX_BREADCRUMB_MESSAGE_LEN,
  type Breadcrumb,
} from '@dorkos/shared/telemetry-events';

/** The ring buffer itself, oldest first. Never exceeds {@link MAX_BREADCRUMBS}. */
const buffer: Breadcrumb[] = [];

/**
 * Scrub text before it can leave the machine inside a bug report: web-address
 * query strings, home-directory paths and secret-shaped tokens — the same three
 * passes the report's log excerpts get, in the order `redactUrlQueries` asks for.
 *
 * Exported because breadcrumbs are not the only text a report's diagnostics
 * carry: a crash report folds its stack trace in beside them
 * (`features/feedback/model/use-send-feedback.ts`), and it needs the identical
 * scrub.
 *
 * @param text - Arbitrary text that may embed a path, a URL or a credential.
 */
export function redactBreadcrumb(text: string): string {
  return redactTokens(redactPaths(redactUrlQueries(text)));
}

/**
 * Record one breadcrumb, evicting the oldest entry once the buffer is full.
 *
 * Redacted here because every breadcrumb this module collects comes through
 * this function — the console wrappers below, the query-cache error handlers
 * and the stream's disconnect handler alike — and nothing downstream scrubs
 * them. Redaction runs before the cap, so the cap is applied to text that has
 * already been scrubbed.
 *
 * @param kind - Which signal produced this breadcrumb.
 * @param message - A description of what happened, redacted and truncated to
 *   {@link MAX_BREADCRUMB_MESSAGE_LEN}.
 */
export function addBreadcrumb(kind: Breadcrumb['kind'], message: string): void {
  if (buffer.length >= MAX_BREADCRUMBS) buffer.shift();
  buffer.push({
    at: new Date().toISOString(),
    kind,
    message: redactBreadcrumb(message).slice(0, MAX_BREADCRUMB_MESSAGE_LEN),
  });
}

/** The breadcrumbs collected so far, oldest first. Returns a copy; never mutated in place. */
export function getBreadcrumbs(): Breadcrumb[] {
  return [...buffer];
}

/** Clear every breadcrumb. Test-only. */
export function __resetBreadcrumbsForTests(): void {
  buffer.length = 0;
}

/**
 * A field whose value is a credential by its NAME, whatever the value looks
 * like. The text rules in `redactTokens` cannot see these once an object is
 * serialized: JSON puts a quote between a key and its value, so
 * `"password":"…"` never matches a `password: …` rule.
 *
 * Two words are narrower than a substring match, because a bare match would
 * mask the numbers a context-limit or rate-limit error is diagnosed from:
 * `token` only as the key's END (`accessToken`, `session_token`, not
 * `maxTokens` or `inputTokens`), and `session` only as `sessionKey` — a
 * session's secret, token and cookie are caught by their own words, and
 * `sessionId` and `sessions` stay readable.
 */
const SECRET_KEY = /token$|secret|password|authorization|api[_-]?key|cookie|session[_-]?key/i;

/** How deep into a logged object, or a chain of causes, a breadcrumb looks. */
const MAX_DEPTH = 4;

/** Read one property, answering a marker instead of throwing when a getter does. */
function readField(target: object, key: PropertyKey): unknown {
  try {
    return (target as Record<PropertyKey, unknown>)[key];
  } catch {
    return '[unreadable]';
  }
}

/**
 * A copy of a logged value that is safe to serialize and safe to send.
 *
 * Built field by field rather than by redacting the JSON afterwards: a field
 * named like a credential is masked whatever its value, and every string is
 * scrubbed on its own, before JSON escapes a Windows path's backslashes into
 * a shape `redactPaths` no longer recognises. Never throws — a getter that
 * does, a cycle, a symbol or a bigint each become a readable marker.
 */
function toSafeJson(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactBreadcrumb(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined || typeof value === 'function') return undefined;
  if (typeof value === 'symbol' || typeof value === 'bigint') return value.toString();
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[…]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toSafeJson(item, depth + 1, seen));
  if (isErrorLike(value)) return describeError(value, depth + 1, seen);
  const copy: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return '[unreadable]';
  }
  for (const key of keys) {
    copy[key] = SECRET_KEY.test(key)
      ? '[redacted]'
      : toSafeJson(readField(value, key), depth + 1, seen);
  }
  return copy;
}

/** `JSON.stringify` of an already-safe copy; the fallback only guards the impossible. */
function serialize(value: unknown): string {
  try {
    return JSON.stringify(toSafeJson(value, 0, new WeakSet())) ?? '[undefined]';
  } catch {
    return '[unserializable]';
  }
}

/** Whether a value is an Error, from this frame or another (where `instanceof Error` is false). */
function isErrorLike(value: unknown): value is object {
  if (value instanceof Error) return true;
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof readField(value, 'name') === 'string' && typeof readField(value, 'message') === 'string'
  );
}

/** A field of an error as text, whatever it turned out to be. */
function fieldText(error: object, key: string): string {
  const value = readField(error, key);
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '[unreadable]';
  }
}

/**
 * Describe an error as `Name: message`, plus what makes it THIS error.
 *
 * `JSON.stringify` answers `{}` for an Error — its `name` and `message` are not
 * own enumerable properties — which is how every error a React error boundary
 * logged used to reach a bug report (DOR-2230). The error's own fields (an
 * `AppCaptureError`'s `reason`, say) follow as compact, redacted JSON, and its
 * `cause` after that, because either can be the actual diagnosis. Never
 * throws: an error is the one thing that is most likely to be odd.
 */
function describeError(error: object, depth = 0, seen = new WeakSet<object>()): string {
  seen.add(error);
  let text = `${fieldText(error, 'name')}: ${fieldText(error, 'message')}`;
  const own: Record<string, unknown> = {};
  let keys: string[] = [];
  try {
    keys = Object.keys(error);
  } catch {
    // No own fields to add; the name and message still stand.
  }
  for (const key of keys) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
    own[key] = SECRET_KEY.test(key)
      ? '[redacted]'
      : toSafeJson(readField(error, key), depth + 1, seen);
  }
  if (Object.keys(own).length > 0) text += ` ${JSON.stringify(own)}`;
  const cause = readField(error, 'cause');
  if (cause !== undefined && depth < MAX_DEPTH) {
    const causeText =
      typeof cause === 'object' && cause !== null && seen.has(cause)
        ? '[circular]'
        : isErrorLike(cause)
          ? describeError(cause, depth + 1, seen)
          : JSON.stringify(toSafeJson(cause, depth + 1, seen));
    text += ` (cause: ${causeText})`;
  }
  return text;
}

/** Best-effort text for a non-string console argument. Never throws. */
function safeStringify(value: unknown): string {
  try {
    return isErrorLike(value) ? describeError(value) : serialize(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Join a `console.error`/`console.warn` argument list into one bounded string.
 *
 * Bounded loosely here and exactly in {@link addBreadcrumb}, which caps after
 * redacting. That ordering makes a token cut in half by the cap less likely,
 * not impossible: this looser bound can still split one. It exists only to keep
 * a huge logged object from being carried into the redaction pass whole.
 */
function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
    .join(' ')
    .slice(0, MAX_BREADCRUMB_MESSAGE_LEN * 4);
}

/**
 * Install the console breadcrumb collectors: `console.error`/`console.warn`
 * are wrapped (never replaced — the original call always still runs) so every
 * call also records a breadcrumb. Returns an uninstall function. Idempotent
 * per call; the app shell installs it once at startup and never tears it down.
 */
export function installBreadcrumbHandlers(): () => void {
  const originalError = console.error;
  const originalWarn = console.warn;

  // The breadcrumb is a bonus and the log is the point: recording one may
  // never cost the original call, whatever was logged.
  console.error = (...args: unknown[]): void => {
    try {
      addBreadcrumb('console_error', formatConsoleArgs(args));
    } catch {
      // Dropped breadcrumb; the log below still runs.
    }
    originalError.apply(console, args);
  };
  console.warn = (...args: unknown[]): void => {
    try {
      addBreadcrumb('console_warn', formatConsoleArgs(args));
    } catch {
      // Dropped breadcrumb; the log below still runs.
    }
    originalWarn.apply(console, args);
  };

  return () => {
    console.error = originalError;
    console.warn = originalWarn;
  };
}
