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
import type { RelayFlowEvent } from '@dorkos/shared/relay-schemas';
import { eventFanOut } from '../core/event-fan-out.js';
import type { UnclaimedChat } from './unclaimed-chat-store.js';

/**
 * Broadcast that the set of adapter↔agent bindings changed (create, update,
 * delete, or orphan cleanup). Connected clients re-fetch `['relay','bindings']`.
 */
export function broadcastBindingsChanged(): void {
  eventFanOut.broadcast('relay_bindings_changed', { changedAt: new Date().toISOString() });
}

/**
 * Broadcast a connection-state transition (connect/disconnect) of an enabled
 * adapter. Connected clients re-fetch the adapter list and catalog
 * (`['relay','adapters']`). Config-only edits, changes to disabled adapters,
 * and async in-adapter drops do not fire this — the client's 10s poll
 * backstops those.
 */
export function broadcastAdaptersChanged(): void {
  eventFanOut.broadcast('relay_adapters_changed', { changedAt: new Date().toISOString() });
}

/** Broadcast a delivered relay message across a binding edge (topology pulse). */
export function broadcastRelayFlow(flow: RelayFlowEvent): void {
  eventFanOut.broadcast('relay_flow', flow);
}

/**
 * Broadcast a NEW unclaimed chat — the claim feed's attention signal
 * (connection-scoping spec `specs/connection-scoping/` §Part 3). Fired once
 * per chat, on first sighting only (damped by `UnclaimedChatStore`), so the
 * client's Waiting-On-You/Pulse surfaces can subscribe without being flooded
 * by a spammy chat's repeat messages. Carries the same fields the row
 * persists — sender name/id, chat/adapter/channel identity, timestamp —
 * never a message body.
 */
export function broadcastUnclaimedChat(chat: UnclaimedChat): void {
  eventFanOut.broadcast('relay_chat_unclaimed', chat);
}
