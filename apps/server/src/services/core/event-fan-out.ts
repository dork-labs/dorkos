/**
 * In-process event fan-out broadcaster for the unified SSE stream.
 *
 * Manages a set of connected SSE clients and distributes events to all of them.
 * Uses the SSE spec's `event:` field for type routing — clients filter by event name.
 *
 * @module services/event-fan-out
 */
import type { Response } from 'express';
import { SSE } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

/**
 * A listener on the in-process half of the global event stream.
 *
 * Deliberately not exported: the one subscriber passes an inline arrow, and an
 * exported alias nothing imports is a name to keep in sync for no reader.
 *
 * @param eventName - The SSE event name, e.g. `'room_created'`.
 * @param data - The LIVE payload object the broadcaster was handed — not a copy
 *   and not its serialization. See {@link EventFanOut.subscribe} for what that
 *   obliges a listener to do.
 */
type EventFanOutListener = (eventName: string, data: unknown) => void;

/**
 * In-process event fan-out broadcaster for the unified SSE stream.
 *
 * Manages a set of connected SSE clients and distributes events to all of them.
 * Uses the SSE spec's `event:` field for type routing — clients filter by event name.
 */
class EventFanOut {
  private clients = new Set<Response>();
  private listeners = new Set<EventFanOutListener>();

  /** Register an SSE client. Returns an unsubscribe function. */
  addClient(res: Response): () => void {
    if (this.clients.size >= SSE.MAX_TOTAL_CLIENTS) {
      logger.warn(`[EventFanOut] Max clients reached (${SSE.MAX_TOTAL_CLIENTS}), rejecting`);
      res.status(503).json({ error: 'Too many SSE clients' });
      return () => {};
    }
    this.clients.add(res);
    return () => {
      this.clients.delete(res);
    };
  }

  /**
   * Observe the same events from inside this process, without an HTTP client.
   *
   * The fan-out has only ever had one kind of consumer — a browser holding a
   * `GET /api/events` socket — so "broadcast" meant "write to a response". A
   * server-side reader now needs the same events: the local `CommunityAdapter`
   * learns that a room was created, renamed or archived from here, and polling
   * the room table for a fact this bus already carries would be inventing
   * latency the process does not have.
   *
   * A listener that throws is logged and skipped rather than allowed to break
   * the broadcast: a room write must never fail because something downstream of
   * it did.
   *
   * **Two contracts a listener owes, both easy to violate by accident:**
   *
   * 1. **Treat `data` as read-only.** Listeners run BEFORE the HTTP fan-out and
   *    are handed the caller's own object, not a copy and not the JSON. A
   *    listener that mutated it would silently change what every connected
   *    browser then receives, with nothing between the two to notice.
   * 2. **Do little, and do it fast.** This runs synchronously on the write path
   *    ahead of every SSE client, so whatever a listener costs is added to the
   *    latency of the broadcast for everyone. Today's one subscriber (the local
   *    community adapter) spends four indexed SQLite reads on a room lifecycle
   *    event — the room, the identity, the membership and the unread count —
   *    and it spends them **once per event, not once per subscriber**, because
   *    it projects the room before fanning out. That is fine at this size, and
   *    it is written down so the second subscriber has to decide rather than
   *    discover. Work that is not cheap belongs on a queue the listener owns.
   *
   * @param listener - Called synchronously for every broadcast.
   * @returns An unsubscribe function. Idempotent.
   */
  subscribe(listener: EventFanOutListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Broadcast an SSE event to all connected clients, and to every in-process
   * listener.
   *
   * Backpressure: a `write()` returning false still buffers in process memory,
   * so a slow consumer cannot lose frames mid-stream — but one whose buffer
   * grows past {@link SSE.MAX_BUFFERED_BYTES} is destroyed instead of
   * accumulating unbounded memory. The client's SSE layer auto-reconnects and
   * re-baselines, which is the honest recovery for a consumer that can't keep
   * up with a fan-out that cannot await any single client.
   */
  broadcast(eventName: string, data: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(eventName, data);
      } catch (err) {
        logger.warn('[EventFanOut] an in-process listener threw; skipping it', {
          eventName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (client.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      try {
        const canContinue = client.write(payload);
        if (!canContinue && client.writableLength > SSE.MAX_BUFFERED_BYTES) {
          logger.warn('[EventFanOut] dropping slow SSE client (buffer over limit)', {
            bufferedBytes: client.writableLength,
          });
          client.destroy();
          this.clients.delete(client);
        }
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Number of currently connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }
}

/** Singleton event fan-out broadcaster for the unified SSE stream. */
export const eventFanOut = new EventFanOut();
