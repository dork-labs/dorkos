/**
 * The broadcast names the unified `/api/events` stream forwards to generic
 * subscribers. `StreamManager` dispatches each of these to `subscribeEvent`.
 *
 * Derived from the one shared union (`@dorkos/shared/dorkos-events`), never
 * listed here: a name the server emits is a name the union holds, so it reaches
 * dispatch without a second list to keep in step. Three kinds are left out:
 *
 * - the chat-list events, which `StreamManager` validates and hands to the
 *   session binding instead (`SESSION_LIST_EVENT_TYPES`);
 * - `heartbeat`, the stream's keepalive, which nothing subscribes to;
 * - the `ext:<id>:<event>` family, which extensions read through their own API.
 *
 * It also decodes the stream's frames, which are whole `DorkOsEvent` envelopes
 * (DOR-5474), for the two readers of it ({@link decodeGlobalEventFrame}).
 *
 * @module shared/lib/transport/generic-events
 */
import { DORKOS_EVENT_NAMES, type DorkOsEventName } from '@dorkos/shared/dorkos-events';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { decodeDorkOsEventFrame, readDorkOsEvent } from '@dorkos/shared/dorkos-event-frame';
import type { StreamFrame } from '@dorkos/shared/stream-socket';

/** A union type not dispatched as a generic event. */
type NotGeneric = SessionListEvent['type'] | 'heartbeat';

/** Names {@link GENERIC_EVENTS} leaves out; see the module doc. */
const NOT_GENERIC: ReadonlySet<string> = new Set<NotGeneric>([
  'session_upserted',
  'session_removed',
  'session_status',
  'heartbeat',
]);

/** A broadcast name forwarded from the unified events stream to subscribers. */
export type GenericEventName = Exclude<DorkOsEventName, NotGeneric>;

/** Broadcast names forwarded from the unified events stream to subscribers. */
export const GENERIC_EVENTS: readonly GenericEventName[] = DORKOS_EVENT_NAMES.filter(
  (name): name is GenericEventName => !NOT_GENERIC.has(name)
);

/**
 * Decode one message off the global stream's socket for the stream readers,
 * which deal in `{ event, data, id }` frames. Every message there is a whole
 * `DorkOsEvent` with its resume cursor as `id` (DOR-5474), so `event` is the
 * envelope's `type` and `data` is the WHOLE envelope: a reader takes `seq` and
 * `payload` from it with {@link globalEventPayload}, and never parses the id.
 *
 * @param raw - The text of one socket message.
 * @returns The frame, or `null` for a message that is not an envelope.
 */
export function decodeGlobalEventFrame(raw: string): StreamFrame | null {
  const frame = decodeDorkOsEventFrame(raw);
  if (!frame) return null;
  const { id, ...envelope } = frame;
  return { event: envelope.type, data: envelope, ...(id !== undefined && { id }) };
}

/**
 * The payload of a global-stream frame's `data`, which is the whole envelope.
 *
 * @param data - A frame's `data`, from {@link decodeGlobalEventFrame}.
 * @returns The envelope's payload, or `undefined` when `data` is not an envelope.
 */
export function globalEventPayload(data: unknown): unknown {
  return readDorkOsEvent(data)?.payload;
}

/**
 * The global stream's frame handlers, by type: the chat-list types go to
 * `onListEvent` and the {@link GENERIC_EVENTS} to `onGenericEvent`, each with
 * the payload taken out of the envelope. Every other type is dropped.
 *
 * @param listTypes - The chat-list types (`SESSION_LIST_EVENT_TYPES`).
 * @param onListEvent - Called with a chat-list event's payload, unvalidated.
 * @param onGenericEvent - Called with a generic event's name and payload.
 */
export function globalStreamHandlers(
  listTypes: Iterable<string>,
  onListEvent: (payload: unknown) => void,
  onGenericEvent: (name: GenericEventName, payload: unknown) => void
): Record<string, (data: unknown) => void> {
  const handlers: Record<string, (data: unknown) => void> = {};
  // One handler for every chat-list type, so a reader can tell which names it serves.
  const onList = (data: unknown): void => onListEvent(globalEventPayload(data));
  for (const type of listTypes) handlers[type] = onList;
  for (const name of GENERIC_EVENTS) {
    handlers[name] = (data) => onGenericEvent(name, globalEventPayload(data));
  }
  return handlers;
}
