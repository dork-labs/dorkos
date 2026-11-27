/**
 * The frames of the global event stream, `GET /api/events`: how one broadcast
 * is encoded for both wires, and which reader gets which rendering. Split from
 * `event-fan-out.ts`, which owns the readers and the numbering.
 *
 * @module lib/event-stream/global-event-frames
 */
import { encodeStreamFrame } from '@dorkos/shared/stream-socket';
import type { CallerPrincipal } from '../caller-principal.js';

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
 * Decide, per connected client, whether one broadcast is that client's to
 * receive.
 *
 * Omitted at the call site means everyone, which is what most events on this
 * bus mean. Room events and `read_cursor` must name one: both say what a person
 * did in a place only some readers may see, so omitting it sends nothing. An
 * event carrying detail, like `interaction_pending` (the tool, the command and
 * the working directory), goes only to a connection entitled to it
 * (ADR 260819-022912).
 *
 * @param principal - What the connection registered itself as.
 * @returns Whether to write the frame to that connection.
 */
export type BroadcastAudience = (principal: CallerPrincipal) => boolean;

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
 * @param id - The frame id, for a frame with a place in the stream. A preamble
 *   frame is a snapshot and has none.
 */
export function encodeBroadcast(eventName: string, data: unknown, id?: string): EncodedBroadcast {
  return {
    event: eventName,
    json: encodeStreamFrame(
      id === undefined ? { event: eventName, data } : { event: eventName, data, id }
    ),
    sse: `${id === undefined ? '' : `id: ${id}\n`}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`,
  };
}

/**
 * One numbered broadcast: its encoded frames and who may read which. The same
 * record serves the live write and a replay, so both use one filter, asked with
 * the reader's rights at the moment each is written.
 */
export interface Delivery {
  /** The frame for a reader entitled to the whole payload. */
  readonly full: EncodedBroadcast;
  /** The frame for everyone else, when the event has a redacted rendering. */
  readonly redacted?: EncodedBroadcast;
  /** Who gets {@link Delivery.full} rather than {@link Delivery.redacted}. */
  readonly entitled?: BroadcastAudience;
  /** Who gets either; absent means every reader. */
  readonly audience?: BroadcastAudience;
}

/**
 * The frame one reader is owed, or none.
 *
 * @param delivery - The broadcast.
 * @param principal - The reader.
 */
export function frameFor(
  delivery: Delivery,
  principal: CallerPrincipal
): EncodedBroadcast | undefined {
  if (delivery.audience && !delivery.audience(principal)) return undefined;
  if (!delivery.entitled || delivery.entitled(principal)) return delivery.full;
  return delivery.redacted;
}

/**
 * The bytes one delivery holds: every rendering, on both wires.
 *
 * @param delivery - The broadcast.
 */
export function deliveryBytes(delivery: Delivery): number {
  const of = (frame: EncodedBroadcast | undefined): number =>
    frame ? Buffer.byteLength(frame.sse) + Buffer.byteLength(frame.json) : 0;
  return of(delivery.full) + of(delivery.redacted);
}
