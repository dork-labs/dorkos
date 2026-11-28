/**
 * The frames of the global event stream, `GET /api/events`: how one broadcast
 * is encoded for both wires, and which reader gets it. Split from
 * `event-fan-out.ts`, which owns the readers and the numbering.
 *
 * @module lib/event-stream/global-event-frames
 */
import type { DorkOsEventFrame } from '@dorkos/shared/dorkos-event-frame';
import type { DorkOsEvent, DorkOsEventType } from '@dorkos/shared/dorkos-events';
import type { CallerPrincipal, PersonPrincipal } from '../caller-principal.js';

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
 * Decide, per connected reader, whether one broadcast is that reader's to
 * receive. Asked as each frame is written, so it reads the rights the reader
 * has then.
 *
 * Omitted at the call site means everyone, which is what most events on this
 * bus mean. Room events and `read_cursor` must name one: both say what a person
 * did in a place only some readers may see, so omitting it sends nothing.
 *
 * Typed over every {@link CallerPrincipal}, though only a person reads this
 * stream, because several audiences are also the rule a route asks
 * (`operatorAudience` is the inbox's), and each still refuses what it cannot
 * place.
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
 *   preamble frame or a keepalive is not one: it goes out with `seq: null`, the
 *   time now and no id.
 */
export function encodeBroadcast(
  type: DorkOsEventType,
  payload: unknown,
  place?: FramePlace
): EncodedBroadcast {
  const envelope: DorkOsEvent = {
    seq: place?.seq ?? null,
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
 * One numbered broadcast: its encoded frame and who may read it. The same
 * record serves the live write and a replay, so both use one filter, asked with
 * the reader's rights at the moment each is written.
 */
export interface Delivery {
  /** The frame, encoded once for every reader. */
  readonly frame: EncodedBroadcast;
  /** Who gets it; absent means every reader. */
  readonly audience?: BroadcastAudience;
}

/**
 * The frame each reader is owed for one delivery, or none, decided when asked.
 *
 * The answer is kept per person for the life of the returned function, which
 * is one frame's write: several windows of the same person ask the audience
 * once. Nothing outlives the frame, so no answer can go stale and nothing
 * needs invalidating when a right changes; the next frame asks again.
 *
 * @param delivery - The broadcast.
 * @returns For a reader, its frame or `undefined`.
 */
export function readerAnswers(
  delivery: Delivery
): (reader: PersonPrincipal) => EncodedBroadcast | undefined {
  const { audience, frame } = delivery;
  if (!audience) return () => frame;
  const answers = new Map<string, boolean>();
  return (reader) => {
    const key = reader.kind === 'program' ? `program:${reader.userId}` : 'operator';
    let admitted = answers.get(key);
    if (admitted === undefined) {
      admitted = audience(reader);
      answers.set(key, admitted);
    }
    return admitted ? frame : undefined;
  };
}

/**
 * The bytes one delivery holds, on both wires.
 *
 * @param delivery - The broadcast.
 */
export function deliveryBytes(delivery: Delivery): number {
  return Buffer.byteLength(delivery.frame.sse) + Buffer.byteLength(delivery.frame.json);
}
