/**
 * The one continue per limit episode (spec `claude-account-fleet` D9, "One
 * carry-over per limit episode, race-free"): a marker keyed by (session,
 * `limit.since`), set synchronously before any await and shared by a person's
 * continue and core's automatic handoff, so a second caller joins the first
 * one's promise and gets the same new session.
 *
 * Also the refusal both of them throw.
 *
 * @module services/session/fleet/continue-in-flight
 */
import type { ContinueSessionResponse } from '@dorkos/shared/schemas';
import type { StoredSessionLimit } from './session-limit-store.js';

/** Why a continue, wait or cancel was refused, with the status the route answers. */
export class ContinueError extends Error {
  /**
   * Build a refusal.
   *
   * @param status - The HTTP status the route answers.
   * @param code - A stable machine-readable code.
   * @param message - The sentence shown to a person.
   */
  constructor(
    readonly status: 400 | 409 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ContinueError';
  }
}

/** Continues in flight (a carry-over or a claimed move), per limit episode. */
const inFlight = new Map<string, Promise<ContinueSessionResponse>>();

/**
 * The key of a stored limit's episode.
 *
 * @param stored - The session's stored limit.
 */
export function episodeKey(stored: StoredSessionLimit): string {
  return `${stored.sessionId}\u0000${stored.limit.since}`;
}

/**
 * The continue already moving this episode, if any.
 *
 * @param key - The episode's key.
 */
export function continueInFlight(key: string): Promise<ContinueSessionResponse> | undefined {
  return inFlight.get(key);
}

/**
 * Mark `run` as the episode's continue until it settles. Call it in the same
 * synchronous step that checked {@link continueInFlight}.
 *
 * @param key - The episode's key.
 * @param run - The continue, started.
 * @returns The same continue, which clears its marker when it settles.
 */
export function trackContinue(
  key: string,
  run: Promise<ContinueSessionResponse>
): Promise<ContinueSessionResponse> {
  const tracked = run.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
  inFlight.set(key, tracked);
  return tracked;
}

/** Forget every continue in flight (shutdown and tests). */
export function clearContinuesInFlight(): void {
  inFlight.clear();
}
