/**
 * In-process event fan-out broadcaster for the unified global event stream.
 *
 * Manages a set of connected clients and distributes events to all of them.
 * Every event carries a name (`room_created`, `session_status`, …) and clients
 * filter by it, which is what makes one connection enough for every broadcast
 * the server produces.
 *
 * The stream is served over BOTH a WebSocket (what the cockpit uses) and SSE
 * (the public integration contract) — see
 * `services/core/durable-stream-sink.ts` for why. Clients of either kind reach
 * this through the narrow {@link FanOutClient} port, so a broadcast is written
 * once and lands on every reader whatever it speaks.
 *
 * @module services/event-fan-out
 */
import { encodeStreamFrame } from '@dorkos/shared/stream-socket';
import { SSE } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';
import type { CallerPrincipal } from '../../lib/caller-principal.js';

/**
 * One broadcast, pre-rendered for both wire formats.
 *
 * Both encodings are computed ONCE per broadcast and handed to every client,
 * however many are connected on either protocol. That is the property this
 * whole port exists to protect: a client that serialized for itself would be
 * invisible until it was expensive.
 */
export interface EncodedBroadcast {
  /** The event name, e.g. `room_created`. */
  readonly event: string;
  /** The JSON stream frame — the WebSocket wire format. */
  readonly json: string;
  /** The `event:`/`data:` lines — the SSE wire format. */
  readonly sse: string;
}

/**
 * One connected reader of the global stream.
 *
 * A port rather than a `ws.WebSocket` or an Express `Response`, because the
 * stream is served over both — and because this module is depended on by every
 * service that broadcasts, so it must not depend on either transport. Tests
 * drive a fan-out with a recording client.
 */
export interface FanOutClient {
  /** Deliver one broadcast, picking the encoding this client's wire needs. */
  send(broadcast: EncodedBroadcast): void;
  /** Bytes queued for this client and not yet flushed to its socket. */
  readonly bufferedBytes: number;
  /** Whether this client has disconnected. */
  readonly gone: boolean;
  /** Drop a client that cannot keep up; it reconnects and re-baselines. */
  drop(): void;
}

/**
 * Render one event into both wire formats.
 *
 * Exported because a frame does not always go to everyone: a client that has
 * just connected is sent its own connect preamble — the `connected` frame and
 * the fleet's current lifecycles — which nobody else needs and which would be
 * duplicate noise on every other open connection. Those writes go through the
 * same {@link FanOutClient.send} port as a broadcast, so they need the same
 * encoding, and there must be exactly one encoder or the two paths drift.
 *
 * @param eventName - The event name, e.g. `session_status`.
 * @param data - The payload; serialized once per format.
 */
export function encodeBroadcast(eventName: string, data: unknown): EncodedBroadcast {
  return {
    event: eventName,
    json: encodeStreamFrame({ event: eventName, data }),
    sse: `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`,
  };
}

/**
 * Decide, per connected client, whether one broadcast is that client's to
 * receive.
 *
 * Omitted at the call site means everyone, which is what every event on this bus
 * has always meant and what all but one still mean. The one exception is
 * `interaction_pending`, which carries a prompt's detail — the tool, the command
 * and the working directory — and so goes only to a connection entitled to it
 * (ADR 260819-022912).
 *
 * @param principal - What the connection registered itself as.
 * @returns Whether to write the frame to that connection.
 */
export type BroadcastAudience = (principal: CallerPrincipal) => boolean;

/**
 * A listener on the in-process half of the global event stream.
 *
 * Deliberately not exported: the one subscriber passes an inline arrow, and an
 * exported alias nothing imports is a name to keep in sync for no reader.
 *
 * @param eventName - The event name, e.g. `'room_created'`.
 * @param data - The LIVE payload object the broadcaster was handed — not a copy
 *   and not its serialization. See {@link EventFanOut.subscribe} for what that
 *   obliges a listener to do.
 */
type EventFanOutListener = (eventName: string, data: unknown) => void;

/**
 * In-process event fan-out broadcaster for the unified global event stream.
 *
 * Manages a set of connected clients and distributes events to all of them.
 */
class EventFanOut {
  private clients = new Set<{ client: FanOutClient; principal: CallerPrincipal }>();
  private listeners = new Set<EventFanOutListener>();

  /**
   * Whether another client may connect.
   *
   * Asked BEFORE the WebSocket handshake so a server at capacity refuses with a
   * readable `503` instead of opening a socket and closing it — the same
   * ordering the SSE version kept by registering before it wrote its headers.
   */
  hasCapacity(): boolean {
    return this.clients.size < SSE.MAX_TOTAL_CLIENTS;
  }

  /**
   * Register a client. Returns an unsubscribe function.
   *
   * Re-checks capacity rather than trusting {@link hasCapacity}: the two are
   * separated by a handshake, and a full fan-out must stay full.
   *
   * @param client - The connected reader.
   * @param principal - Who is on the other end, for the events that are
   *   addressed rather than broadcast. **Required, never defaulted**: a default
   *   would be a silent allow for the next stream somebody adds, which is the
   *   argument `UpgradeRoute.credential` already makes — the gate gets tested,
   *   the WIRING of it does not. Both transports read it from the same
   *   `res.locals`-shaped facts through `readCallerPrincipal`.
   */
  addClient(client: FanOutClient, principal: CallerPrincipal): () => void {
    if (this.clients.size >= SSE.MAX_TOTAL_CLIENTS) {
      logger.warn(`[EventFanOut] Max clients reached (${SSE.MAX_TOTAL_CLIENTS}), rejecting`);
      client.drop();
      return () => {};
    }
    const entry = { client, principal };
    this.clients.add(entry);
    return () => {
      this.clients.delete(entry);
    };
  }

  /**
   * Observe the same events from inside this process, without an HTTP client.
   *
   * The fan-out has only ever had one kind of consumer — a browser holding a
   * `GET /api/events` connection — so "broadcast" meant "write to a client". A
   * server-side reader now needs the same events: the local `CommunityAdapter`
   * learns that a room was created, renamed or archived from here, and polling
   * the room table for a fact this bus already carries would be inventing
   * latency the process does not have.
   *
   * A listener that throws is logged and skipped rather than allowed to break
   * the broadcast: a room write must never fail because something downstream of
   * it did.
   *
   * **A listener receives every broadcast, including an addressed one.** The
   * audience a caller may pass to {@link broadcast} governs the CLIENT loop
   * only: these consumers are the server itself, not callers, so there is no
   * principal to ask about and nothing an audience could mean here.
   *
   * **Two contracts a listener owes, both easy to violate by accident:**
   *
   * 1. **Treat `data` as read-only.** Listeners run BEFORE the HTTP fan-out and
   *    are handed the caller's own object, not a copy and not the JSON. A
   *    listener that mutated it would silently change what every connected
   *    browser then receives, with nothing between the two to notice.
   * 2. **Do little, and do it fast.** This runs synchronously on the write path
   *    ahead of every connected client, so whatever a listener costs is added to the
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
   * How many in-process listeners are attached right now.
   *
   * @internal Exported so a test can prove a short-lived subscriber (the
   *   in-session approval hold) released its listener on every ending, including
   *   the ones that skip the happy path.
   */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Broadcast an event to every connected client, and to every in-process
   * listener.
   *
   * Backpressure: a frame a client cannot take immediately still buffers in
   * process memory, so a slow consumer cannot lose frames mid-stream — but one
   * whose buffer grows past {@link SSE.MAX_BUFFERED_BYTES} is dropped instead of
   * accumulating unbounded memory. The client reconnects and re-baselines, which
   * is the honest recovery for a consumer that can't keep up with a fan-out that
   * cannot await any single client.
   *
   * The frame is encoded ONCE per wire format and the same strings sent to
   * every client — see {@link EncodedBroadcast}. That stays true of an
   * addressed broadcast: the audience decides who a frame is written to, never
   * how many times it is rendered.
   *
   * A client the audience skips is left exactly as it was — not measured for
   * backpressure, not dropped, not removed from the set. It is simply not this
   * frame's reader.
   *
   * @param eventName - The event name, e.g. `session_status`.
   * @param data - The payload, serialized once per wire format.
   * @param audience - Which connections this frame is for. Omitted means every
   *   one of them, which is what all but one event on this bus mean — see
   *   {@link BroadcastAudience}.
   */
  broadcast(eventName: string, data: unknown, audience?: BroadcastAudience): void {
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
    const broadcast = encodeBroadcast(eventName, data);
    for (const entry of this.clients) {
      const { client } = entry;
      if (client.gone) {
        this.clients.delete(entry);
        continue;
      }
      if (audience && !audience(entry.principal)) continue;
      try {
        client.send(broadcast);
        if (client.bufferedBytes > SSE.MAX_BUFFERED_BYTES) {
          logger.warn('[EventFanOut] dropping slow client (buffer over limit)', {
            bufferedBytes: client.bufferedBytes,
          });
          client.drop();
          this.clients.delete(entry);
        }
      } catch {
        this.clients.delete(entry);
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
