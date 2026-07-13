/**
 * Cockpit crash reporting (DOR-318, ADR 260713-143958 Phase 6).
 *
 * Relays caught top-level React errors, `window` `error` events, and
 * `unhandledrejection`s to the server via `transport.reportError`, which the
 * server rebuilds, scrubs, and (only when the user opted in) forwards to PostHog
 * Error Tracking. The client never scrubs and never gates — it just relays the
 * three raw `Error` strings.
 *
 * Two guarantees keep this from becoming a noise amplifier:
 *   - **Dedup**: one report per unique error per session. A crash that fires the
 *     React hook AND the boundary AND a `window` listener reports once.
 *   - **Never loop**: every path swallows its own failures, so a reporting error
 *     can't itself trigger another report.
 *
 * @module shared/lib/client-error-reporter
 */

import type { Transport } from '@dorkos/shared/transport';

/**
 * Signatures already reported this session. Bounded so a runaway error loop
 * can't grow it without limit; once full, new distinct errors are simply not
 * reported (better than unbounded memory or a report storm).
 */
const seen = new Set<string>();
const MAX_SEEN = 200;

/** Build a stable dedup key from an error's identity + first stack line. */
function signature(name: string, message: string, stack: string | undefined): string {
  const firstFrame = (stack ?? '').split('\n')[1]?.trim() ?? '';
  return `${name}::${message}::${firstFrame}`;
}

/**
 * Report one caught error to the server, deduped for this session. Best-effort
 * and completely silent on failure — it must never throw or recurse.
 *
 * @param transport - The active transport (its `reportError` is fire-and-forget).
 * @param error - The caught value (an `Error` or anything thrown).
 */
export function reportClientError(transport: Pick<Transport, 'reportError'>, error: unknown): void {
  try {
    const isError = error instanceof Error;
    const name = isError ? error.name || 'Error' : 'UnknownError';
    const message = isError ? error.message : String(error);
    const stack = isError ? error.stack : undefined;

    const key = signature(name, message, stack);
    if (seen.has(key)) return;
    if (seen.size < MAX_SEEN) seen.add(key);

    // Fire-and-forget: reportError swallows its own errors, but guard anyway.
    void Promise.resolve(transport.reportError({ name, message, stack })).catch(() => {});
  } catch {
    // Reporting must never destabilize the app or loop.
  }
}

/**
 * Install global `error` + `unhandledrejection` listeners that relay through
 * {@link reportClientError}. Returns an uninstall function. Idempotent per call;
 * the app shell installs it once at startup and never tears it down.
 *
 * @param transport - The active transport.
 */
export function installClientErrorHandlers(transport: Pick<Transport, 'reportError'>): () => void {
  const onError = (event: ErrorEvent): void => {
    reportClientError(transport, event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    reportClientError(transport, event.reason);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Reset dedup state. Test-only. */
export function __resetClientErrorReporterForTests(): void {
  seen.clear();
}
