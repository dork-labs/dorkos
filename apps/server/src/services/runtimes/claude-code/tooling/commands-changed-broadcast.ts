/**
 * Tell connected clients the command registry changed, split out of
 * `claude-code-runtime.ts`.
 *
 * @module services/runtimes/claude-code/tooling/commands-changed-broadcast
 */
import { eventFanOut } from '../../../core/event-fan-out.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Broadcast a `commands_changed` event on the unified `/api/events` stream so
 * connected clients invalidate their command-registry query and re-fetch.
 * Best-effort: a broadcast failure must never break the install path.
 */
export function broadcastCommandsChanged(): void {
  try {
    eventFanOut.broadcast('commands_changed', { changedAt: new Date().toISOString() });
  } catch (err) {
    // warn, not debug: a failed broadcast means OTHER connected windows never
    // learn to re-fetch, so their command palette stays stale until a manual
    // reload (the initiating window still has its mutation-side invalidation).
    logger.warn('[refreshActivatedPlugins] commands_changed broadcast failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
