/**
 * Small helpers the managed remote coordinator leans on, kept apart so the
 * coordinator reads as the ceremony it runs.
 *
 * @module services/core/remote/managed-remote-support
 */
import { CloudApiResponseError } from '@dork-labs/cloud-api/client';

/**
 * Whether a failed read was a success this build could not parse: a service a
 * release ahead. The contract says to treat such an answer as ended.
 */
export function unreadable(error: unknown): boolean {
  return error instanceof CloudApiResponseError && error.status < 400;
}

/** A loggable name for an error: its class, never its message (which could carry a body). */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
