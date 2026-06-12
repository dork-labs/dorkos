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
 * In-process event fan-out broadcaster for the unified SSE stream.
 *
 * Manages a set of connected SSE clients and distributes events to all of them.
 * Uses the SSE spec's `event:` field for type routing — clients filter by event name.
 */
class EventFanOut {
  private clients = new Set<Response>();

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
   * Broadcast an SSE event to all connected clients.
   *
   * Backpressure: a `write()` returning false still buffers in process memory,
   * so a slow consumer cannot lose frames mid-stream — but one whose buffer
   * grows past {@link SSE.MAX_BUFFERED_BYTES} is destroyed instead of
   * accumulating unbounded memory. The client's SSE layer auto-reconnects and
   * re-baselines, which is the honest recovery for a consumer that can't keep
   * up with a fan-out that cannot await any single client.
   */
  broadcast(eventName: string, data: unknown): void {
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
