/**
 * Which computers have a live relay connection to this hub, so the relayed
 * chat view (part 2b) can find one by id.
 *
 * One live connection per computer. A new dial replaces the live one only once
 * its `finish` has verified, so a stolen relay secret alone cannot knock the
 * real computer off. Until then a dial waits in `pending`. Up to
 * {@link HUB_RELAY_MAX_PENDING_DIALS} unproved dials per computer wait at
 * once, the oldest closed beyond that, so someone looping dials with a stolen
 * secret holds only a few sockets open and cannot keep evicting the real
 * computer's dial before its `finish` arrives.
 *
 * @module services/core/hub-relay/hub-relay-registry
 */
import { logger } from '../../../lib/logger.js';
import type { HubComputerConnection } from './computer-connection.js';

/** Most unproved dials one computer may have waiting at once. */
export const HUB_RELAY_MAX_PENDING_DIALS = 3;

const live = new Map<string, HubComputerConnection>();
/** Each computer's unproved dials, oldest first. */
const pending = new Map<string, HubComputerConnection[]>();
const promotedListeners = new Set<(connection: HubComputerConnection) => void>();

/**
 * Be told each time a connection becomes its computer's live one.
 *
 * @param listener - Called with the newly live connection. A throw is logged.
 * @returns Stop listening.
 */
export function onConnectionPromoted(
  listener: (connection: HubComputerConnection) => void
): () => void {
  promotedListeners.add(listener);
  return () => {
    promotedListeners.delete(listener);
  };
}

/** Take a connection out of its computer's pending list. */
function unpend(connection: HubComputerConnection): void {
  const waiting = pending.get(connection.computerId);
  if (!waiting) return;
  const kept = waiting.filter((c) => c !== connection);
  if (kept.length > 0) pending.set(connection.computerId, kept);
  else pending.delete(connection.computerId);
}

/**
 * Note a dial that has not proved itself yet, closing the oldest unproved one
 * for the same computer once more than {@link HUB_RELAY_MAX_PENDING_DIALS} wait.
 *
 * @param connection - The new connection, still in its handshake.
 */
export function notePendingConnection(connection: HubComputerConnection): void {
  const waiting = [...(pending.get(connection.computerId) ?? []), connection];
  const evicted = waiting.splice(0, Math.max(0, waiting.length - HUB_RELAY_MAX_PENDING_DIALS));
  pending.set(connection.computerId, waiting);
  for (const older of evicted) older.close(1000);
}

/**
 * Make a proved connection the computer's live one, closing the one it
 * replaces. Pass as the connection's `onOpen`.
 *
 * @param connection - The connection whose `finish` just verified.
 */
export function promoteConnection(connection: HubComputerConnection): void {
  unpend(connection);
  const older = live.get(connection.computerId);
  live.set(connection.computerId, connection);
  if (older && older !== connection) older.close(1000);
  for (const listener of promotedListeners) {
    try {
      listener(connection);
    } catch (error) {
      logger.warn('[HubRelay] A connection listener threw', { error: (error as Error).name });
    }
  }
}

/**
 * Forget a connection that ended, unless it was already replaced. Pass as the
 * connection's `onClose`.
 *
 * @param connection - The connection that ended.
 */
export function forgetConnection(connection: HubComputerConnection): void {
  unpend(connection);
  if (live.get(connection.computerId) === connection) live.delete(connection.computerId);
}

/**
 * The computer's live, proved connection, or `null` when it is not connected.
 *
 * @param computerId - The computer to look up.
 */
export function computerConnection(computerId: string): HubComputerConnection | null {
  const connection = live.get(computerId);
  return connection?.connected ? connection : null;
}

/**
 * Close every connection a computer has, live or pending. Called when it is
 * unlinked, and when the hub shuts down.
 *
 * @param computerId - The computer to disconnect.
 */
export function dropComputerConnection(computerId: string): void {
  for (const waiting of [...(pending.get(computerId) ?? [])]) waiting.close(1000);
  live.get(computerId)?.close(1000);
}

/** Close every relay connection this hub holds. At shutdown. */
export function closeAllComputerConnections(): void {
  for (const connection of [...[...pending.values()].flat(), ...live.values()]) {
    connection.close(1001);
  }
}
