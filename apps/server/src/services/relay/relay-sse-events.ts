/**
 * SSE broadcast helpers for relay binding and adapter changes.
 *
 * The client polls bindings and adapter status, so a change made in another tab
 * or client — or a live adapter connect/disconnect — is invisible until the next
 * poll or a local mutation. These helpers push a lightweight "something changed,
 * re-fetch" signal onto the unified `/api/events` stream so connected clients
 * invalidate the relevant query caches immediately. The payload is intentionally
 * minimal: it is an invalidation trigger, not a diff.
 *
 * @module services/relay/relay-sse-events
 */
import { eventFanOut } from '../core/event-fan-out.js';

/**
 * Broadcast that the set of adapter↔agent bindings changed (create, update,
 * delete, or orphan cleanup). Connected clients re-fetch `['relay','bindings']`.
 */
export function broadcastBindingsChanged(): void {
  eventFanOut.broadcast('relay_bindings_changed', { changedAt: new Date().toISOString() });
}

/**
 * Broadcast that an adapter's configuration or live connection status changed.
 * Connected clients re-fetch the adapter list and catalog (`['relay','adapters']`).
 */
export function broadcastAdaptersChanged(): void {
  eventFanOut.broadcast('relay_adapters_changed', { changedAt: new Date().toISOString() });
}
