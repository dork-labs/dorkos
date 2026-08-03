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
import {
  MAX_BREADCRUMBS,
  MAX_BREADCRUMB_MESSAGE_LEN,
  type Breadcrumb,
} from '@dorkos/shared/telemetry-events';

/** The ring buffer itself, oldest first. Never exceeds {@link MAX_BREADCRUMBS}. */
const buffer: Breadcrumb[] = [];

/**
 * Record one breadcrumb, evicting the oldest entry once the buffer is full.
 *
 * @param kind - Which signal produced this breadcrumb.
 * @param message - A description of what happened, truncated to
 *   {@link MAX_BREADCRUMB_MESSAGE_LEN}.
 */
export function addBreadcrumb(kind: Breadcrumb['kind'], message: string): void {
  if (buffer.length >= MAX_BREADCRUMBS) buffer.shift();
  buffer.push({
    at: new Date().toISOString(),
    kind,
    message: message.slice(0, MAX_BREADCRUMB_MESSAGE_LEN),
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

/** Best-effort stringify for a non-string console argument. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Join a `console.error`/`console.warn` argument list into one bounded string. */
function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
    .join(' ')
    .slice(0, MAX_BREADCRUMB_MESSAGE_LEN);
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

  console.error = (...args: unknown[]): void => {
    addBreadcrumb('console_error', formatConsoleArgs(args));
    originalError.apply(console, args);
  };
  console.warn = (...args: unknown[]): void => {
    addBreadcrumb('console_warn', formatConsoleArgs(args));
    originalWarn.apply(console, args);
  };

  return () => {
    console.error = originalError;
    console.warn = originalWarn;
  };
}
