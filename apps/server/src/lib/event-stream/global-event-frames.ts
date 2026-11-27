/**
 * The frames of the global event stream, `GET /api/events`: how one broadcast
 * is encoded for both wires, and which reader gets which rendering. Split from
 * `event-fan-out.ts`, which owns the readers and the numbering.
 *
 * @module lib/event-stream/global-event-frames
 */
import { UNNUMBERED_SEQ, type DorkOsEventFrame } from '@dorkos/shared/dorkos-event-frame';
import type { DorkOsEvent, DorkOsEventType } from '@dorkos/shared/dorkos-events';
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
  /** The envelope with its cursor as `id`, as JSON — the WebSocket wire format. */
  readonly json: string;
  /** The `id:`/`event:`/`data:` lines, `data:` the envelope — the SSE wire format. */
  readonly sse: string;
}

/** Where a numbered event sits in the stream, and when it was emitted. */
export interface FramePlace {
  /** The frame id, the opaque resume cursor. */
  readonly id: string;
  /** The event's `seq`. */
  readonly seq: number;
  /** When the server emitted it, ISO 8601. Kept as is when the event is replayed. */
  readonly at: string;
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
 * Render one event into both wire formats, as a whole `DorkOsEvent` envelope
 * (DOR-5474): the SSE `data:` line is the envelope, and the socket message is
 * the envelope with the cursor beside it as `id`.
 *
 * Exported because a frame does not always go to everyone: a client that has
 * just connected is sent its own connect preamble — the `connected` frame and
 * the fleet's current lifecycles — which nobody else needs and which would be
 * duplicate noise on every other open connection. Those writes go through the
 * same {@link FanOutClient.send} port as a broadcast, so they need the same
 * encoding, and there must be exactly one encoder or the two paths drift.
 *
 * @param type - The event type, e.g. `session_status`.
 * @param payload - The event's data; serialized once per format.
 * @param place - The frame's place in the stream, for a numbered event. A
 *   preamble frame or a keepalive is not one: it goes out with `seq` 0, the
 *   time now and no id.
 */
export function encodeBroadcast(
  type: DorkOsEventType,
  payload: unknown,
  place?: FramePlace
): EncodedBroadcast {
  const envelope: DorkOsEvent = {
    seq: place?.seq ?? UNNUMBERED_SEQ,
    at: place?.at ?? new Date().toISOString(),
    type,
    payload,
  };
  const frame: DorkOsEventFrame = place ? { ...envelope, id: place.id } : envelope;
  return {
    event: type,
    json: JSON.stringify(frame),
    sse: `${place ? `id: ${place.id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`,
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
