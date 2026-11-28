/**
 * The wire form of the global event stream, `GET /api/events`: every frame is
 * one whole `DorkOsEvent`, `{ seq, at, type, payload }` (ADR 261123-170833,
 * DOR-5474).
 *
 * - **Over SSE** the `data:` line is the envelope as JSON. The `event:` line
 *   repeats `type`, so a listener by type keeps working, and the `id:` line is
 *   the opaque resume cursor.
 * - **Over the WebSocket** at the same path, each message IS the envelope, with
 *   the resume cursor beside it as `id`, since a socket message has no `id:`
 *   line. Send it back whole as `?resume=`.
 *
 * A reader takes `seq` from the envelope and never parses the cursor. A frame
 * outside the numbering (the opening `connected` frame, the cold-connect
 * snapshot, the keepalive) has `seq: null` and no cursor. Such a frame is never
 * stored as a position and never used to order or drop a frame: a reader that
 * drops frames at or below the last `seq` it saw must let a `null` one through,
 * or it loses the snapshot after a reconnect.
 *
 * Kept free of zod and of the payload schemas so a small reader (the desktop
 * app's main process) can decode frames without loading them.
 *
 * @module shared/dorkos-event-frame
 */
import type { DorkOsEvent } from './dorkos-events.js';

/** One message on the global stream's WebSocket: the envelope, plus its resume cursor. */
export type DorkOsEventFrame = DorkOsEvent & {
  /**
   * The resume cursor, the same string SSE sends as `id:`. Opaque: echo it
   * back whole as `?resume=`. Absent on a frame whose `seq` is `null`.
   */
  readonly id?: string;
};

/**
 * Read an envelope from an already-parsed value (an SSE frame's `data:`, or a
 * socket message), or `null` when it is not one. Checks the four fields' kinds
 * only: the payload is the type's own business. A `type` this build does not
 * know is passed through on purpose (fail-soft): a newer server may add a type,
 * and a reader that has no handler for it simply drops it later, by name.
 *
 * @param value - The parsed JSON.
 */
export function readDorkOsEvent(value: unknown): DorkOsEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { seq, at, type } = candidate;
  const numbered = typeof seq === 'number' && Number.isInteger(seq) && seq > 0;
  if (seq !== null && !numbered) return null;
  if (typeof at !== 'string' || typeof type !== 'string') return null;
  return {
    seq: seq as number | null,
    at,
    type: type as DorkOsEvent['type'],
    payload: candidate.payload,
  };
}

/**
 * Parse one WebSocket message off the global stream, or `null` when it is not a
 * well-formed frame. Fails soft, like the other stream decoders: a bad frame is
 * dropped, never a torn-down stream.
 *
 * @param raw - The text of one socket message.
 */
export function decodeDorkOsEventFrame(raw: string): DorkOsEventFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const event = readDorkOsEvent(parsed);
  if (!event) return null;
  const { id } = parsed as Record<string, unknown>;
  return typeof id === 'string' ? { ...event, id } : event;
}
